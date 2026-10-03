import type { Pool } from "pg";
import { SendError } from "./errors.js";
import { failOrRetry, type BackoffConfig } from "./failOrRetry.js";
import { sendEmailSafely, type SendEmailDeps } from "./sendEmail.js";

export interface ClaimedJob {
  id: string;
  type: string;
  payload: unknown;
  attempts: number;
  max_attempts: number;
}

// SKILLS: claim-job. ONE statement, database clock, SKIP LOCKED. MATERIALIZED needs Postgres 12+.
export async function claimJob(pool: Pool, workerId: string): Promise<ClaimedJob | null> {
  const result = await pool.query<ClaimedJob>(
    `WITH next AS MATERIALIZED (
       SELECT id FROM jobs
       WHERE status IN ('pending','failed') AND run_at <= now()
       ORDER BY run_at
       LIMIT 1
       FOR UPDATE SKIP LOCKED
     ),
     claimed AS (
       UPDATE jobs
       SET status = 'processing', attempts = attempts + 1, locked_by = $1,
           locked_at = now(), started_at = now(), finished_at = NULL
       WHERE id IN (SELECT id FROM next)
       RETURNING id, type, payload, attempts, max_attempts
     ),
     logged AS (
       INSERT INTO job_attempts (job_id, attempt_no, worker_id, started_at)
       SELECT id, attempts, $1, now() FROM claimed
     )
     SELECT * FROM claimed`,
    [workerId],
  );
  return result.rows[0] ?? null;
}

// SKILLS: finish-success. Guarded: zero rows means this worker lost the job.
export async function finishSuccess(pool: Pool, job: ClaimedJob, workerId: string): Promise<boolean> {
  const updated = await pool.query(
    `UPDATE jobs
     SET status = 'succeeded', finished_at = now(), locked_by = NULL, locked_at = NULL
     WHERE id = $1 AND status = 'processing' AND locked_by = $2
     RETURNING id`,
    [job.id, workerId],
  );
  if (updated.rowCount === 0) return false;
  await pool.query(
    `UPDATE job_attempts SET finished_at = now(), error = NULL WHERE job_id = $1 AND attempt_no = $2`,
    [job.id, job.attempts],
  );
  return true;
}

function toMessage(payload: unknown) {
  const p = payload as Record<string, unknown> | null;
  if (!p || typeof p.to !== "string" || typeof p.subject !== "string" || typeof p.body !== "string") {
    throw new SendError("invalid payload", "permanent");
  }
  return { to: p.to, subject: p.subject, body: p.body };
}

export type WorkerDeps = SendEmailDeps & BackoffConfig;

// Claims at most one job and runs it. Returns false when nothing was ready.
export async function runOne(deps: WorkerDeps, workerId: string, log: (line: string) => void): Promise<boolean> {
  const job = await claimJob(deps.pool, workerId);
  if (!job) return false;
  log(`worker=${workerId} job=${job.id} type=${job.type} attempt=${job.attempts} status=processing`);

  try {
    if (job.type !== "send_email") throw new SendError("unknown job type", "permanent");
    await sendEmailSafely(deps, job.id, toMessage(job.payload));
  } catch (err) {
    // Our own errors carry a safe message. Anything else may hold personal data, so it is not stored.
    const known = err instanceof SendError;
    const result = await failOrRetry(deps.pool, deps, {
      jobId: job.id,
      attemptNo: job.attempts,
      maxAttempts: job.max_attempts,
      kind: known ? err.kind : "retryable",
      error: known ? err.message : "unexpected error",
      workerId,
    });
    if (result.outcome === "lost") {
      log(`WARN worker=${workerId} job=${job.id} lost the job, failure result discarded`);
    } else if (result.outcome === "failed") {
      log(`worker=${workerId} job=${job.id} attempt=${job.attempts} status=failed bound_ms=${result.boundMs} delay_ms=${result.delayMs}`);
    } else {
      log(`worker=${workerId} job=${job.id} attempt=${job.attempts} status=dead`);
    }
    return true;
  }

  if (await finishSuccess(deps.pool, job, workerId)) {
    log(`worker=${workerId} job=${job.id} attempt=${job.attempts} status=succeeded`);
  } else {
    log(`WARN worker=${workerId} job=${job.id} lost the job, result discarded`);
  }
  return true;
}
