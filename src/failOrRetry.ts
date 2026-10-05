import type { Pool } from "pg";
import { backoff } from "./backoff.js";
import { runInTransaction } from "./transaction.js";

// Pool or a transaction client. The sweep runs this inside its transaction so its row locks hold.
export type Queryable = Pick<Pool, "query">;

// Who is allowed to change the job. Both guards require status = 'processing'.
export type Guard =
  | { by: "worker"; workerId: string } // the worker that still holds the job
  | { by: "sweep"; stuckTimeoutMs: number }; // the job has sat locked for too long

export interface FailInput {
  jobId: string;
  attemptNo: number; // jobs.attempts at claim time, so also the job_attempts row to close
  maxAttempts: number;
  kind: "retryable" | "permanent";
  error: string; // short and free of addresses or payload text
  guard: Guard;
}

export interface BackoffConfig {
  backoffBaseMs: number;
  backoffCapMs: number;
}

export type FailResult =
  | { outcome: "failed"; delayMs: number; boundMs: number }
  | { outcome: "dead" }
  | { outcome: "lost" };

const MAX_ERROR_LENGTH = 200;

function guardSql(guard: Guard): { sql: string; param: string | number } {
  return guard.by === "worker"
    ? { sql: "locked_by = $2", param: guard.workerId }
    : { sql: "locked_at < now() - ($2 * interval '1 millisecond')", param: guard.stuckTimeoutMs };
}

// SKILLS: fail-or-retry. The ONE place that decides failed versus dead (RULES 21).
// The worker and the sweep both call it.
export async function failOrRetry(db: Queryable, config: BackoffConfig, input: FailInput): Promise<FailResult> {
  const error = input.error.slice(0, MAX_ERROR_LENGTH);
  const exhausted = input.attemptNo >= input.maxAttempts;
  const guard = guardSql(input.guard);

  if (input.kind === "permanent" || exhausted) {
    const updated = await db.query(
      `UPDATE jobs
       SET status = 'dead', finished_at = now(), last_error = $3, locked_by = NULL, locked_at = NULL
       WHERE id = $1 AND status = 'processing' AND ${guard.sql}
       RETURNING id`,
      [input.jobId, guard.param, error],
    );
    if (updated.rowCount === 0) return { outcome: "lost" };
    await closeAttempt(db, input, error, null, null);
    return { outcome: "dead" };
  }

  const { bound, delay } = backoff(input.attemptNo, config.backoffBaseMs, config.backoffCapMs);
  const updated = await db.query(
    `UPDATE jobs
     SET status = 'failed', last_error = $3, run_at = now() + ($4 * interval '1 millisecond'),
         locked_by = NULL, locked_at = NULL
     WHERE id = $1 AND status = 'processing' AND ${guard.sql}
     RETURNING id`,
    [input.jobId, guard.param, error, delay],
  );
  if (updated.rowCount === 0) return { outcome: "lost" };
  await closeAttempt(db, input, error, bound, delay);
  return { outcome: "failed", delayMs: delay, boundMs: bound };
}

// The worker's version (S5). The job update and the attempt update commit TOGETHER or not at all, so a
// crash or an error between them cannot leave a half-finished job. If the ownership guard changes zero
// rows (the job was lost), the transaction is rolled back and the loser writes nothing.
// The sweep does not use this: it already runs failOrRetry inside its own transaction.
export function failOrRetryInTransaction(pool: Pool, config: BackoffConfig, input: FailInput): Promise<FailResult> {
  return runInTransaction(pool, async (db) => {
    const result = await failOrRetry(db, config, input);
    return { commit: result.outcome !== "lost", value: result };
  });
}

async function closeAttempt(
  db: Queryable,
  input: FailInput,
  error: string,
  boundMs: number | null,
  delayMs: number | null,
) {
  await db.query(
    `UPDATE job_attempts
     SET finished_at = now(), error = $3, backoff_bound_ms = $4, delay_ms = $5
     WHERE job_id = $1 AND attempt_no = $2`,
    [input.jobId, input.attemptNo, error, boundMs, delayMs],
  );
}
