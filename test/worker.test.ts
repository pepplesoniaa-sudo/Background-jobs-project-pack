import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, loadWorkerConfig } from "../src/config.js";
import { enqueueJob } from "../src/enqueue.js";
import { SendError } from "../src/errors.js";
import { sendEmailSafely } from "../src/sendEmail.js";
import { FakeTransport, readMailbox, type MailTransport, type TransportOutcome } from "../src/transport.js";
import { claimJob, finishSuccess, runOne, type WorkerDeps } from "../src/worker.js";

// Real Postgres (local dev DB). Test rows are removed by key prefix only.
const PREFIX = "s3test-";
const config = loadConfig();
const pool = new pg.Pool({ connectionString: config.databaseUrl });
const dir = mkdtempSync(join(tmpdir(), "bgjobs-"));
let mailboxPath = "";
let counter = 0;
const lines: string[] = [];
const log = (line: string) => lines.push(line);

const message = { to: "nobody@example.invalid", subject: "s", body: "b" };

function deps(over: Partial<WorkerDeps> = {}): WorkerDeps {
  return {
    pool,
    transport: new FakeTransport(mailboxPath, 0),
    sendTimeoutMs: 30000,
    uncertainSendPolicy: "resend",
    backoffBaseMs: 2000,
    backoffCapMs: 300000,
    ...over,
  };
}

async function newJob(extra: { type?: string; payload?: unknown } = {}): Promise<string> {
  const result = await enqueueJob(pool, {
    ownerId: "user-a",
    idempotencyKey: `${PREFIX}${++counter}-${Date.now()}`,
    type: extra.type ?? "send_email",
    payload: extra.payload ?? message,
    maxAttempts: config.maxAttempts,
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

async function jobRow(id: string) {
  return (await pool.query("SELECT * FROM jobs WHERE id = $1", [id])).rows[0];
}

async function stubTransport(outcome: TransportOutcome): Promise<MailTransport> {
  return { send: async () => outcome };
}

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

describe("S3 happy path", () => {
  it("claims, sends once and finishes: succeeded, attempts 1, attempt row closed", async () => {
    const id = await newJob();
    expect(await runOne(deps(), "w1", log)).toBe(true);

    const job = await jobRow(id);
    expect(job.status).toBe("succeeded");
    expect(job.attempts).toBe(1);
    expect(job.locked_by).toBeNull();
    expect(job.finished_at).not.toBeNull();

    const attempts = (await pool.query("SELECT * FROM job_attempts WHERE job_id = $1", [id])).rows;
    expect(attempts).toHaveLength(1);
    expect(attempts[0].attempt_no).toBe(1);
    expect(attempts[0].worker_id).toBe("w1");
    expect(attempts[0].finished_at).not.toBeNull();
    expect(attempts[0].error).toBeNull();

    const sent = (await pool.query("SELECT * FROM sent_emails WHERE job_id = $1", [id])).rows[0];
    expect(sent.state).toBe("sent");
    expect((await readMailbox(mailboxPath)).filter((e) => e.idempotencyKey === id)).toHaveLength(1);
  });

  it("returns false and does nothing when no job is ready", async () => {
    expect(await runOne(deps(), "w1", log)).toBe(false);
  });

  it("does not claim a job whose run_at is in the future", async () => {
    const id = await newJob();
    await pool.query("UPDATE jobs SET run_at = now() + interval '1 hour' WHERE id = $1", [id]);
    expect(await claimJob(pool, "w1")).toBeNull();
    expect((await jobRow(id)).status).toBe("pending");
  });

  it("never logs the address, subject or body", async () => {
    await newJob();
    await runOne(deps(), "w1", log);
    const text = lines.join("\n");
    expect(lines.length).toBeGreaterThan(0);
    expect(text).not.toContain("nobody@example.invalid");
  });
});

describe("FR4 guarded finish", () => {
  it("a worker that does not hold the job cannot finish it", async () => {
    const id = await newJob();
    const job = await claimJob(pool, "w1");
    expect(job?.id).toBe(id);
    expect(await finishSuccess(pool, job!, "w2")).toBe(false);
    expect((await jobRow(id)).status).toBe("processing");
    expect(await finishSuccess(pool, job!, "w1")).toBe(true);
    expect((await jobRow(id)).status).toBe("succeeded");
  });

  it("a finish that arrives after the job left processing changes nothing", async () => {
    await newJob();
    const job = await claimJob(pool, "w1");
    await pool.query("UPDATE jobs SET status = 'failed', locked_by = NULL WHERE id = $1", [job!.id]);
    expect(await finishSuccess(pool, job!, "w1")).toBe(false);
    expect((await jobRow(job!.id)).status).toBe("failed");
  });
});

describe("T6 double run", () => {
  it("calling send twice leaves one message for that key", async () => {
    const id = await newJob();
    await sendEmailSafely(deps(), id, message);
    await sendEmailSafely(deps(), id, message);
    expect((await readMailbox(mailboxPath)).filter((e) => e.idempotencyKey === id)).toHaveLength(1);
  });

  it("policy resend: a row left in sending is re-sent with the same key, still one message", async () => {
    const id = await newJob();
    await sendEmailSafely(deps(), id, message);
    await sendEmailSafely(deps(), id, message);
    await pool.query("UPDATE sent_emails SET state = 'sending', provider_message_id = NULL WHERE job_id = $1", [id]);
    await sendEmailSafely(deps({ uncertainSendPolicy: "resend" }), id, message);
    expect((await readMailbox(mailboxPath)).filter((e) => e.idempotencyKey === id)).toHaveLength(1);
    expect((await pool.query("SELECT state FROM sent_emails WHERE job_id = $1", [id])).rows[0].state).toBe("sent");
  });

  it("policy flag_for_human: a row left in sending throws a permanent 'uncertain send'", async () => {
    const id = await newJob();
    await pool.query("INSERT INTO sent_emails (job_id, state) VALUES ($1, 'sending')", [id]);
    const err = await sendEmailSafely(deps({ uncertainSendPolicy: "flag_for_human" }), id, message).catch((e) => e);
    expect(err).toBeInstanceOf(SendError);
    expect(err.kind).toBe("permanent");
    expect(err.message).toBe("uncertain send");
    expect(await readMailbox(mailboxPath)).toHaveLength(0);
  });
});

describe("send-email-safely outcomes", () => {
  it("a 4xx refusal deletes the sending row and is permanent", async () => {
    const id = await newJob();
    const err = await sendEmailSafely(deps({ transport: await stubTransport({ outcome: "refused", status: 422 }) }), id, message).catch((e) => e);
    expect(err.kind).toBe("permanent");
    expect((await pool.query("SELECT 1 FROM sent_emails WHERE job_id = $1", [id])).rowCount).toBe(0);
  });

  it("a 429 refusal deletes the sending row and is retryable", async () => {
    const id = await newJob();
    const err = await sendEmailSafely(deps({ transport: await stubTransport({ outcome: "refused", status: 429 }) }), id, message).catch((e) => e);
    expect(err.kind).toBe("retryable");
    expect((await pool.query("SELECT 1 FROM sent_emails WHERE job_id = $1", [id])).rowCount).toBe(0);
  });

  it("an unknown outcome leaves the row as sending and is retryable", async () => {
    const id = await newJob();
    const err = await sendEmailSafely(deps({ transport: await stubTransport({ outcome: "unknown", reason: "timeout" }) }), id, message).catch((e) => e);
    expect(err.kind).toBe("retryable");
    expect((await pool.query("SELECT state FROM sent_emails WHERE job_id = $1", [id])).rows[0].state).toBe("sending");
  });
});

describe("FR14 worker config validation", () => {
  const base = {
    DATABASE_URL: "x",
    MAX_ATTEMPTS: "5",
    PORT: "3000",
    POLL_INTERVAL_MS: "1000",
    SEND_TIMEOUT_MS: "30000",
    FAKE_SEND_DELAY_MS: "0",
    UNCERTAIN_SEND_POLICY: "resend",
    BACKOFF_BASE_MS: "2000",
    BACKOFF_CAP_MS: "300000",
    STUCK_TIMEOUT_MS: "120000",
    SWEEP_INTERVAL_MS: "15000", WORKER_CONCURRENCY: "5", HEARTBEAT_INTERVAL_MS: "10000",
  };
  it("accepts a valid config", () => {
    expect(loadWorkerConfig(base).sendTimeoutMs).toBe(30000);
  });
  it("refuses FAKE_SEND_DELAY_MS at or above SEND_TIMEOUT_MS", () => {
    expect(() => loadWorkerConfig({ ...base, FAKE_SEND_DELAY_MS: "30000" })).toThrow(/FAKE_SEND_DELAY_MS/);
  });
  it("refuses an unknown policy", () => {
    expect(() => loadWorkerConfig({ ...base, UNCERTAIN_SEND_POLICY: "maybe" })).toThrow(/UNCERTAIN_SEND_POLICY/);
  });
});
