import type { Pool } from "pg";
import { backoff } from "./backoff.js";

export interface FailInput {
  jobId: string;
  attemptNo: number; // jobs.attempts at claim time, so also the job_attempts row to close
  maxAttempts: number;
  kind: "retryable" | "permanent";
  error: string; // short and free of addresses or payload text
  workerId: string;
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

// SKILLS: fail-or-retry. The ONE place that decides failed versus dead (RULES 21).
// S5 will call this from the sweep with a different guard. Worker path guard only for now.
export async function failOrRetry(pool: Pool, config: BackoffConfig, input: FailInput): Promise<FailResult> {
  const error = input.error.slice(0, MAX_ERROR_LENGTH);
  const exhausted = input.attemptNo >= input.maxAttempts;

  if (input.kind === "permanent" || exhausted) {
    const updated = await pool.query(
      `UPDATE jobs
       SET status = 'dead', finished_at = now(), last_error = $3, locked_by = NULL, locked_at = NULL
       WHERE id = $1 AND status = 'processing' AND locked_by = $2
       RETURNING id`,
      [input.jobId, input.workerId, error],
    );
    if (updated.rowCount === 0) return { outcome: "lost" };
    await closeAttempt(pool, input, error, null, null);
    return { outcome: "dead" };
  }

  const { bound, delay } = backoff(input.attemptNo, config.backoffBaseMs, config.backoffCapMs);
  const updated = await pool.query(
    `UPDATE jobs
     SET status = 'failed', last_error = $3, run_at = now() + ($4 * interval '1 millisecond'),
         locked_by = NULL, locked_at = NULL
     WHERE id = $1 AND status = 'processing' AND locked_by = $2
     RETURNING id`,
    [input.jobId, input.workerId, error, delay],
  );
  if (updated.rowCount === 0) return { outcome: "lost" };
  await closeAttempt(pool, input, error, bound, delay);
  return { outcome: "failed", delayMs: delay, boundMs: bound };
}

async function closeAttempt(
  pool: Pool,
  input: FailInput,
  error: string,
  boundMs: number | null,
  delayMs: number | null,
) {
  await pool.query(
    `UPDATE job_attempts
     SET finished_at = now(), error = $3, backoff_bound_ms = $4, delay_ms = $5
     WHERE job_id = $1 AND attempt_no = $2`,
    [input.jobId, input.attemptNo, error, boundMs, delayMs],
  );
}
