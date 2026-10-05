import pg from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { sendEmailSafely } from "../src/sendEmail.js";
import type { MailTransport } from "../src/transport.js";
import { processJob, type ClaimedJob, type WorkerDeps } from "../src/worker.js";

// THIS FILE WRITES TO jobs_dev. Run it only when the owner says so, and only after confirming that
// no worker and no web server is running. It never calls a mail server: the transport is a stub.
// It inserts its own job already in 'processing', so a stray worker cannot claim it, and it touches
// only rows whose key starts with PREFIX.
const PREFIX = "s2lost-";
const config = loadConfig();
const pool = new pg.Pool({ connectionString: config.databaseUrl });
const message = { to: "nobody@example.invalid", subject: "s", body: "b" };
let counter = 0;

function deps(transport: MailTransport): WorkerDeps {
  return {
    pool,
    transport,
    sendTimeoutMs: 1000,
    uncertainSendPolicy: "flag_for_human",
    backoffBaseMs: 50,
    backoffCapMs: 1000,
  };
}

// A job that `worker` already holds: processing, attempt 1 open. Inserted in one statement.
async function heldJob(worker: string): Promise<ClaimedJob> {
  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO jobs (type, owner_id, payload, payload_hash, status, attempts, max_attempts,
                       locked_by, locked_at, started_at, idempotency_key)
     VALUES ('send_email', 'test-user', $1, 'h', 'processing', 1, 5, $2, now(), now(), $3)
     RETURNING id`,
    [JSON.stringify(message), worker, `${PREFIX}${++counter}-${Date.now()}`],
  );
  const id = inserted.rows[0].id;
  await pool.query("INSERT INTO job_attempts (job_id, attempt_no, worker_id) VALUES ($1, 1, $2)", [id, worker]);
  return { id, type: "send_email", payload: message, attempts: 1, max_attempts: 5 };
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
const sentRow = async (id: string) => (await pool.query("SELECT * FROM sent_emails WHERE job_id = $1", [id])).rows[0];

beforeEach(cleanup);
afterAll(async () => {
  await cleanup();
  await pool.end();
});

describe("RULING 1: a worker that lost the job, with the mail already accepted", () => {
  it("records 'sent', writes nothing else for the lost job, and logs one warning naming the job", async () => {
    const job = await heldJob("loser");
    const logs: string[] = [];
    // While this worker is still sending, the sweep reclaims the job and a new owner holds it.
    const transport: MailTransport = {
      send: async () => {
        await pool.query("UPDATE jobs SET locked_by = 'new-owner', locked_at = now() WHERE id = $1", [job.id]);
        return { outcome: "accepted", messageId: "<accepted-1>" };
      },
    };

    await processJob(deps(transport), job, "loser", (line) => logs.push(line));

    // The email was accepted, so that fact is recorded even though the job was lost.
    const sent = await sentRow(job.id);
    expect(sent.state).toBe("sent");
    expect(sent.provider_message_id).toBe("<accepted-1>");

    // The loser wrote NOTHING to the job row: the new owner's row is exactly as it was.
    const row = await jobRow(job.id);
    expect(row.status).toBe("processing");
    expect(row.locked_by).toBe("new-owner");
    expect(row.finished_at).toBeNull();
    expect(row.last_error).toBeNull();
    expect(row.attempts).toBe(1);

    // ... and nothing to the attempt row: the loser did not close it.
    const [attempt] = await attemptRows(job.id);
    expect(attempt.finished_at).toBeNull();
    expect(attempt.error).toBeNull();

    // Exactly one warning: the job id, who owns the job now, and what state it is in (rule 0.15).
    const warnings = logs.filter((l) => l.startsWith("WARN"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(`job=${job.id}`);
    expect(warnings[0]).toContain("owner=new-owner");
    expect(warnings[0]).toContain("status=processing");
    expect(logs.join("\n")).not.toContain("nobody@example.invalid");
  });

  it("the guarded update leaves a row that is already 'sent' exactly as it was", async () => {
    const job = await heldJob("w1");
    const transport: MailTransport = {
      send: async () => {
        // Something else recorded the send first (for example a second worker).
        await pool.query("UPDATE sent_emails SET state = 'sent', provider_message_id = '<first>' WHERE job_id = $1", [job.id]);
        return { outcome: "accepted", messageId: "<second>" };
      },
    };

    await sendEmailSafely(deps(transport), job.id, message);

    const sent = await sentRow(job.id);
    expect(sent.state).toBe("sent");
    expect(sent.provider_message_id).toBe("<first>"); // not overwritten
  });

  it("a 'sent' row is never turned back into 'sending': a second run sends nothing and changes nothing", async () => {
    const job = await heldJob("w1");
    const accept: MailTransport = { send: async () => ({ outcome: "accepted", messageId: "<once>" }) };
    await sendEmailSafely(deps(accept), job.id, message);
    const before = await sentRow(job.id);
    expect(before.state).toBe("sent");

    const mustNotRun: MailTransport = {
      send: async () => {
        throw new Error("the transport must not be called for a job that is already sent");
      },
    };
    await sendEmailSafely(deps(mustNotRun), job.id, message);

    const after = await sentRow(job.id);
    expect(after.state).toBe("sent");
    expect(after.provider_message_id).toBe("<once>");
    expect(after.updated_at).toEqual(before.updated_at);
  });
});
