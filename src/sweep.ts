import type { Pool } from "pg";
import { failOrRetry, type BackoffConfig } from "./failOrRetry.js";

export interface SweepConfig extends BackoffConfig {
  stuckTimeoutMs: number;
}

// SKILLS: sweep-stuck. Recovers jobs a worker took and never finished (crash, kill, hang).
// Returns how many jobs it recovered. Safe to run from several workers: SKIP LOCKED.
export async function sweepStuck(pool: Pool, config: SweepConfig, log: (line: string) => void): Promise<number> {
  const client = await pool.connect();
  let recovered = 0;
  try {
    await client.query("BEGIN");
    const stuck = await client.query<{ id: string; attempts: number; max_attempts: number }>(
      `SELECT id, attempts, max_attempts FROM jobs
       WHERE status = 'processing' AND locked_at < now() - ($1 * interval '1 millisecond')
       FOR UPDATE SKIP LOCKED`,
      [config.stuckTimeoutMs],
    );
    for (const job of stuck.rows) {
      const result = await failOrRetry(client, config, {
        jobId: job.id,
        attemptNo: job.attempts,
        maxAttempts: job.max_attempts,
        kind: "retryable",
        error: "stuck: worker lost or slow",
        guard: { by: "sweep", stuckTimeoutMs: config.stuckTimeoutMs },
      });
      if (result.outcome === "lost") continue;
      recovered++;
      log(`sweep job=${job.id} attempt=${job.attempts} recovered status=${result.outcome}`);
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  return recovered;
}
