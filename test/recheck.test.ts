import pg from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { sweepStuck } from "../src/sweep.js";
import type { MailTransport, TransportOutcome } from "../src/transport.js";
import { processJob, type ClaimedJob, type WorkerDeps } from "../src/worker.js";

// S6: the ownership re-check before sending. Writes to the database, so it only runs against
// jobs_test (test/guard.setup.ts refuses anything else). It touches only rows whose key starts with
// PREFIX. Mail is a spy: nothing is ever sent.
const PREFIX = "s6recheck-";
const config = loadConfig();
const pool = new pg.Pool({ connectionString: config.databaseUrl });
const message = { to: "nobody@example.invalid", subject: "s", body: "b" };
const backoffCfg = { backoffBaseMs: 50, backoffCapMs: 1000 };
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
// The lost-job warning text is STABLE: Phase 3 reads worker logs for it. Do not change this pattern
// without the owner's approval.
const LOST_WARNING = new RegExp(`^WARN worker=\\S+ job=${UUID} lost the job: owner=\\S+ status=\\S+; its result was discarded$`);
const RECHECK_SQL = /^UPDATE jobs SET locked_at = now\(\) WHERE id = \$1 AND locked_by = \$2 AND status = 'processing' RETURNING id$/;
let counter = 0;

// Every statement sent through the pool, in order, plus a marker "SMTP" each time the spy is called.
function recordingPool(order: string[]): pg.Pool {
  return {
    connect: () => pool.connect(),
    query: (sql: unknown, ...rest: unknown[]) => {
      if (typeof sql === "string") order.push(sql.replace(/\s+/g, " ").trim());
      return (pool as any).query(sql, ...rest);
    },
  } as unknown as pg.Pool;
}

function spyTransport(order: string[], outcome: TransportOutcome = { outcome: "accepted", messageId: "<m>" }) {
  const spy: MailTransport & { calls: number } = {
    calls: 0,
    send: async () => {
      spy.calls += 1;
      order.push("SMTP");
      return outcome;
    },
  };
  return spy;
}

function deps(transport: MailTransport, p: pg.Pool = pool): WorkerDeps {
  return { pool: p, transport, sendTimeoutMs: 1000, uncertainSendPolicy: "flag_for_human", ...backoffCfg };
}

// A job that `worker` already holds (processing, its attempt row open). Inserted in one statement so a
// stray worker could never claim it. lockedMsAgo makes its lock look old.
async function heldJob(worker: string, lockedMsAgo = 0): Promise<ClaimedJob> {
  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO jobs (type, owner_id, payload, payload_hash, status, attempts, max_attempts,
                       locked_by, locked_at, started_at, idempotency_key)
     VALUES ('send_email', 'test-user', $1, 'h', 'processing', 1, 5, $2,
             now() - ($3 * interval '1 millisecond'), now(), $4)
     RETURNING id`,
    [JSON.stringify(message), worker, lockedMsAgo, `${PREFIX}${++counter}-${Date.now()}`],
  );
  const id = inserted.rows[0].id;
  await pool.query("INSERT INTO job_attempts (job_id, attempt_no, worker_id) VALUES ($1, 1, $2)", [id, worker]);
  return { id, type: "send_email", payload: message, attempts: 1, max_attempts: 5 };
}

const takeOver = (id: string) =>
  pool.query("UPDATE jobs SET locked_by = 'new-owner', locked_at = now() WHERE id = $1", [id]);

async function cleanup() {
  const ids = `SELECT id FROM jobs WHERE idempotency_key LIKE '${PREFIX}%'`;
  await pool.query(`DELETE FROM sent_emails WHERE job_id IN (${ids})`);
  await pool.query(`DELETE FROM job_attempts WHERE job_id IN (${ids})`);
  await pool.query(`DELETE FROM jobs WHERE idempotency_key LIKE '${PREFIX}%'`);
}
const jobRow = async (id: string) => (await pool.query("SELECT * FROM jobs WHERE id = $1", [id])).rows[0];
const attemptRows = async (id: string) =>
  (await pool.query("SELECT * FROM job_attempts WHERE job_id = $1 ORDER BY attempt_no", [id])).rows;
const sentRows = async (id: string) => (await pool.query("SELECT * FROM sent_emails WHERE job_id = $1", [id])).rows;

beforeEach(cleanup);
afterAll(async () => {
  await cleanup();
  await pool.end();
});

describe("S6: a job reclaimed before the send is dropped, with nothing sent and nothing written", () => {
  it("reclaimed by another worker: ZERO SMTP calls, no sent_emails row, no statement that creates one", async () => {
    const job = await heldJob("old");
    await takeOver(job.id); // the sweep reclaimed it and a new owner holds it BEFORE this worker sends
    const jobBefore = await jobRow(job.id);
    const attemptsBefore = await attemptRows(job.id);
    const order: string[] = [];
    const spy = spyTransport(order);
    const logs: string[] = [];

    await processJob(deps(spy, recordingPool(order)), job, "old", (l) => logs.push(l));

    expect(spy.calls).toBe(0); // zero SMTP calls
    expect(order).not.toContain("SMTP");
    expect(await sentRows(job.id)).toHaveLength(0); // no sent_emails row
    expect(order.some((s) => /^INSERT INTO sent_emails/.test(s))).toBe(false); // not even an attempt to create one
    expect(await jobRow(job.id)).toEqual(jobBefore); // the loser wrote nothing to the job row (locked_at not refreshed either)
    expect(await attemptRows(job.id)).toEqual(attemptsBefore); // ... nor to the attempt row

    const warnings = logs.filter((l) => l.startsWith("WARN"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(LOST_WARNING);
    expect(warnings[0]).toContain(`job=${job.id}`);
    expect(warnings[0]).toContain("owner=new-owner");
    expect(warnings[0]).toContain("status=processing");
  });

  it("already failed by the sweep (no owner now): zero SMTP calls, no sending row, the warning says owner=none status=failed", async () => {
    const job = await heldJob("old", 120000); // its lock looks old
    expect(await sweepStuck(pool, { stuckTimeoutMs: 60000, ...backoffCfg }, () => undefined)).toBe(1);
    const jobBefore = await jobRow(job.id);
    expect(jobBefore.status).toBe("failed");
    const attemptsBefore = await attemptRows(job.id);
    const order: string[] = [];
    const spy = spyTransport(order);
    const logs: string[] = [];

    await processJob(deps(spy, recordingPool(order)), job, "old", (l) => logs.push(l));

    expect(spy.calls).toBe(0);
    expect(await sentRows(job.id)).toHaveLength(0);
    expect(await jobRow(job.id)).toEqual(jobBefore);
    expect(await attemptRows(job.id)).toEqual(attemptsBefore);
    const warnings = logs.filter((l) => l.startsWith("WARN"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(LOST_WARNING);
    expect(warnings[0]).toContain("owner=none");
    expect(warnings[0]).toContain("status=failed");
  });

  it("the dropped job does not stop the worker: processJob returns normally", async () => {
    const job = await heldJob("old");
    await takeOver(job.id);
    await expect(processJob(deps(spyTransport([])), job, "old", () => undefined)).resolves.toBeUndefined();
  });
});

describe("S6: a job that is still owned proceeds", () => {
  it("one SMTP call, the job succeeds, the email is recorded as sent, and no warning is logged", async () => {
    const job = await heldJob("w1");
    const order: string[] = [];
    const spy = spyTransport(order);
    const logs: string[] = [];
    await processJob(deps(spy, recordingPool(order)), job, "w1", (l) => logs.push(l));

    expect(spy.calls).toBe(1);
    expect((await jobRow(job.id)).status).toBe("succeeded");
    expect((await sentRows(job.id))[0].state).toBe("sent");
    expect(logs.filter((l) => l.startsWith("WARN"))).toHaveLength(0);
  });

  it("ORDER: the re-check comes first, then the sending row, then the SMTP call", async () => {
    const job = await heldJob("w1");
    const order: string[] = [];
    await processJob(deps(spyTransport(order), recordingPool(order)), job, "w1", () => undefined);

    const recheck = order.findIndex((s) => RECHECK_SQL.test(s)); // also pins the exact statement
    const sending = order.findIndex((s) => /^INSERT INTO sent_emails/.test(s));
    const smtp = order.indexOf("SMTP");
    expect(recheck).toBeGreaterThanOrEqual(0);
    expect(sending).toBeGreaterThan(recheck);
    expect(smtp).toBeGreaterThan(sending);
  });

  it("the re-check refreshes locked_at: a lock that looked 2 minutes old is fresh when the SMTP call is made", async () => {
    const job = await heldJob("w1", 120000);
    const stale = await pool.query("SELECT (now() - locked_at) > interval '60 seconds' AS stale FROM jobs WHERE id = $1", [job.id]);
    expect(stale.rows[0].stale).toBe(true); // before: stale
    let freshAtSend: boolean | null = null;
    const transport: MailTransport = {
      send: async () => {
        const r = await pool.query("SELECT (now() - locked_at) < interval '10 seconds' AS fresh FROM jobs WHERE id = $1", [job.id]);
        freshAtSend = r.rows[0].fresh;
        return { outcome: "accepted", messageId: "<m>" };
      },
    };
    await processJob(deps(transport), job, "w1", () => undefined);
    expect(freshAtSend).toBe(true); // at the SMTP call: fresh
  });

  it("the re-check never refreshes a lock it does not own", async () => {
    const job = await heldJob("old", 120000);
    await pool.query("UPDATE jobs SET locked_by = 'new-owner', locked_at = now() - interval '120 seconds' WHERE id = $1", [job.id]);
    const before = await jobRow(job.id);
    await processJob(deps(spyTransport([])), job, "old", () => undefined);
    expect((await jobRow(job.id)).locked_at).toEqual(before.locked_at); // the new owner's lock was not touched
  });
});

describe("the lost-job warning text is stable", () => {
  it("a job lost BEFORE the send (S6) and a job lost DURING the send (S5) log lines of exactly the same shape", async () => {
    const before = await heldJob("old");
    await takeOver(before.id);
    const during = await heldJob("old");
    const logsBefore: string[] = [];
    const logsDuring: string[] = [];
    await processJob(deps(spyTransport([])), before, "old", (l) => logsBefore.push(l));
    const transport: MailTransport = {
      send: async () => {
        await takeOver(during.id);
        return { outcome: "accepted", messageId: "<m>" };
      },
    };
    await processJob(deps(transport), during, "old", (l) => logsDuring.push(l));

    const a = logsBefore.filter((l) => l.startsWith("WARN"));
    const b = logsDuring.filter((l) => l.startsWith("WARN"));
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0]).toMatch(LOST_WARNING);
    expect(b[0]).toMatch(LOST_WARNING);
    // identical apart from the job id
    expect(a[0].replace(before.id, "<id>")).toBe(b[0].replace(during.id, "<id>"));
    expect(a[0].replace(before.id, "<id>")).toBe("WARN worker=old job=<id> lost the job: owner=new-owner status=processing; its result was discarded");
  });
});
