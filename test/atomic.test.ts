import pg from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { enqueueJob } from "../src/enqueue.js";
import { failOrRetryInTransaction, type FailInput } from "../src/failOrRetry.js";
import { sweepStuck } from "../src/sweep.js";
import type { MailTransport } from "../src/transport.js";
import { finishSuccess, processJob, type ClaimedJob, type WorkerDeps } from "../src/worker.js";
import { startWorkerLoop } from "../src/workerLoop.js";

// S5. Writes to the database, so it only runs against jobs_test (test/guard.setup.ts refuses anything
// else). It touches only rows whose key starts with PREFIX. Mail is a stub: nothing is ever sent.
const PREFIX = "s5atomic-";
const config = loadConfig();
const pool = new pg.Pool({ connectionString: config.databaseUrl });
const message = { to: "nobody@example.invalid", subject: "s", body: "b" };
const backoffCfg = { backoffBaseMs: 50, backoffCapMs: 1000 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let counter = 0;

function deps(transport: MailTransport, p: Pool = pool): WorkerDeps {
  return { pool: p, transport, sendTimeoutMs: 1000, uncertainSendPolicy: "flag_for_human", ...backoffCfg };
}
type Pool = pg.Pool;

// A job that `worker` already holds (processing, its attempt row open), inserted in one statement so a
// stray worker could never claim it. lockedMsAgo makes its lock look old, for the sweep.
async function heldJob(
  worker: string,
  opts: { attempts?: number; maxAttempts?: number; lockedMsAgo?: number } = {},
): Promise<ClaimedJob> {
  const attempts = opts.attempts ?? 1;
  const max = opts.maxAttempts ?? 5;
  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO jobs (type, owner_id, payload, payload_hash, status, attempts, max_attempts,
                       locked_by, locked_at, started_at, idempotency_key)
     VALUES ('send_email', 'test-user', $1, 'h', 'processing', $2, $3, $4,
             now() - ($5 * interval '1 millisecond'), now(), $6)
     RETURNING id`,
    [JSON.stringify(message), attempts, max, worker, opts.lockedMsAgo ?? 0, `${PREFIX}${++counter}-${Date.now()}`],
  );
  const id = inserted.rows[0].id;
  await pool.query("INSERT INTO job_attempts (job_id, attempt_no, worker_id) VALUES ($1, $2, $3)", [id, attempts, worker]);
  return { id, type: "send_email", payload: message, attempts, max_attempts: max };
}

const takeOver = (id: string) =>
  pool.query("UPDATE jobs SET locked_by = 'new-owner', locked_at = now() WHERE id = $1", [id]);

// One statement the proxy saw. `crashed` marks the statement it made throw.
type Ran = { sql: string; rowCount: number | null; crashed?: boolean };

// A pool whose connections work normally EXCEPT that a statement matching `pattern` throws, which
// simulates a crash between the two updates of a transaction. It RECORDS every statement that passes
// through (and the one it crashes), so a test can prove the first update really ran before the crash.
function poolFailingOn(pattern: RegExp, ran: Ran[] = []): Pool {
  return {
    connect: async () => {
      const client = await pool.connect();
      return new Proxy(client, {
        get(target: any, prop: string | symbol) {
          if (prop === "query") {
            return async (sql: unknown, ...rest: unknown[]) => {
              if (typeof sql === "string" && pattern.test(sql)) {
                ran.push({ sql: sql.trim(), rowCount: null, crashed: true });
                throw new Error("simulated crash between the two updates");
              }
              const result = await target.query(sql, ...rest);
              if (typeof sql === "string") ran.push({ sql: sql.trim(), rowCount: result.rowCount ?? null });
              return result;
            };
          }
          const value = target[prop];
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  } as unknown as Pool;
}

// The strengthened crash proof: the FIRST update really executed (and changed one row) inside the
// transaction BEFORE the crash, the second statement was attempted and crashed, and the transaction
// ended in ROLLBACK, never COMMIT. The tests then show the job row is unchanged.
function expectFirstUpdateRanThenRolledBack(ran: Ran[], firstUpdate: RegExp) {
  const first = ran.find((r) => !r.crashed && firstUpdate.test(r.sql));
  expect(first, "the first UPDATE must have executed before the crash").toBeDefined();
  expect(first!.rowCount).toBe(1);
  const crashAt = ran.findIndex((r) => r.crashed);
  expect(crashAt).toBeGreaterThanOrEqual(0);
  expect(ran.indexOf(first!)).toBeLessThan(crashAt);
  expect(ran.some((r) => r.sql === "BEGIN")).toBe(true);
  expect(ran.some((r) => r.sql === "ROLLBACK")).toBe(true);
  expect(ran.some((r) => r.sql === "COMMIT")).toBe(false);
}

// A pool whose "who owns the job now" read fails, to prove the warning is still logged.
function poolWhoseOwnerReadFails(): Pool {
  return {
    connect: () => pool.connect(),
    query: (sql: unknown, ...rest: unknown[]) =>
      typeof sql === "string" && /SELECT status, locked_by FROM jobs/.test(sql)
        ? Promise.reject(new Error("simulated read failure"))
        : (pool as any).query(sql, ...rest),
  } as unknown as Pool;
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

async function waitFor(check: () => Promise<boolean>, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await sleep(25);
  }
  throw new Error("timed out waiting");
}

beforeEach(cleanup);
afterAll(async () => {
  await cleanup();
  await pool.end();
});

const failInput = (job: ClaimedJob, kind: "retryable" | "permanent", worker = "w1"): FailInput => ({
  jobId: job.id,
  attemptNo: job.attempts,
  maxAttempts: job.max_attempts,
  kind,
  error: "provider refused with 550",
  guard: { by: "worker", workerId: worker },
});

describe("S5: finishing a job is ONE transaction", () => {
  it("success path: a crash between the two updates leaves no half-finished state", async () => {
    const job = await heldJob("w1");
    const before = await jobRow(job.id);
    const ran: Ran[] = [];
    await expect(finishSuccess(poolFailingOn(/UPDATE job_attempts/, ran), job, "w1")).rejects.toThrow("simulated crash");
    expectFirstUpdateRanThenRolledBack(ran, /UPDATE jobs\s+SET status = 'succeeded'/);

    // The first statement (the job update) was rolled back: the job is exactly as it was.
    const row = await jobRow(job.id);
    expect(row).toEqual(before);
    expect(row.status).toBe("processing");
    expect(row.locked_by).toBe("w1");
    expect(row.finished_at).toBeNull();
    expect((await attemptRows(job.id))[0].finished_at).toBeNull();

    // Control: without the crash the same call finishes both together.
    expect(await finishSuccess(pool, job, "w1")).toBe(true);
    expect((await jobRow(job.id)).status).toBe("succeeded");
    expect((await attemptRows(job.id))[0].finished_at).not.toBeNull();
  });

  for (const kind of ["retryable", "permanent"] as const) {
    it(`${kind} failure path: a crash between the two updates leaves no half-finished state`, async () => {
      const job = await heldJob("w1");
      const before = await jobRow(job.id);
      const ran: Ran[] = [];
      await expect(failOrRetryInTransaction(poolFailingOn(/UPDATE job_attempts/, ran), backoffCfg, failInput(job, kind))).rejects.toThrow(
        "simulated crash",
      );
      expectFirstUpdateRanThenRolledBack(
        ran,
        kind === "retryable" ? /UPDATE jobs\s+SET status = 'failed'/ : /UPDATE jobs\s+SET status = 'dead'/,
      );

      const row = await jobRow(job.id);
      expect(row).toEqual(before); // every column of the job row is unchanged after the rollback
      expect(row.status).toBe("processing"); // not failed, not dead
      expect(row.locked_by).toBe("w1");
      expect(row.last_error).toBeNull();
      expect(new Date(row.run_at).getTime()).toBe(new Date(before.run_at).getTime());
      const [attempt] = await attemptRows(job.id);
      expect(attempt.finished_at).toBeNull();
      expect(attempt.error).toBeNull();
      expect(attempt.delay_ms).toBeNull();

      // Control: without the crash both updates land together.
      const result = await failOrRetryInTransaction(pool, backoffCfg, failInput(job, kind));
      expect(result.outcome).toBe(kind === "retryable" ? "failed" : "dead");
      expect((await jobRow(job.id)).status).toBe(kind === "retryable" ? "failed" : "dead");
      expect((await attemptRows(job.id))[0].finished_at).not.toBeNull();
    });
  }
});

describe("S5: a stale finish changes zero rows and logs once", () => {
  it("finishSuccess by a worker that lost the job returns false and writes nothing", async () => {
    const job = await heldJob("old");
    await takeOver(job.id);
    const before = await jobRow(job.id);
    expect(await finishSuccess(pool, job, "old")).toBe(false);
    const after = await jobRow(job.id);
    expect(after).toEqual(before); // every column of the job row, unchanged
    const [attempt] = await attemptRows(job.id);
    expect(attempt.finished_at).toBeNull();
    expect(attempt.error).toBeNull();
  });

  it("failOrRetryInTransaction by a worker that lost the job reports 'lost' and writes nothing", async () => {
    const job = await heldJob("old");
    await takeOver(job.id);
    const before = await jobRow(job.id);
    for (const kind of ["retryable", "permanent"] as const) {
      expect((await failOrRetryInTransaction(pool, backoffCfg, failInput(job, kind, "old"))).outcome).toBe("lost");
    }
    expect(await jobRow(job.id)).toEqual(before);
    expect((await attemptRows(job.id))[0].finished_at).toBeNull();
  });

  it("success path through processJob: exactly ONE warning with the job id, the current owner and the status", async () => {
    const job = await heldJob("old");
    const logs: string[] = [];
    const transport: MailTransport = {
      send: async () => {
        await takeOver(job.id); // the sweep reclaimed the job while this worker was still sending
        return { outcome: "accepted", messageId: "<m>" };
      },
    };
    await processJob(deps(transport), job, "old", (l) => logs.push(l));
    const warnings = logs.filter((l) => l.startsWith("WARN"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(`job=${job.id}`);
    expect(warnings[0]).toContain("owner=new-owner");
    expect(warnings[0]).toContain("status=processing");
    const row = await jobRow(job.id);
    expect(row.status).toBe("processing");
    expect(row.locked_by).toBe("new-owner");
    expect((await attemptRows(job.id))[0].finished_at).toBeNull();
  });

  it("failure path through processJob: exactly ONE warning, and the new owner's row is not written", async () => {
    const job = await heldJob("old");
    const logs: string[] = [];
    const transport: MailTransport = {
      send: async () => {
        await takeOver(job.id);
        return { outcome: "refused", status: 550, retryable: false }; // would make the job dead if it still owned it
      },
    };
    await processJob(deps(transport), job, "old", (l) => logs.push(l));
    const warnings = logs.filter((l) => l.startsWith("WARN"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(`job=${job.id}`);
    expect(warnings[0]).toContain("owner=new-owner");
    const row = await jobRow(job.id);
    expect(row.status).toBe("processing"); // not dead
    expect(row.last_error).toBeNull();
    expect((await attemptRows(job.id))[0].finished_at).toBeNull();
  });

  it("the warning is still logged, with owner and status 'unknown', if reading them fails", async () => {
    const job = await heldJob("old");
    const logs: string[] = [];
    const transport: MailTransport = {
      send: async () => {
        await takeOver(job.id);
        return { outcome: "accepted", messageId: "<m>" };
      },
    };
    await processJob(deps(transport, poolWhoseOwnerReadFails()), job, "old", (l) => logs.push(l));
    const warnings = logs.filter((l) => l.startsWith("WARN"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(`job=${job.id}`);
    expect(warnings[0]).toContain("owner=unknown");
    expect(warnings[0]).toContain("status=unknown");
  });

  it("the worker never exits: after losing one job it carries on with the next", async () => {
    const lost = await enqueueJob(pool, { ownerId: "u", idempotencyKey: `${PREFIX}lost-${Date.now()}`, type: "send_email", payload: message, maxAttempts: 5 });
    const fine = await enqueueJob(pool, { ownerId: "u", idempotencyKey: `${PREFIX}fine-${Date.now()}`, type: "send_email", payload: message, maxAttempts: 5 });
    if (lost.outcome !== "created" || fine.outcome !== "created") throw new Error("test jobs not created");
    const logs: string[] = [];
    const transport: MailTransport = {
      send: async (_m, options) => {
        if (options.idempotencyKey === lost.jobId) await takeOver(lost.jobId);
        return { outcome: "accepted", messageId: "<m>" };
      },
    };
    const loop = startWorkerLoop(deps(transport), "w1", { concurrency: 2, pollIntervalMs: 20 }, (l) => logs.push(l));
    await waitFor(async () => (await jobRow(fine.jobId)).status === "succeeded" && logs.some((l) => l.startsWith("WARN")));
    await loop.stop(); // resolves: the loop did not crash

    expect((await jobRow(fine.jobId)).status).toBe("succeeded");
    const lostRow = await jobRow(lost.jobId);
    expect(lostRow.status).toBe("processing"); // left alone for its new owner
    expect(lostRow.locked_by).toBe("new-owner");
    const warnings = logs.filter((l) => l.startsWith("WARN"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(`job=${lost.jobId}`);
    expect(logs.at(-1)).toMatch(/max_concurrent=\d+$/);
  });
});

describe("S5: the sweep path still gives failed or dead", () => {
  it("a stuck job below the maximum becomes failed with a future run_at and a closed attempt; at the maximum it becomes dead", async () => {
    const below = await heldJob("gone", { attempts: 1, maxAttempts: 5, lockedMsAgo: 120000 });
    const atMax = await heldJob("gone", { attempts: 5, maxAttempts: 5, lockedMsAgo: 120000 });
    const logs: string[] = [];
    expect(await sweepStuck(pool, { stuckTimeoutMs: 60000, ...backoffCfg }, (l) => logs.push(l))).toBe(2);

    const failed = await jobRow(below.id);
    expect(failed.status).toBe("failed");
    expect(failed.locked_by).toBeNull();
    expect(failed.last_error).toBe("stuck: worker lost or slow");
    const future = await pool.query("SELECT run_at > now() AS in_future FROM jobs WHERE id = $1", [below.id]);
    expect(future.rows[0].in_future).toBe(true);
    const [a1] = await attemptRows(below.id);
    expect(a1.finished_at).not.toBeNull();
    expect(a1.error).toBe("stuck: worker lost or slow");
    expect(a1.backoff_bound_ms).toBe(50);

    const dead = await jobRow(atMax.id);
    expect(dead.status).toBe("dead");
    expect(dead.finished_at).not.toBeNull();
    const [a5] = await attemptRows(atMax.id);
    expect(a5.finished_at).not.toBeNull();
    expect(a5.delay_ms).toBeNull();
    expect(logs.filter((l) => l.startsWith("sweep job="))).toHaveLength(2);
  });
});
