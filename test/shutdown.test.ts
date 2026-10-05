import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { enqueueJob } from "../src/enqueue.js";
import { activeHeartbeats, startHeartbeat } from "../src/ownership.js";
import { createShutdownHandler, SHUTDOWN_SIGNALS } from "../src/shutdown.js";
import { sweepStuck } from "../src/sweep.js";
import type { MailTransport, TransportOutcome } from "../src/transport.js";
import type { WorkerDeps } from "../src/worker.js";
import { startWorkerLoop, type StopResult } from "../src/workerLoop.js";

// jobs_test only (the guard in test/guard.setup.ts refuses anything else). A stub transport that waits
// for the test to let it go stands in for a slow SMTP server. Nothing here sends real mail.

const PREFIX = "s10shut-";
const config = loadConfig();
const pool = new pg.Pool({ connectionString: config.databaseUrl });
const message = { to: "nobody@example.invalid", subject: "s", body: "b" };
const accepted: TransportOutcome = { outcome: "accepted", messageId: "<m>" };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const LOST_WARNING = new RegExp(`^WARN worker=\\S+ job=${UUID} lost the job: owner=\\S+ status=\\S+; its result was discarded$`);
let counter = 0;

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((r) => (release = r));
  return { promise, release };
}

// A transport whose sends hang until released, counting how many started.
function slowTransport(g: ReturnType<typeof gate>) {
  const state = { started: 0 };
  const transport: MailTransport = {
    send: async () => {
      state.started += 1;
      await g.promise;
      return accepted;
    },
  };
  return { transport, state };
}

function deps(transport: MailTransport, p: pg.Pool = pool): WorkerDeps {
  return {
    pool: p, transport, sendTimeoutMs: 1000, uncertainSendPolicy: "flag_for_human",
    backoffBaseMs: 50, backoffCapMs: 1000, heartbeatIntervalMs: 30,
  };
}

async function newJob(): Promise<string> {
  const r = await enqueueJob(pool, {
    ownerId: "user-a", idempotencyKey: `${PREFIX}${++counter}-${Date.now()}`, type: "send_email", payload: message, maxAttempts: 5,
  });
  if (r.outcome !== "created") throw new Error("test job not created");
  return r.jobId;
}

async function cleanup() {
  const ids = `SELECT id FROM jobs WHERE idempotency_key LIKE '${PREFIX}%'`;
  await pool.query(`DELETE FROM sent_emails WHERE job_id IN (${ids})`);
  await pool.query(`DELETE FROM job_attempts WHERE job_id IN (${ids})`);
  await pool.query(`DELETE FROM jobs WHERE idempotency_key LIKE '${PREFIX}%'`);
}
const jobRow = async (id: string) => (await pool.query("SELECT * FROM jobs WHERE id = $1", [id])).rows[0];
const attemptRows = async (id: string) => (await pool.query("SELECT * FROM job_attempts WHERE job_id = $1", [id])).rows;
const sentRows = async (id: string) => (await pool.query("SELECT * FROM sent_emails WHERE job_id = $1", [id])).rows;

async function waitFor(check: () => boolean | Promise<boolean>, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await sleep(10);
  }
  throw new Error("timed out waiting");
}

beforeEach(async () => {
  await cleanup();
  expect(activeHeartbeats(), "a heartbeat timer was left running by an earlier test").toBe(0);
});
afterAll(async () => {
  await cleanup();
  await pool.end();
});

describe("S10 stop(): waits for running jobs", () => {
  it("stop() while 2 jobs are mid-send logs 'stopping, waiting for 2 jobs', does not resolve until they finish, then resolves", async () => {
    const ids = [await newJob(), await newJob()];
    const g = gate();
    const { transport, state } = slowTransport(g);
    const logs: string[] = [];
    const loop = startWorkerLoop(deps(transport), "w1", { concurrency: 2, pollIntervalMs: 10 }, (l) => logs.push(l));
    await waitFor(() => state.started === 2);

    let resolved = false;
    const stopped = loop.stop(5000).then((r) => ((resolved = true), r));
    await sleep(200);
    expect(resolved).toBe(false); // still waiting
    expect(logs).toContain("worker=w1 stopping, waiting for 2 jobs");
    for (const id of ids) expect((await jobRow(id)).status).toBe("processing");

    g.release();
    const result = await stopped;
    expect(result).toEqual({ timedOut: false, remaining: 0 });
    for (const id of ids) expect((await jobRow(id)).status).toBe("succeeded");
    expect(activeHeartbeats()).toBe(0);
    expect(logs.some((l) => l.startsWith("worker=w1 max_concurrent="))).toBe(true);
  });

  it("with nothing running it resolves at once and says it waits for 0 jobs", async () => {
    const logs: string[] = [];
    const loop = startWorkerLoop(deps(slowTransport(gate()).transport), "w1", { concurrency: 2, pollIntervalMs: 10 }, (l) => logs.push(l));
    const started = Date.now();
    expect(await loop.stop(5000)).toEqual({ timedOut: false, remaining: 0 });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(logs).toContain("worker=w1 stopping, waiting for 0 jobs");
  });
});

describe("S10 stop(): claims nothing new", () => {
  it("a job enqueued after the signal is never claimed, even while the running job finishes", async () => {
    const first = await newJob();
    const g = gate();
    const { transport, state } = slowTransport(g);
    const loop = startWorkerLoop(deps(transport), "w1", { concurrency: 2, pollIntervalMs: 10 }, () => undefined);
    await waitFor(() => state.started === 1);

    const stopped = loop.stop(5000);
    const late = await newJob(); // enqueued AFTER the signal, with a free slot (concurrency 2)
    await sleep(150);
    g.release();
    await stopped;
    await sleep(150);

    expect((await jobRow(first)).status).toBe("succeeded");
    const row = await jobRow(late);
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(0);
    expect(row.locked_by).toBeNull();
    expect(state.started).toBe(1); // the transport was never called for it
  });
});

describe("S10 stop(): gives up at the timeout and leaves the jobs for the sweep", () => {
  it("stop(300) with a job still mid-send resolves after about 300 ms, timedOut, job NOT finished, heartbeat cleared, and the sweep can recover it", async () => {
    const id = await newJob();
    const g = gate();
    const { transport, state } = slowTransport(g);
    const logs: string[] = [];
    const beats: string[] = [];
    const recording = {
      connect: () => pool.connect(),
      query: async (sql: unknown, ...rest: unknown[]) => {
        if (typeof sql === "string" && /SET locked_at = now\(\)/.test(sql)) beats.push("beat");
        return (pool as any).query(sql, ...rest);
      },
    } as unknown as pg.Pool;
    const loop = startWorkerLoop(deps(transport, recording), "w1", { concurrency: 1, pollIntervalMs: 10 }, (l) => logs.push(l));
    await waitFor(() => state.started === 1);
    await waitFor(() => beats.length >= 3); // the re-check and at least two beats

    const t0 = Date.now();
    const result: StopResult = await loop.stop(300);
    const elapsed = Date.now() - t0;
    expect(result).toEqual({ timedOut: true, remaining: 1 });
    expect(elapsed).toBeGreaterThanOrEqual(280);
    expect(elapsed).toBeLessThan(2000);
    expect(logs).toContain("worker=w1 stopping, waiting for 1 jobs");
    expect(logs).toContain("worker=w1 gave up waiting after 300 ms, leaving 1 jobs for the sweep");

    // Not marked finished: still processing, attempt row open.
    const row = await jobRow(id);
    expect(row.status).toBe("processing");
    expect(row.finished_at).toBeNull();
    expect((await attemptRows(id))[0].finished_at).toBeNull();

    // Its heartbeat is gone and stays gone.
    expect(activeHeartbeats()).toBe(0);
    const before = beats.length;
    await sleep(150);
    expect(beats.length).toBe(before);

    // The lock is no longer refreshed, so once it is old enough the sweep recovers the job.
    await pool.query("UPDATE jobs SET locked_at = now() - interval '2 minutes' WHERE id = $1", [id]);
    expect(await sweepStuck(pool, { stuckTimeoutMs: 60000, backoffBaseMs: 50, backoffCapMs: 1000 }, () => undefined)).toBe(1);
    expect((await jobRow(id)).status).toBe("failed");
    expect((await jobRow(id)).last_error).toBe("stuck: worker lost or slow");

    // In a real worker the process exits here. In this test the abandoned send finishes later: the mail
    // is recorded as sent, and the late finish of the job changes zero rows.
    g.release();
    await waitFor(() => logs.some((l) => LOST_WARNING.test(l)));
    expect((await jobRow(id)).status).toBe("failed");
    expect((await sentRows(id))[0].state).toBe("sent");
  });
});

describe("S10 the shutdown handler (first signal, second signal, timers)", () => {
  function fakes(stop: () => Promise<StopResult>) {
    const calls: string[] = [];
    const handler = createShutdownHandler({
      workerId: "w1",
      loop: { stop: async (t) => (calls.push(`stop(${t})`), stop()) },
      timeoutMs: 30000,
      stopTimers: () => void calls.push("stopTimers"),
      closePool: async () => void calls.push("closePool"),
      exit: (code) => void calls.push(`exit(${code})`),
      log: (l) => void calls.push(`log: ${l}`),
    });
    return { calls, handler };
  }

  it("the first signal: stops the timers, waits up to SEND_TIMEOUT_MS, closes the pool, exits 0", async () => {
    const { calls, handler } = fakes(async () => ({ timedOut: false, remaining: 0 }));
    await handler("SIGINT");
    expect(calls).toEqual([
      "log: worker=w1 received SIGINT, shutting down",
      "stopTimers",
      "stop(30000)",
      "closePool",
      "exit(0)",
    ]);
  });

  it("after a give-up it does not wait on the pool: it exits 0 straight away", async () => {
    const { calls, handler } = fakes(async () => ({ timedOut: true, remaining: 2 }));
    await handler("SIGTERM");
    expect(calls).not.toContain("closePool");
    expect(calls[calls.length - 1]).toBe("exit(0)");
  });

  it("a SECOND signal exits at once with code 1, while the first is still waiting", async () => {
    const { calls, handler } = fakes(() => new Promise<StopResult>(() => undefined)); // never finishes
    void handler("SIGINT");
    await sleep(20);
    expect(calls).not.toContain("exit(0)");
    await handler("SIGINT");
    expect(calls).toContain("log: worker=w1 received SIGINT again, exiting at once");
    expect(calls[calls.length - 1]).toBe("exit(1)");
    expect(calls.filter((c) => c === "stopTimers")).toHaveLength(1); // not run twice
    expect(calls.filter((c) => c.startsWith("stop("))).toHaveLength(1);
  });

  it("if stopping the loop throws, it still stops and exits 0", async () => {
    const { calls, handler } = fakes(async () => {
      throw new Error("boom");
    });
    await handler("SIGHUP");
    expect(calls.some((c) => c.startsWith("log: WARN worker=w1 stopping the loop failed"))).toBe(true);
    expect(calls[calls.length - 1]).toBe("exit(0)");
  });

  it("timers are cleared on exit: the sweep timer stops firing and no heartbeat timer is left", async () => {
    let sweeps = 0;
    const sweepTimer = setInterval(() => (sweeps += 1), 10);
    const hb = startHeartbeat({ query: async () => ({ rowCount: 1 }) } as any, "j", "w", 10, () => undefined);
    expect(activeHeartbeats()).toBe(1);
    let exited = -1;
    const handler = createShutdownHandler({
      workerId: "w1",
      loop: { stop: async () => ({ timedOut: false, remaining: 0 }) },
      timeoutMs: 1000,
      stopTimers: () => clearInterval(sweepTimer),
      closePool: async () => undefined,
      exit: (code) => (exited = code),
      log: () => undefined,
    });
    await handler("SIGINT");
    expect(exited).toBe(0);
    expect(activeHeartbeats()).toBe(0);
    const at = sweeps;
    await sleep(80);
    expect(sweeps).toBe(at);
    await hb.stop(); // stopping again is harmless
    expect(activeHeartbeats()).toBe(0);
  });
});

describe("S10 wiring in the real entry point", () => {
  it("workerMain.ts listens for the four signals, waits SEND_TIMEOUT_MS, clears the sweep timer and exits only through the handler", () => {
    expect([...SHUTDOWN_SIGNALS]).toEqual(["SIGINT", "SIGTERM", "SIGBREAK", "SIGHUP"]);
    const text = readFileSync("src/workerMain.ts", "utf8");
    expect(text).toMatch(/createShutdownHandler\(\{[\s\S]*timeoutMs: config\.sendTimeoutMs,/);
    expect(text).toContain("stopTimers: () => clearInterval(sweepTimer)");
    expect(text).toContain("closePool: () => pool.end()");
    expect(text).toMatch(/for \(const signal of SHUTDOWN_SIGNALS\) process\.on\(signal, \(\) => void shutdown\(signal\)\)/);
    expect(text.split("process.exit(").length - 1).toBe(1); // only inside the handler's exit wrapper
    expect(text).not.toContain("loop.stop()"); // the old wait-forever stop is gone
  });
});
