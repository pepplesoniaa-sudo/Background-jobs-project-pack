import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { enqueueJob } from "../src/enqueue.js";
import { FakeTransport, readMailbox, type MailMessage, type MailTransport, type SendOptions } from "../src/transport.js";
import type { WorkerDeps } from "../src/worker.js";
import { startWorkerLoop } from "../src/workerLoop.js";

// Real Postgres (local dev DB). Test rows are removed by key prefix only.
const PREFIX = "s6test-";
const config = loadConfig();
const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 20 });
const dir = mkdtempSync(join(tmpdir(), "bgjobs-s6-"));
let mailboxPath = "";
let counter = 0;
let lines: string[] = [];
const log = (line: string) => lines.push(line);

const message = { to: "nobody@example.invalid", subject: "s", body: "b" };

// Counts sends really in flight, independent of what the worker logs about itself.
class TrackingTransport implements MailTransport {
  inFlight = 0;
  maxInFlight = 0;
  constructor(private readonly inner: MailTransport) {}
  async send(m: MailMessage, o: SendOptions) {
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      return await this.inner.send(m, o);
    } finally {
      this.inFlight -= 1;
    }
  }
}

function deps(transport: MailTransport, poolOverride: pg.Pool = pool): WorkerDeps {
  return {
    pool: poolOverride,
    transport,
    sendTimeoutMs: 30000,
    uncertainSendPolicy: "resend",
    backoffBaseMs: 50,
    backoffCapMs: 10000,
  };
}

async function enqueueMany(n: number): Promise<string[]> {
  const stamp = Date.now();
  return Promise.all(
    Array.from({ length: n }, async (_, i) => {
      const r = await enqueueJob(pool, {
        ownerId: "user-a",
        idempotencyKey: `${PREFIX}${stamp}-${i}`,
        type: "send_email",
        payload: message,
        maxAttempts: config.maxAttempts,
      });
      if (r.outcome !== "created") throw new Error("test job not created");
      return r.jobId;
    }),
  );
}

async function cleanup() {
  const ids = `SELECT id FROM jobs WHERE idempotency_key LIKE '${PREFIX}%'`;
  await pool.query(`DELETE FROM sent_emails WHERE job_id IN (${ids})`);
  await pool.query(`DELETE FROM job_attempts WHERE job_id IN (${ids})`);
  await pool.query(`DELETE FROM jobs WHERE idempotency_key LIKE '${PREFIX}%'`);
}

async function waitUntilNoneLeft(ids: string[], timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const open = await pool.query(
      "SELECT count(*)::int AS n FROM jobs WHERE id = ANY($1) AND status NOT IN ('succeeded','dead')",
      [ids],
    );
    if (open.rows[0].n === 0) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("jobs did not finish in time");
}

const maxConcurrentIn = (worker: string) =>
  Math.max(
    0,
    ...lines
      .filter((l) => l.startsWith(`worker=${worker} concurrent=`))
      .map((l) => Number(/concurrent=(\d+)/.exec(l)![1])),
  );

beforeEach(async () => {
  await cleanup();
  lines = [];
  mailboxPath = join(dir, `mailbox-${++counter}.jsonl`);
});
afterAll(async () => {
  await cleanup();
  await pool.end();
  rmSync(dir, { recursive: true, force: true });
});

describe("T1 concurrency cap (in-process; the real-process run is recorded separately)", () => {
  it("50 jobs, N=5: never more than 5 at once, all 50 succeed, logged max matches reality", async () => {
    const ids = await enqueueMany(50);
    const transport = new TrackingTransport(new FakeTransport(mailboxPath, 100));
    const handle = startWorkerLoop(deps(transport), "w1", { concurrency: 5, pollIntervalMs: 20 }, log);

    await waitUntilNoneLeft(ids, 20000);
    await handle.stop();

    expect(transport.maxInFlight).toBeLessThanOrEqual(5);
    expect(transport.maxInFlight).toBe(5); // the cap was actually reached, not just respected
    expect(maxConcurrentIn("w1")).toBeLessThanOrEqual(5);
    expect(lines.at(-1)).toBe("worker=w1 max_concurrent=5");

    const done = await pool.query("SELECT status, count(*)::int AS n FROM jobs WHERE id = ANY($1) GROUP BY status", [ids]);
    expect(done.rows).toEqual([{ status: "succeeded", n: 50 }]);
    const mailbox = await readMailbox(mailboxPath);
    expect(mailbox).toHaveLength(50);
    expect(new Set(mailbox.map((m) => m.idempotencyKey)).size).toBe(50);
  }, 30000);

  it("N=1 runs strictly one at a time", async () => {
    const ids = await enqueueMany(6);
    const transport = new TrackingTransport(new FakeTransport(mailboxPath, 30));
    const handle = startWorkerLoop(deps(transport), "w1", { concurrency: 1, pollIntervalMs: 10 }, log);
    await waitUntilNoneLeft(ids, 10000);
    await handle.stop();
    expect(transport.maxInFlight).toBe(1);
    expect(lines.at(-1)).toBe("worker=w1 max_concurrent=1");
  });

  it("logs the running count on every change, ending at zero", async () => {
    const ids = await enqueueMany(3);
    const handle = startWorkerLoop(deps(new FakeTransport(mailboxPath, 20)), "w1", { concurrency: 2, pollIntervalMs: 10 }, log);
    await waitUntilNoneLeft(ids, 10000);
    await handle.stop();
    const counts = lines.filter((l) => l.includes(" concurrent=")).map((l) => Number(/concurrent=(\d+)/.exec(l)![1]));
    expect(counts.length).toBe(6); // 3 starts and 3 finishes
    expect(counts.at(-1)).toBe(0);
    expect(lines.join("\n")).not.toContain("nobody@example.invalid");
  });

  it("stop() waits for running jobs, so nothing is left in processing", async () => {
    const ids = await enqueueMany(4);
    const handle = startWorkerLoop(deps(new FakeTransport(mailboxPath, 300)), "w1", { concurrency: 2, pollIntervalMs: 10 }, log);
    while (handle.stats().running < 2) await new Promise((r) => setTimeout(r, 10));
    await handle.stop();
    expect(handle.stats().running).toBe(0);
    const stuck = await pool.query("SELECT count(*)::int AS n FROM jobs WHERE id = ANY($1) AND status = 'processing'", [ids]);
    expect(stuck.rows[0].n).toBe(0);
    const ok = await pool.query("SELECT count(*)::int AS n FROM jobs WHERE id = ANY($1) AND status = 'succeeded'", [ids]);
    expect(ok.rows[0].n).toBeGreaterThanOrEqual(2);
  });
});

describe("worker loop survives database errors", () => {
  it("a failing claim is logged and the loop carries on", async () => {
    const ids = await enqueueMany(3);
    let failures = 2;
    const flaky = new Proxy(pool, {
      get(target, prop, receiver) {
        if (prop === "query") {
          return (...args: unknown[]) => {
            if (failures > 0) {
              failures -= 1;
              return Promise.reject(Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:5432"), { code: "ECONNREFUSED" }));
            }
            return (target.query as (...a: unknown[]) => unknown)(...args);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const handle = startWorkerLoop(deps(new FakeTransport(mailboxPath, 10), flaky), "w1", { concurrency: 2, pollIntervalMs: 10 }, log);
    await waitUntilNoneLeft(ids, 10000);
    await handle.stop();
    expect(lines.filter((l) => l.startsWith("WARN worker=w1 claim failed"))).toHaveLength(2);
    expect(lines.join("\n")).not.toContain("10.0.0.1"); // the error message is never logged
    expect(lines.join("\n")).toContain("code=ECONNREFUSED");
  });
});

describe("two worker loops sharing one database (in-process complement to T5)", () => {
  it("40 jobs, two workers: no job claimed twice, each worker within its cap, both did work", async () => {
    const ids = await enqueueMany(40);
    const t1 = new TrackingTransport(new FakeTransport(mailboxPath, 60));
    const t2 = new TrackingTransport(new FakeTransport(mailboxPath, 60));
    const a = startWorkerLoop(deps(t1), "wa", { concurrency: 3, pollIntervalMs: 10 }, log);
    const b = startWorkerLoop(deps(t2), "wb", { concurrency: 3, pollIntervalMs: 10 }, log);
    await waitUntilNoneLeft(ids, 20000);
    await Promise.all([a.stop(), b.stop()]);

    const dup = await pool.query("SELECT job_id, count(*) FROM job_attempts WHERE job_id = ANY($1) GROUP BY job_id HAVING count(*) > 1", [ids]);
    expect(dup.rows).toHaveLength(0);
    const per = await pool.query("SELECT count(*)::int AS n FROM job_attempts WHERE job_id = ANY($1) AND finished_at IS NOT NULL AND error IS NULL", [ids]);
    expect(per.rows[0].n).toBe(40);
    expect(t1.maxInFlight).toBeLessThanOrEqual(3);
    expect(t2.maxInFlight).toBeLessThanOrEqual(3);
    const byWorker = await pool.query("SELECT worker_id, count(*)::int AS n FROM job_attempts WHERE job_id = ANY($1) GROUP BY worker_id", [ids]);
    expect(byWorker.rows).toHaveLength(2);
    const mailbox = await readMailbox(mailboxPath);
    expect(mailbox).toHaveLength(40);
    expect(new Set(mailbox.map((m) => m.idempotencyKey)).size).toBe(40);
  }, 30000);
});
