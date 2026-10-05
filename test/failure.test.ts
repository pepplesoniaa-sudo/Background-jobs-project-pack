import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { backoff } from "../src/backoff.js";
import { loadConfig, loadWorkerConfig } from "../src/config.js";
import { enqueueJob } from "../src/enqueue.js";
import { failOrRetry } from "../src/failOrRetry.js";
import { FakeTransport, readMailbox, type MailTransport, type TransportOutcome } from "../src/transport.js";
import { claimJob, runOne, type WorkerDeps } from "../src/worker.js";

// Real Postgres (local dev DB). Test rows are removed by key prefix only.
const PREFIX = "s4test-";
const config = loadConfig();
const pool = new pg.Pool({ connectionString: config.databaseUrl });
const dir = mkdtempSync(join(tmpdir(), "bgjobs-s4-"));
let mailboxPath = "";
let counter = 0;
const lines: string[] = [];
const log = (line: string) => lines.push(line);

const message = { to: "nobody@example.invalid", subject: "s", body: "b" };

function deps(over: Partial<WorkerDeps> = {}): WorkerDeps {
  return {
    pool,
    transport: new FakeTransport(mailboxPath, 0, true), // FORCE_FAIL on by default in this file
    sendTimeoutMs: 30000,
    uncertainSendPolicy: "resend",
    backoffBaseMs: 50,
    backoffCapMs: 10000,
    ...over,
  };
}

async function newJob(maxAttempts = 5, payload: unknown = message): Promise<string> {
  const result = await enqueueJob(pool, {
    ownerId: "user-a",
    idempotencyKey: `${PREFIX}${++counter}-${Date.now()}`,
    type: "send_email",
    payload,
    maxAttempts,
  });
  if (result.outcome !== "created") throw new Error("test job not created");
  return result.jobId;
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
const stub = (outcome: TransportOutcome): MailTransport => ({ send: async () => outcome });
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

describe("backoff-delay unit test", () => {
  it("bounds double 2000..32000, every delay is within [bound/2, bound], samples vary", () => {
    const bounds = [1, 2, 3, 4, 5].map((n) => backoff(n, 2000, 300000).bound);
    expect(bounds).toEqual([2000, 4000, 8000, 16000, 32000]);
    const samples = Array.from({ length: 1000 }, () => backoff(3, 2000, 300000));
    for (const s of samples) {
      expect(s.delay).toBeGreaterThanOrEqual(s.bound / 2);
      expect(s.delay).toBeLessThanOrEqual(s.bound);
    }
    expect(new Set(samples.map((s) => s.delay)).size).toBeGreaterThan(1);
  });

  it("the cap holds", () => {
    expect(backoff(20, 2000, 300000).bound).toBe(300000);
  });
});

describe("T2 total failure (FORCE_FAIL, policy resend)", () => {
  it("failed between tries, dead at max: 5 attempts, 4 delays, bounds double", async () => {
    const id = await newJob(5);
    const seen: string[] = [];

    // Drive the worker like the real loop: claim whatever is ready, otherwise wait.
    const deadline = Date.now() + 15000;
    while ((await jobRow(id)).status !== "dead" && Date.now() < deadline) {
      if (await runOne(deps(), "w1", log)) {
        const row = await jobRow(id);
        seen.push(row.status);
        if (row.status === "failed") {
          // run_at in the future, judged by the database clock that set it (the host clock can differ)
          const due = await pool.query("SELECT run_at > now() AS in_future FROM jobs WHERE id = $1", [id]);
          expect(due.rows[0].in_future).toBe(true);
          expect(row.locked_by).toBeNull();
        }
      } else {
        await sleep(10);
      }
    }

    expect(seen).toEqual(["failed", "failed", "failed", "failed", "dead"]);
    const job = await jobRow(id);
    expect(job.status).toBe("dead");
    expect(job.attempts).toBe(5);
    expect(job.last_error).toBe("provider outcome unknown: provider 503");
    expect(job.finished_at).not.toBeNull();

    const attempts = await attemptRows(id);
    expect(attempts.map((a) => a.attempt_no)).toEqual([1, 2, 3, 4, 5]);
    expect(attempts.slice(0, 4).map((a) => a.backoff_bound_ms)).toEqual([50, 100, 200, 400]);
    for (const a of attempts.slice(0, 4)) {
      expect(a.delay_ms).toBeGreaterThanOrEqual(a.backoff_bound_ms / 2);
      expect(a.delay_ms).toBeLessThanOrEqual(a.backoff_bound_ms);
      expect(a.error).not.toBeNull();
    }
    expect(attempts[4].backoff_bound_ms).toBeNull(); // the fifth failure goes straight to dead
    expect(attempts[4].delay_ms).toBeNull();
    expect(attempts.every((a) => a.finished_at !== null)).toBe(true);

    // Each retry waited at least its delay: run_at was set to now() + delay when the job failed.
    for (let i = 1; i < 5; i++) {
      const gap = new Date(attempts[i].started_at).getTime() - new Date(attempts[i - 1].finished_at).getTime();
      expect(gap).toBeGreaterThanOrEqual(attempts[i - 1].delay_ms - 5);
    }
    expect(await readMailbox(mailboxPath)).toHaveLength(0);
  }, 20000);

  it("under flag_for_human the same run dies on attempt 2 with 'uncertain send' (PRD risk)", async () => {
    const id = await newJob(5);
    const d = deps({ uncertainSendPolicy: "flag_for_human" });
    await runOne(d, "w1", log);
    expect((await jobRow(id)).status).toBe("failed");
    await sleep(120); // longer than the first bound (50 ms)
    await runOne(d, "w1", log);
    const job = await jobRow(id);
    expect(job.status).toBe("dead");
    expect(job.attempts).toBe(2);
    expect(job.last_error).toBe("uncertain send");
  });
});

describe("fail-or-retry decisions", () => {
  it("a permanent error (4xx) goes straight to dead on attempt 1", async () => {
    const id = await newJob(5);
    await runOne(deps({ transport: stub({ outcome: "refused", status: 422 }) }), "w1", log);
    const job = await jobRow(id);
    expect(job.status).toBe("dead");
    expect(job.attempts).toBe(1);
    expect(job.last_error).toBe("provider refused with 422");
    const [a] = await attemptRows(id);
    expect(a.error).toBe("provider refused with 422");
    expect(a.delay_ms).toBeNull();
  });

  it("a retryable error with attempts below max goes to failed, run_at in the future", async () => {
    const id = await newJob(3);
    await runOne(deps({ transport: stub({ outcome: "refused", status: 429 }), backoffBaseMs: 60000, backoffCapMs: 60000 }), "w1", log);
    const job = await jobRow(id);
    expect(job.status).toBe("failed");
    expect(new Date(job.run_at).getTime()).toBeGreaterThan(Date.now() + 25000);
    expect(await claimJob(pool, "w2")).toBeNull(); // not claimable until run_at
  });

  it("a retryable error at max attempts goes to dead", async () => {
    const id = await newJob(1);
    await runOne(deps({ transport: stub({ outcome: "refused", status: 429 }) }), "w1", log);
    const job = await jobRow(id);
    expect(job.status).toBe("dead");
    expect(job.attempts).toBe(1);
  });

  it("an unexpected error is retried and its message is not stored", async () => {
    const id = await newJob(5);
    const boom: MailTransport = { send: async () => { throw new Error("connection to nobody@example.invalid reset"); } };
    await runOne(deps({ transport: boom }), "w1", log);
    const job = await jobRow(id);
    expect(job.status).toBe("failed");
    expect(job.last_error).toBe("unexpected error");
  });

  it("an invalid payload is permanent", async () => {
    const id = await newJob(5, { to: 42 });
    await runOne(deps(), "w1", log);
    const job = await jobRow(id);
    expect(job.status).toBe("dead");
    expect(job.last_error).toBe("invalid payload");
  });

  it("a worker that lost the job cannot fail it (guard), and the attempt row is untouched", async () => {
    const id = await newJob(5);
    const job = (await claimJob(pool, "w1"))!;
    const result = await failOrRetry(pool, deps(), {
      jobId: id, attemptNo: job.attempts, maxAttempts: job.max_attempts, kind: "permanent", error: "x", guard: { by: "worker", workerId: "w2" },
    });
    expect(result.outcome).toBe("lost");
    expect((await jobRow(id)).status).toBe("processing");
    expect((await attemptRows(id))[0].finished_at).toBeNull();
  });

  it("logs and last_error never contain the address", async () => {
    const id = await newJob(5);
    await runOne(deps(), "w1", log);
    expect(lines.join("\n")).not.toContain("nobody@example.invalid");
    expect((await jobRow(id)).last_error).not.toContain("nobody@example.invalid");
  });
});

describe("config", () => {
  const base = {
    DATABASE_URL: "x", MAX_ATTEMPTS: "5", PORT: "3000", POLL_INTERVAL_MS: "1000", SEND_TIMEOUT_MS: "30000",
    FAKE_SEND_DELAY_MS: "0", UNCERTAIN_SEND_POLICY: "resend", BACKOFF_BASE_MS: "2000", BACKOFF_CAP_MS: "300000",
    STUCK_TIMEOUT_MS: "120000", SWEEP_INTERVAL_MS: "15000", WORKER_CONCURRENCY: "5", HEARTBEAT_INTERVAL_MS: "10000",
  };
  it("FORCE_FAIL defaults to false and reads true", () => {
    expect(loadWorkerConfig(base).forceFail).toBe(false);
    expect(loadWorkerConfig({ ...base, FORCE_FAIL: "true" }).forceFail).toBe(true);
  });
  it("refuses a cap below the base", () => {
    expect(() => loadWorkerConfig({ ...base, BACKOFF_CAP_MS: "1000" })).toThrow(/BACKOFF_CAP_MS/);
  });
});
