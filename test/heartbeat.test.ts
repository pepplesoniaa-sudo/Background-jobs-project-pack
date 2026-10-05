import pg from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { enqueueJob } from "../src/enqueue.js";
import { activeHeartbeats, OWNERSHIP_SQL } from "../src/ownership.js";
import { sweepStuck } from "../src/sweep.js";
import type { MailTransport, TransportOutcome } from "../src/transport.js";
import { finishSuccess, processJob, type ClaimedJob, type WorkerDeps } from "../src/worker.js";
import { startWorkerLoop } from "../src/workerLoop.js";
import { workerPoolOptions } from "../src/workerPool.js";

// S7: the heartbeat. Writes to the database, so it only runs against jobs_test (test/guard.setup.ts
// refuses anything else). It touches only rows whose key starts with PREFIX. Mail is a stub or a spy:
// nothing is ever sent. Timers here are short on purpose; waits poll instead of sleeping a fixed time.
const PREFIX = "s7beat-";
const config = loadConfig();
const pool = new pg.Pool({ connectionString: config.databaseUrl });
const message = { to: "nobody@example.invalid", subject: "s", body: "b" };
const backoffCfg = { backoffBaseMs: 50, backoffCapMs: 1000 };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const noop = () => undefined;
let counter = 0;

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
// Stable lost-job warning text (Phase 3 reads logs for it). Same pattern as recheck.test.ts.
const LOST_WARNING = new RegExp(`^WARN worker=\\S+ job=${UUID} lost the job: owner=\\S+ status=\\S+; its result was discarded$`);
// The pinned ownership statement, written out here on purpose: one test checks the S6 re-check AND the
// heartbeat against this literal.
const PINNED = "UPDATE jobs SET locked_at = now() WHERE id = $1 AND locked_by = $2 AND status = 'processing' RETURNING id";
const norm = (s: string) => s.replace(/\s+/g, " ").trim();
const accepted: TransportOutcome = { outcome: "accepted", messageId: "<m>" };

type P = pg.Pool;

function deps(transport: MailTransport, p: P = pool, heartbeatIntervalMs?: number): WorkerDeps {
  return { pool: p, transport, sendTimeoutMs: 1000, uncertainSendPolicy: "flag_for_human", ...backoffCfg, heartbeatIntervalMs };
}

// Every statement sent through the pool, in order. `delay` makes matching statements slow.
function recordingPool(order: string[], delay?: { pattern: RegExp; ms: number }): P {
  return {
    connect: () => pool.connect(),
    query: async (sql: unknown, ...rest: unknown[]) => {
      if (typeof sql === "string") order.push(norm(sql));
      if (delay && typeof sql === "string" && delay.pattern.test(sql)) await sleep(delay.ms);
      return (pool as any).query(sql, ...rest);
    },
  } as unknown as P;
}

// A job that `worker` already holds (processing, its attempt row open), inserted in one statement so a
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

async function waitFor(check: () => boolean | Promise<boolean>, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await sleep(15);
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

describe("S7: the heartbeat keeps a slow job alive", () => {
  it("STUB TEST: a stub transport slower than STUCK_TIMEOUT_MS is NOT reclaimed by the sweep, and the job completes exactly once", async () => {
    // STUB: the transport only sleeps 1500 ms and accepts. STUCK_TIMEOUT_MS is cut to 400 ms for this test.
    const job = await heldJob("w1");
    let calls = 0;
    const transport: MailTransport = {
      send: async () => {
        calls += 1;
        await sleep(1500);
        return accepted;
      },
    };
    let reclaimed = 0;
    const sweepTimer = setInterval(() => {
      sweepStuck(pool, { stuckTimeoutMs: 400, ...backoffCfg }, noop)
        .then((n) => {
          reclaimed += n;
        })
        .catch(noop);
    }, 60);
    const samples: number[] = [];
    const sampler = setInterval(() => {
      pool
        .query("SELECT extract(epoch from locked_at) AS t FROM jobs WHERE id = $1", [job.id])
        .then((r) => {
          if (r.rows[0]?.t) samples.push(Number(r.rows[0].t));
        })
        .catch(noop);
    }, 200);
    const logs: string[] = [];

    await processJob(deps(transport, pool, 50), job, "w1", (l) => logs.push(l));

    clearInterval(sweepTimer);
    clearInterval(sampler);
    await sleep(150); // let a sweep or a sample that was already running finish

    expect(reclaimed).toBe(0); // the sweep never took the job
    expect(calls).toBe(1); // exactly one send
    expect((await jobRow(job.id)).status).toBe("succeeded"); // exactly one completion
    const attempts = await attemptRows(job.id);
    expect(attempts).toHaveLength(1);
    expect(attempts[0].finished_at).not.toBeNull();
    expect(await sentRows(job.id)).toHaveLength(1);
    expect(logs.filter((l) => l.startsWith("WARN"))).toHaveLength(0);
    // locked_at kept advancing during the 1.5 s send (the heartbeat), so it never looked stale
    expect(samples.length).toBeGreaterThanOrEqual(4);
    expect(samples[samples.length - 1]).toBeGreaterThan(samples[0]);
    expect(activeHeartbeats()).toBe(0);
  });

  it("STUB TEST, control: the SAME slow job with NO heartbeat IS reclaimed by the sweep, and the worker finds it lost", async () => {
    const job = await heldJob("w1");
    const transport: MailTransport = {
      send: async () => {
        await sleep(1500);
        return accepted;
      },
    };
    let reclaimed = 0;
    const sweepTimer = setInterval(() => {
      sweepStuck(pool, { stuckTimeoutMs: 400, ...backoffCfg }, noop)
        .then((n) => {
          reclaimed += n;
        })
        .catch(noop);
    }, 60);
    const logs: string[] = [];

    await processJob(deps(transport, pool, undefined), job, "w1", (l) => logs.push(l));

    clearInterval(sweepTimer);
    await sleep(150);
    expect(reclaimed).toBeGreaterThanOrEqual(1);
    const warnings = logs.filter((l) => l.startsWith("WARN"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(LOST_WARNING);
    expect(warnings[0]).toContain("status=failed");
    expect((await jobRow(job.id)).status).toBe("failed"); // the sweep's decision stands; the loser did not overwrite it
  });

  it("ONE test pins both uses: the S6 re-check and every heartbeat beat are exactly the pinned statement", async () => {
    const job = await heldJob("w1");
    const order: string[] = [];
    const transport: MailTransport = {
      send: async () => {
        await sleep(300);
        return accepted;
      },
    };
    await processJob(deps(transport, recordingPool(order), 30), job, "w1", noop);

    const ownership = order.filter((s) => s.includes("SET locked_at = now()"));
    expect(ownership.length).toBeGreaterThanOrEqual(3); // the S6 re-check plus at least two beats
    for (const s of ownership) expect(s).toBe(PINNED);
    expect(norm(OWNERSHIP_SQL)).toBe(PINNED); // and the shared constant is that same text
    expect(order.findIndex((s) => s === PINNED)).toBeLessThan(order.findIndex((s) => s.startsWith("INSERT INTO sent_emails")));
  });
});

describe("S7: a job lost while it is running", () => {
  it("lost DURING the send: warned once while SMTP is still in flight, the mail is recorded as sent, nothing else is written, and a late finish changes zero rows", async () => {
    const job = await heldJob("old");
    let sendReturned = false;
    let calls = 0;
    const transport: MailTransport = {
      send: async () => {
        calls += 1;
        await sleep(600); // SMTP is in flight: nothing can recall it
        sendReturned = true;
        return accepted;
      },
    };
    const logs: string[] = [];
    const attemptsBefore = await attemptRows(job.id);
    const running = processJob(deps(transport, pool, 40), job, "old", (l) => logs.push(l));

    await sleep(120);
    await takeOver(job.id); // the sweep reclaimed it and a new owner holds it
    const afterTakeOver = await jobRow(job.id);
    await waitFor(() => logs.some((l) => l.startsWith("WARN")));
    expect(sendReturned).toBe(false); // the heartbeat found the loss WHILE the send was still in flight
    await running;

    expect(calls).toBe(1); // the one send had already started
    const warnings = logs.filter((l) => l.startsWith("WARN"));
    expect(warnings).toHaveLength(1); // ONE warning in total
    expect(warnings[0]).toMatch(LOST_WARNING);
    expect(warnings[0]).toContain(`job=${job.id}`);
    expect(warnings[0]).toContain("owner=new-owner");
    expect(warnings[0]).toContain("status=processing");

    // what ends up in sent_emails: the mail WAS accepted, so it is recorded as sent
    const sent = await sentRows(job.id);
    expect(sent).toHaveLength(1);
    expect(sent[0].state).toBe("sent");
    expect(sent[0].provider_message_id).toBe("<m>");

    // the loser wrote NOTHING to the job row or the attempt row after the takeover
    expect(await jobRow(job.id)).toEqual(afterTakeOver);
    expect(await attemptRows(job.id)).toEqual(attemptsBefore);

    // a late finish by the worker that lost the job changes zero rows
    expect(await finishSuccess(pool, job, "old")).toBe(false);
    expect(await jobRow(job.id)).toEqual(afterTakeOver);
    expect(activeHeartbeats()).toBe(0);
  });

  it("lost BEFORE the SMTP call: the mail server is never called and no sending row is left behind", async () => {
    const job = await heldJob("old");
    let calls = 0;
    const transport: MailTransport = {
      send: async () => {
        calls += 1;
        return accepted;
      },
    };
    const logs: string[] = [];
    // The insert of the sending row is made slow, which opens a window in which the heartbeat sees the loss.
    const slowPool = recordingPool([], { pattern: /INSERT INTO sent_emails/, ms: 350 });
    const running = processJob(deps(transport, slowPool, 30), job, "old", (l) => logs.push(l));

    await sleep(100);
    await takeOver(job.id);
    const afterTakeOver = await jobRow(job.id);
    await running;

    expect(calls).toBe(0); // zero SMTP calls
    expect(await sentRows(job.id)).toHaveLength(0); // the transient sending row was removed again
    const warnings = logs.filter((l) => l.startsWith("WARN"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(LOST_WARNING);
    expect(warnings[0]).toContain("owner=new-owner");
    expect(await jobRow(job.id)).toEqual(afterTakeOver); // nothing written for the lost job
    expect((await attemptRows(job.id))[0].finished_at).toBeNull();
    expect(activeHeartbeats()).toBe(0);
  });
});

describe("S7: no heartbeat timer outlives its job", () => {
  const stop = async (order: string[]) => {
    const beats = () => order.filter((s) => s === PINNED).length;
    const at = beats();
    await sleep(250); // several intervals later
    expect(beats()).toBe(at); // no beat after the job ended
  };

  it("success", async () => {
    const job = await heldJob("w1");
    const order: string[] = [];
    const transport: MailTransport = { send: async () => (await sleep(200), accepted) };
    await processJob(deps(transport, recordingPool(order), 30), job, "w1", noop);
    expect((await jobRow(job.id)).status).toBe("succeeded");
    expect(activeHeartbeats()).toBe(0);
    await stop(order);
  });

  it("failure (a permanent refusal makes the job dead)", async () => {
    const job = await heldJob("w1");
    const order: string[] = [];
    const transport: MailTransport = { send: async () => (await sleep(150), { outcome: "refused", status: 550, retryable: false }) };
    await processJob(deps(transport, recordingPool(order), 30), job, "w1", noop);
    expect((await jobRow(job.id)).status).toBe("dead");
    expect(activeHeartbeats()).toBe(0);
    await stop(order);
  });

  it("a dropped job (the S6 re-check fails): the heartbeat never even starts", async () => {
    const job = await heldJob("old");
    await takeOver(job.id);
    const order: string[] = [];
    const spy: MailTransport = { send: async () => accepted };
    await processJob(deps(spy, recordingPool(order), 30), job, "old", noop);
    expect(order.filter((s) => s === PINNED)).toHaveLength(1); // only the re-check itself
    expect(activeHeartbeats()).toBe(0);
    await stop(order);
  });

  it("a crash in the finishing handler", async () => {
    const job = await heldJob("w1");
    const crashing = {
      query: (sql: unknown, ...rest: unknown[]) => (pool as any).query(sql, ...rest),
      connect: () => Promise.reject(new Error("simulated crash")),
    } as unknown as P;
    const transport: MailTransport = { send: async () => (await sleep(150), accepted) };
    await expect(processJob(deps(transport, crashing, 30), job, "w1", noop)).rejects.toThrow("simulated crash");
    expect(activeHeartbeats()).toBe(0);
  });

  it("a crash in the failure handler (an unexpected error, then the failure update crashes)", async () => {
    const job = await heldJob("w1");
    const crashing = {
      query: (sql: unknown, ...rest: unknown[]) => (pool as any).query(sql, ...rest),
      connect: () => Promise.reject(new Error("simulated crash")),
    } as unknown as P;
    const transport: MailTransport = {
      send: async () => {
        await sleep(150);
        throw new Error("boom");
      },
    };
    await expect(processJob(deps(transport, crashing, 30), job, "w1", noop)).rejects.toThrow("simulated crash");
    expect(activeHeartbeats()).toBe(0);
  });

  it("a graceful stop of the worker loop waits for the running job, then no timer is left", async () => {
    const order: string[] = [];
    const queued = await enqueueJob(pool, { ownerId: "u", idempotencyKey: `${PREFIX}loop-${Date.now()}`, type: "send_email", payload: message, maxAttempts: 5 });
    if (queued.outcome !== "created") throw new Error("test job not created");
    let sending = false;
    const transport: MailTransport = { send: async () => ((sending = true), await sleep(300), accepted) };
    const loop = startWorkerLoop(deps(transport, recordingPool(order), 30), "w1", { concurrency: 1, pollIntervalMs: 10 }, noop);
    await waitFor(() => sending);
    expect(activeHeartbeats()).toBe(1); // the running job has its heartbeat
    await loop.stop(); // waits for the job to finish
    expect((await jobRow(queued.jobId)).status).toBe("succeeded");
    expect(activeHeartbeats()).toBe(0);
    await stop(order);
  });
});

describe("S7: the worker pool never waits, with the heartbeat running", () => {
  it("N concurrent jobs mid-send (heartbeats, claim loop and sweep all active): the pool queue stays empty and never exceeds max", async () => {
    const N = 5;
    const options = workerPoolOptions(N, 30000); // the real sizing rule: max 14 here
    const p = new pg.Pool({ connectionString: config.databaseUrl, ...options });
    const ids: string[] = [];
    for (let i = 0; i < N; i++) {
      const r = await enqueueJob(pool, { ownerId: "u", idempotencyKey: `${PREFIX}pool-${i}-${Date.now()}`, type: "send_email", payload: message, maxAttempts: 5 });
      if (r.outcome !== "created") throw new Error("test job not created");
      ids.push(r.jobId);
    }
    let inSend = 0;
    let release!: () => void;
    const allIn = new Promise<void>((resolve) => (release = resolve));
    const transport: MailTransport = {
      send: async () => {
        inSend += 1;
        if (inSend === N) release();
        await allIn; // every job waits here until ALL N are mid-send at the same moment
        await sleep(400); // then all N stay mid-send while heartbeats and sweeps keep running
        return accepted;
      },
    };
    let maxWaiting = 0;
    let maxTotal = 0;
    const sampler = setInterval(() => {
      maxWaiting = Math.max(maxWaiting, p.waitingCount);
      maxTotal = Math.max(maxTotal, p.totalCount);
    }, 2);
    const sweepTimer = setInterval(() => {
      sweepStuck(p, { stuckTimeoutMs: 60000, ...backoffCfg }, noop).catch(noop);
    }, 30);
    const loop = startWorkerLoop(deps(transport, p, 20), "w1", { concurrency: N, pollIntervalMs: 10 }, noop);

    await waitFor(async () => {
      const r = await pool.query("SELECT count(*)::int AS n FROM jobs WHERE id = ANY($1) AND status = 'succeeded'", [ids]);
      return r.rows[0].n === N;
    });
    await loop.stop();
    clearInterval(sampler);
    clearInterval(sweepTimer);
    await sleep(100);
    const totalAtEnd = p.totalCount;
    await p.end();

    expect(options.max).toBe(14);
    expect(inSend).toBe(N); // all N really were mid-send together
    expect(maxWaiting).toBe(0); // no request ever queued for a connection
    expect(maxTotal).toBeLessThanOrEqual(options.max);
    expect(totalAtEnd).toBeLessThanOrEqual(options.max);
    expect(activeHeartbeats()).toBe(0);
  });
});

describe("S8 ruling 1a: a heartbeat query that THROWS is not a loss", () => {
  it("logs ONE warning with the job id and a short error class (no address, no message), keeps beating, and the job still succeeds", async () => {
    const job = await heldJob("w1");
    const order: string[] = [];
    let ownershipCalls = 0;
    const base = recordingPool(order);
    // The S6 re-check (the first ownership call) works. Every beat after it throws, with a message that
    // carries an address and a pg-style code.
    const flaky = {
      connect: () => base.connect(),
      query: async (sql: unknown, ...rest: unknown[]) => {
        if (typeof sql === "string" && norm(sql) === PINNED && ++ownershipCalls > 1) {
          throw Object.assign(new Error("connection to nobody@example.invalid reset"), { code: "57P01" });
        }
        return (base as any).query(sql, ...rest);
      },
    } as unknown as P;
    const lines: string[] = [];
    const transport: MailTransport = { send: async () => (await sleep(250), accepted) };
    await processJob(deps(transport, flaky, 30), job, "w1", (l) => lines.push(l));

    const warnings = lines.filter((l) => l.includes("heartbeat failed"));
    expect(warnings).toEqual([`WARN worker=w1 job=${job.id} heartbeat failed: 57P01; will keep trying`]); // once, not per beat
    expect(ownershipCalls).toBeGreaterThan(3); // it kept beating after the first failure
    expect(lines.some((l) => LOST_WARNING.test(l))).toBe(false); // not treated as a loss
    expect(lines.join("\n")).not.toContain("nobody@example.invalid");
    expect((await jobRow(job.id)).status).toBe("succeeded");
    expect(activeHeartbeats()).toBe(0);
  });

  it("errorClassOf gives a code or a name, and never a message", async () => {
    const { errorClassOf } = await import("../src/ownership.js");
    expect(errorClassOf(Object.assign(new Error("secret@x.test"), { code: "ECONNRESET" }))).toBe("ECONNRESET");
    expect(errorClassOf(new TypeError("secret@x.test"))).toBe("TypeError");
    expect(errorClassOf("a@b.test")).toBe("unknown");
    expect(errorClassOf(Object.assign(new Error("x"), { code: "has space@x" }))).toBe("unknown");
  });
});

describe("S9 ruling 1: one line when beating resumes, or when the job ends after failures", () => {
  // Beats number 2.. (the re-check is call 1) throw while `failing(call)` is true.
  function flakyPool(failing: (call: number) => boolean, counter: { calls: number }): P {
    const base = recordingPool([]);
    return {
      connect: () => base.connect(),
      query: async (sql: unknown, ...rest: unknown[]) => {
        if (typeof sql === "string" && norm(sql) === PINNED && ++counter.calls > 1 && failing(counter.calls)) {
          throw Object.assign(new Error("connection to nobody@example.invalid reset"), { code: "57P01" });
        }
        return (base as any).query(sql, ...rest);
      },
    } as unknown as P;
  }

  it("beating resumes after 3 failed beats: one 'heartbeat recovered after 3 failed beats' line, one failure warning, job succeeds", async () => {
    const job = await heldJob("w1");
    const counter = { calls: 0 };
    const lines: string[] = [];
    const transport: MailTransport = { send: async () => (await sleep(400), accepted) };
    await processJob(deps(transport, flakyPool((c) => c >= 2 && c <= 4, counter), 30), job, "w1", (l) => lines.push(l));

    expect(lines.filter((l) => l.includes("heartbeat failed"))).toHaveLength(1);
    expect(lines.filter((l) => l.includes("heartbeat recovered"))).toEqual([
      `worker=w1 job=${job.id} heartbeat recovered after 3 failed beats`,
    ]);
    expect(lines.some((l) => LOST_WARNING.test(l))).toBe(false);
    expect(lines.join("\n")).not.toContain("nobody@example.invalid");
    expect((await jobRow(job.id)).status).toBe("succeeded");
    expect(activeHeartbeats()).toBe(0);
  });

  it("the job ends while beats are still failing: the same line is logged once, with the number of failed beats", async () => {
    const job = await heldJob("w1");
    const counter = { calls: 0 };
    const lines: string[] = [];
    const transport: MailTransport = { send: async () => (await sleep(250), accepted) };
    await processJob(deps(transport, flakyPool(() => true, counter), 30), job, "w1", (l) => lines.push(l));

    const recovered = lines.filter((l) => l.includes("heartbeat recovered"));
    expect(recovered).toHaveLength(1);
    const n = counter.calls - 1; // every call after the re-check failed
    expect(n).toBeGreaterThanOrEqual(3);
    expect(recovered[0]).toBe(`worker=w1 job=${job.id} heartbeat recovered after ${n} failed beats`);
    expect((await jobRow(job.id)).status).toBe("succeeded");
  });

  it("no failed beats means no recovered line", async () => {
    const job = await heldJob("w1");
    const lines: string[] = [];
    const transport: MailTransport = { send: async () => (await sleep(150), accepted) };
    await processJob(deps(transport, pool, 30), job, "w1", (l) => lines.push(l));
    expect(lines.some((l) => l.includes("heartbeat"))).toBe(false);
  });
});
