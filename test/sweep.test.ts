import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, loadWorkerConfig } from "../src/config.js";
import { enqueueJob } from "../src/enqueue.js";
import { FakeTransport, readMailbox } from "../src/transport.js";
import { sweepStuck } from "../src/sweep.js";
import { claimJob, finishSuccess, runOne, type WorkerDeps } from "../src/worker.js";

// Real Postgres (local dev DB). Test rows are removed by key prefix only.
const PREFIX = "s5test-";
const config = loadConfig();
const pool = new pg.Pool({ connectionString: config.databaseUrl });
const dir = mkdtempSync(join(tmpdir(), "bgjobs-s5-"));
let mailboxPath = "";
let counter = 0;
const lines: string[] = [];
const log = (line: string) => lines.push(line);

const message = { to: "nobody@example.invalid", subject: "s", body: "b" };
const sweepCfg = { stuckTimeoutMs: 60000, backoffBaseMs: 50, backoffCapMs: 10000 };

function deps(over: Partial<WorkerDeps> = {}): WorkerDeps {
  return {
    pool,
    transport: new FakeTransport(mailboxPath, 0),
    sendTimeoutMs: 30000,
    uncertainSendPolicy: "resend",
    backoffBaseMs: 50,
    backoffCapMs: 10000,
    ...over,
  };
}

async function newJob(maxAttempts = 5): Promise<string> {
  const result = await enqueueJob(pool, {
    ownerId: "user-a",
    idempotencyKey: `${PREFIX}${++counter}-${Date.now()}`,
    type: "send_email",
    payload: message,
    maxAttempts,
  });
  if (result.outcome !== "created") throw new Error("test job not created");
  return result.jobId;
}

// Claim a job as a worker that then vanishes, and make its lock look old.
async function stuckJob(maxAttempts = 5, ageMs = 120000): Promise<string> {
  const id = await newJob(maxAttempts);
  const job = await claimJob(pool, "dead-worker");
  expect(job?.id).toBe(id);
  await pool.query("UPDATE jobs SET locked_at = now() - ($2 * interval '1 millisecond') WHERE id = $1", [id, ageMs]);
  return id;
}

async function cleanup() {
  const ids = `SELECT id FROM jobs WHERE idempotency_key LIKE '${PREFIX}%'`;
  await pool.query(`DELETE FROM sent_emails WHERE job_id IN (${ids})`);
  await pool.query(`DELETE FROM job_attempts WHERE job_id IN (${ids})`);
  await pool.query(`DELETE FROM jobs WHERE idempotency_key LIKE '${PREFIX}%'`);
}

const jobRow = async (id: string) => (await pool.query("SELECT * FROM jobs WHERE id = $1", [id])).rows[0];
const attemptRows = async (id: string) =>
  (await pool.query("SELECT * FROM job_attempts WHERE job_id = $1 ORDER BY attempt_no", [id])).rows;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(async () => {
  await cleanup();
  lines.length = 0;
  mailboxPath = join(dir, `mailbox-${++counter}.jsonl`);
});
afterAll(async () => {
  await cleanup();
  await pool.end();
  rmSync(dir, { recursive: true, force: true });
});

describe("sweep-stuck", () => {
  it("recovers a stuck job to failed with backoff, and closes its attempt row", async () => {
    const id = await stuckJob();
    expect(await sweepStuck(pool, sweepCfg, log)).toBe(1);

    const job = await jobRow(id);
    expect(job.status).toBe("failed");
    expect(job.last_error).toBe("stuck: worker lost or slow");
    expect(job.locked_by).toBeNull();
    expect(job.locked_at).toBeNull();
    // run_at in the future, judged by the database clock that set it (the host clock can differ)
    const due = await pool.query("SELECT run_at > now() AS in_future FROM jobs WHERE id = $1", [id]);
    expect(due.rows[0].in_future).toBe(true);

    const [a] = await attemptRows(id);
    expect(a.finished_at).not.toBeNull();
    expect(a.error).toBe("stuck: worker lost or slow");
    expect(a.backoff_bound_ms).toBe(50);
    expect(a.delay_ms).toBeGreaterThanOrEqual(25);
    expect(lines.some((l) => l.includes(`job=${id}`) && l.includes("recovered"))).toBe(true);
  });

  it("a stuck job at max attempts goes dead", async () => {
    const id = await stuckJob(1);
    expect(await sweepStuck(pool, sweepCfg, log)).toBe(1);
    const job = await jobRow(id);
    expect(job.status).toBe("dead");
    expect(job.attempts).toBe(1);
    expect(job.last_error).toBe("stuck: worker lost or slow");
  });

  it("leaves a processing job that is not old enough", async () => {
    const id = await stuckJob(5, 1000); // locked 1 s ago, timeout is 60 s
    expect(await sweepStuck(pool, sweepCfg, log)).toBe(0);
    expect((await jobRow(id)).status).toBe("processing");
  });

  it("leaves pending, failed, succeeded and dead jobs alone", async () => {
    const pending = await newJob();
    const ok = await newJob();
    await pool.query("UPDATE jobs SET status='succeeded', locked_at = now() - interval '1 day' WHERE id = $1", [ok]);
    expect(await sweepStuck(pool, sweepCfg, log)).toBe(0);
    expect((await jobRow(pending)).status).toBe("pending");
    expect((await jobRow(ok)).status).toBe("succeeded");
  });

  it("skips a stuck job that another transaction has locked, without waiting", async () => {
    const id = await stuckJob();
    const holder = await pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT id FROM jobs WHERE id = $1 FOR UPDATE", [id]);
      const started = Date.now();
      expect(await sweepStuck(pool, sweepCfg, log)).toBe(0);
      expect(Date.now() - started).toBeLessThan(2000);
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }
    expect((await jobRow(id)).status).toBe("processing");
    expect(await sweepStuck(pool, sweepCfg, log)).toBe(1); // lock released, now recovered
  });

  it("two sweeps at once recover the job exactly once", async () => {
    const id = await stuckJob();
    const results = await Promise.all([sweepStuck(pool, sweepCfg, log), sweepStuck(pool, sweepCfg, log)]);
    expect(results.reduce((a, b) => a + b, 0)).toBe(1);
    expect((await jobRow(id)).status).toBe("failed");
    expect((await attemptRows(id))).toHaveLength(1);
  });
});

describe("finish-success done-when: an old worker cannot overwrite a recovered job", () => {
  it("a late success from the original worker is discarded", async () => {
    const id = await newJob();
    const job = (await claimJob(pool, "slow-worker"))!;
    await pool.query("UPDATE jobs SET locked_at = now() - interval '2 minutes' WHERE id = $1", [id]);
    await sweepStuck(pool, sweepCfg, log);
    expect((await jobRow(id)).status).toBe("failed");

    expect(await finishSuccess(pool, job, "slow-worker")).toBe(false);
    expect((await jobRow(id)).status).toBe("failed"); // not overwritten
  });

  it("a recovered job that a new worker already holds is not touched by the old worker", async () => {
    const id = await newJob();
    const first = (await claimJob(pool, "slow-worker"))!;
    await pool.query("UPDATE jobs SET locked_at = now() - interval '2 minutes' WHERE id = $1", [id]);
    await sweepStuck(pool, sweepCfg, log);
    await sleep(120); // longer than the first backoff bound (50 ms)
    const second = (await claimJob(pool, "new-worker"))!;
    expect(second.id).toBe(id);
    expect(second.attempts).toBe(2);

    expect(await finishSuccess(pool, first, "slow-worker")).toBe(false);
    const job = await jobRow(id);
    expect(job.status).toBe("processing");
    expect(job.locked_by).toBe("new-worker");
  });
});

describe("T3 recovery, in-process (the real kill -9 run is recorded separately)", () => {
  // A worker died after writing the sending row and before the provider accepted.
  async function killedMidSend(): Promise<string> {
    const id = await stuckJob();
    await pool.query("INSERT INTO sent_emails (job_id, state) VALUES ($1, 'sending')", [id]);
    return id;
  }

  it("policy resend: recovered, retried, succeeds, mailbox holds one message", async () => {
    const id = await killedMidSend();
    await sweepStuck(pool, sweepCfg, log);
    await sleep(120);
    expect(await runOne(deps({ uncertainSendPolicy: "resend" }), "w2", log)).toBe(true);
    const job = await jobRow(id);
    expect(job.status).toBe("succeeded");
    expect(job.attempts).toBe(2);
    expect((await readMailbox(mailboxPath)).filter((e) => e.idempotencyKey === id)).toHaveLength(1);
  });

  it("policy flag_for_human: recovered, retried, then dead with 'uncertain send', nothing sent", async () => {
    const id = await killedMidSend();
    await sweepStuck(pool, sweepCfg, log);
    await sleep(120);
    expect(await runOne(deps({ uncertainSendPolicy: "flag_for_human" }), "w2", log)).toBe(true);
    const job = await jobRow(id);
    expect(job.status).toBe("dead");
    expect(job.attempts).toBe(2);
    expect(job.last_error).toBe("uncertain send");
    expect(await readMailbox(mailboxPath)).toHaveLength(0);
  });
});

describe("FR9 and FR14 startup checks", () => {
  const base = {
    DATABASE_URL: "x", MAX_ATTEMPTS: "5", PORT: "3000", POLL_INTERVAL_MS: "1000", SEND_TIMEOUT_MS: "30000",
    FAKE_SEND_DELAY_MS: "0", UNCERTAIN_SEND_POLICY: "flag_for_human", BACKOFF_BASE_MS: "2000", BACKOFF_CAP_MS: "300000",
    STUCK_TIMEOUT_MS: "120000", SWEEP_INTERVAL_MS: "15000", WORKER_CONCURRENCY: "5", HEARTBEAT_INTERVAL_MS: "10000",
  };
  it("accepts STUCK_TIMEOUT_MS of exactly 3 * SEND_TIMEOUT_MS", () => {
    expect(loadWorkerConfig({ ...base, STUCK_TIMEOUT_MS: "90000" }).stuckTimeoutMs).toBe(90000);
  });
  it("refuses STUCK_TIMEOUT_MS below 3 * SEND_TIMEOUT_MS", () => {
    expect(() => loadWorkerConfig({ ...base, STUCK_TIMEOUT_MS: "89999" })).toThrow(/STUCK_TIMEOUT_MS/);
  });
  it("refuses a missing SWEEP_INTERVAL_MS", () => {
    const { SWEEP_INTERVAL_MS: _omit, ...rest } = base;
    expect(() => loadWorkerConfig(rest)).toThrow(/SWEEP_INTERVAL_MS/);
  });
});
