import type { Pool } from "pg";
import { SendError } from "./errors.js";
import { failOrRetryInTransaction, type BackoffConfig } from "./failOrRetry.js";
import { startHeartbeat, stillOwned, type Heartbeat } from "./ownership.js";
import { sendEmailSafely, type SendEmailDeps } from "./sendEmail.js";
import { runInTransaction } from "./transaction.js";
import type { MailTransport } from "./transport.js";

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

// SKILLS: finish-success. ONE transaction (S5): the job update and the attempt update commit together
// or not at all. Guarded: zero rows means this worker lost the job. Then the transaction is rolled back
// and nothing is written, neither to the job row nor to the attempt row. Returns false in that case.
export async function finishSuccess(pool: Pool, job: ClaimedJob, workerId: string): Promise<boolean> {
  return runInTransaction(pool, async (db) => {
    const updated = await db.query(
      `UPDATE jobs
       SET status = 'succeeded', finished_at = now(), locked_by = NULL, locked_at = NULL
       WHERE id = $1 AND status = 'processing' AND locked_by = $2
       RETURNING id`,
      [job.id, workerId],
    );
    if (updated.rowCount === 0) return { commit: false, value: false };
    await db.query(
      `UPDATE job_attempts SET finished_at = now(), error = NULL WHERE job_id = $1 AND attempt_no = $2`,
      [job.id, job.attempts],
    );
    return { commit: true, value: true };
  });
}

// Rule 0.15: a worker that lost its job abandons ONLY that job, writes nothing for it, and says so once:
// the job id, who owns it now and what state it is in. Owner and status are read once, after the
// rollback. If that read fails the warning is still logged and the worker carries on.
async function warnLost(pool: Pool, jobId: string, workerId: string, log: (line: string) => void): Promise<void> {
  let owner = "unknown";
  let status = "unknown";
  try {
    const now = await pool.query<{ status: string; locked_by: string | null }>(
      `SELECT status, locked_by FROM jobs WHERE id = $1`,
      [jobId],
    );
    if (now.rows[0]) {
      status = now.rows[0].status;
      owner = now.rows[0].locked_by ?? "none";
    }
  } catch {
    // keep "unknown"
  }
  log(`WARN worker=${workerId} job=${jobId} lost the job: owner=${owner} status=${status}; its result was discarded`);
}

function toMessage(payload: unknown) {
  const p = payload as Record<string, unknown> | null;
  if (!p || typeof p.to !== "string" || typeof p.subject !== "string" || typeof p.body !== "string") {
    throw new SendError("invalid payload", "permanent");
  }
  return { to: p.to, subject: p.subject, body: p.body };
}

// heartbeatIntervalMs: how often a running job refreshes its lock (S7). Optional so that code and tests
// that do not need a heartbeat leave it out. The real worker always sets it (workerMain.ts).
export type WorkerDeps = SendEmailDeps & BackoffConfig & { heartbeatIntervalMs?: number };

// Claims at most one job and runs it. Returns false when nothing was ready.
export async function runOne(deps: WorkerDeps, workerId: string, log: (line: string) => void): Promise<boolean> {
  const job = await claimJob(deps.pool, workerId);
  if (!job) return false;
  await processJob(deps, job, workerId, log);
  return true;
}

// Runs one claimed job to its end: succeeded, failed or dead. Split from the claim so the
// worker loop can hold several jobs at once (SKILLS: concurrency-cap).
export async function processJob(
  deps: WorkerDeps,
  job: ClaimedJob,
  workerId: string,
  log: (line: string) => void,
): Promise<void> {
  log(`worker=${workerId} job=${job.id} type=${job.type} attempt=${job.attempts} status=processing`);

  // Rule 0.15: a lost job is reported ONCE, whichever path notices the loss first (the re-check, a
  // heartbeat, or a guarded update). `lost` also tells every later step to write nothing for the job.
  let lost = false;
  let warned = false;
  let heartbeatWarned = false;
  const reportLost = async () => {
    lost = true;
    if (warned) return;
    warned = true;
    await warnLost(deps.pool, job.id, workerId, log);
  };

  // S7: once SMTP has a message nothing can recall it. What a heartbeat that finds the job lost CAN still
  // stop is a send that has not started yet: this wrapper refuses to call the mail server once the job
  // is known to be lost. "Refused" tells sendEmailSafely the mail was NOT sent, so it removes the
  // sending row instead of leaving a false "uncertain" one.
  const guardedTransport: MailTransport = {
    send: async (message, options) =>
      lost
        ? { outcome: "refused", status: 421, retryable: true, summary: "job lost before the send" }
        : deps.transport.send(message, options),
  };

  let heartbeat = null as Heartbeat | null;
  try {
    try {
      if (job.type !== "send_email") throw new SendError("unknown job type", "permanent");
      const message = toMessage(job.payload);
      // S6: re-check ownership FIRST, then (inside sendEmailSafely) the sending row and the SMTP call, so
      // a lost job never creates a sending row. Zero rows: send nothing, warn once, drop this job and
      // carry on. The loser writes nothing for it.
      if (!(await stillOwned(deps.pool, job.id, workerId))) {
        await reportLost();
        return;
      }
      // S7: from here until the job ends, repeat the same statement every heartbeatIntervalMs. A beat
      // that changes zero rows means the job was lost: the heartbeat stops itself and reports it.
      if (deps.heartbeatIntervalMs !== undefined) {
        heartbeat = startHeartbeat(
          deps.pool,
          job.id,
          workerId,
          deps.heartbeatIntervalMs,
          () => {
            void reportLost();
          },
          (errorClass) => {
            // A beat that threw proves nothing about ownership: warn once per job, keep going.
            if (heartbeatWarned) return;
            heartbeatWarned = true;
            log(`WARN worker=${workerId} job=${job.id} heartbeat failed: ${errorClass}; will keep trying`);
          },
          (failedBeats) => {
            log(`worker=${workerId} job=${job.id} heartbeat recovered after ${failedBeats} failed beats`);
          },
        );
      }
      await sendEmailSafely({ ...deps, transport: guardedTransport }, job.id, message);
    } catch (err) {
      await heartbeat?.stop();
      if (lost) {
        await reportLost(); // already reported, so this does not log again
        return; // the job is someone else's now: write nothing for it
      }
      // Our own errors carry a safe message. Anything else may hold personal data, so it is not stored.
      const known = err instanceof SendError;
      const result = await failOrRetryInTransaction(deps.pool, deps, {
        jobId: job.id,
        attemptNo: job.attempts,
        maxAttempts: job.max_attempts,
        kind: known ? err.kind : "retryable",
        error: known ? err.message : "unexpected error",
        guard: { by: "worker", workerId },
      });
      if (result.outcome === "lost") {
        await reportLost();
      } else if (result.outcome === "failed") {
        log(`worker=${workerId} job=${job.id} attempt=${job.attempts} status=failed bound_ms=${result.boundMs} delay_ms=${result.delayMs}`);
      } else {
        log(`worker=${workerId} job=${job.id} attempt=${job.attempts} status=dead`);
      }
      return;
    }

    // Stop the heartbeat BEFORE finishing, so a late beat cannot race the finish and call it a loss.
    await heartbeat?.stop();
    if (lost) {
      await reportLost(); // lost while sending: the mail is recorded as sent, the job row is not ours to write
      return;
    }
    if (await finishSuccess(deps.pool, job, workerId)) {
      log(`worker=${workerId} job=${job.id} attempt=${job.attempts} status=succeeded`);
    } else {
      await reportLost();
    }
  } finally {
    await heartbeat?.stop(); // every exit path: success, failure, dropped job, a crash in a handler
  }
}
