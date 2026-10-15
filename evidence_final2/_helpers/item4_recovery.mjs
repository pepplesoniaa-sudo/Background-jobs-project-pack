// Item 4: a worker is hard-killed while a job is mid-send. Show the three states of that one job:
//   (A) sitting 'processing' with an old lock and a 'sending' email row (what a rescue needs),
//   (B) the sweep recovers it to 'failed' ("stuck: worker lost or slow"),
//   (C) it is retried and finishes 'succeeded'.
// Kill is a hard kill (Stop-Process / SIGKILL): on Windows signal handlers do NOT run.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { startWorker, hardKill, waitFor, counts, sleep, dbName, OUT } from "./lib.mjs";
import { makePool, makeApp, enqueue } from "./app.mjs";

const pool = makePool();
const app = makeApp(pool);
await app.ready();
const lines = [];
const say = (s) => { console.log(s); lines.push(s); };

const P = "evid3-e4-";
const key = P + "stuck";
const cfg = {
  SEND_TIMEOUT_MS: "2000",
  FAKE_SEND_DELAY_MS: "1500",
  STUCK_TIMEOUT_MS: "6000",
  HEARTBEAT_INTERVAL_MS: "2000",
  SWEEP_INTERVAL_MS: "1000",
  POLL_INTERVAL_MS: "200",
  WORKER_CONCURRENCY: "1",
  UNCERTAIN_SEND_POLICY: "resend",
  BACKOFF_BASE_MS: "2000",
  BACKOFF_CAP_MS: "4000",
};
const STUCK = 6000;
const tz = (d) => (d ? new Date(d).toISOString().replace("T", " ").slice(0, 19) : "(null)");
const js = async () => (await pool.query(`SELECT * FROM jobs WHERE idempotency_key=$1`, [key])).rows[0];
const se = async () => (await pool.query(`SELECT state, provider_message_id FROM sent_emails WHERE job_id=(SELECT id FROM jobs WHERE idempotency_key=$1)`, [key])).rows[0];

say(`DB: ${dbName()}`);
say(`BEFORE counts: ${JSON.stringify(await counts(pool))}`);
say("config: FAKE_SEND_DELAY_MS=1500  SEND_TIMEOUT_MS=2000  STUCK_TIMEOUT_MS=6000  HEARTBEAT_INTERVAL_MS=2000  WORKER_CONCURRENCY=1  UNCERTAIN_SEND_POLICY=resend");

const workerA = startWorker(cfg, "item4-worker.log");
await sleep(1200);
const r = await enqueue(app, { payload: { to: "recover@example.invalid", subject: "e4 stuck", body: "x" }, idempotencyKey: key });
say(`enqueue status=${r.status} id=${r.body?.id}`);

await waitFor(async () => { const j = await js(); const s = await se(); return j?.status === "processing" && s?.state === "sending"; }, { timeoutMs: 10000, intervalMs: 50, label: "processing+sending" });
const a = await js();
const ase = await se();
say("");
say("(A) worker A is mid-send. Hard-killing it now (SIGKILL).");
say(`    status=${a.status} attempts=${a.attempts} locked_by=${a.locked_by} locked_at=${tz(a.locked_at)} started_at=${tz(a.started_at)}`);
say(`    sent_emails.state=${ase.state}`);
const deadWorkerId = a.locked_by;
hardKill(workerA);
await sleep(400);

const b = await js();
const bse = await se();
say("");
say("STATE 1 - the stuck job (worker A is dead, nothing refreshed the lock):");
say(`    status=${b.status} attempts=${b.attempts} locked_by=${b.locked_by} locked_at=${tz(b.locked_at)}`);
say(`    sent_emails.state=${bse.state}  (unknown outcome: the send was interrupted)`);
say(`    worker A id was ${deadWorkerId}; it is gone (hard kill).`);

const lockMs = new Date(b.locked_at).getTime();
const wait = lockMs + STUCK + 800 - Date.now();
if (wait > 0) await sleep(wait);
const ageS = ((Date.now() - lockMs) / 1000).toFixed(1);
say(`    lock age is now ${ageS}s (>= STUCK_TIMEOUT_MS=${STUCK}) => the sweep may reclaim it.`);

say("");
say("Starting worker B (same config). Its periodic sweep should recover the stuck job.");
const workerB = startWorker(cfg, "item4-worker.log");
let sawFailed = false;
await waitFor(
  async () => {
    const j = await js();
    if (j?.status === "failed" && !sawFailed) {
      sawFailed = true;
      say("");
      say("STATE 2 - recovered by the sweep to 'failed':");
      say(`    status=${j.status} attempts=${j.attempts} run_at=${tz(j.run_at)} locked_by=${j.locked_by || "(null)"} last_error="${j.last_error}"`);
    }
    return j?.status === "succeeded";
  },
  { timeoutMs: 40000, intervalMs: 50, label: "recovered to succeeded" },
);
hardKill(workerB);
await sleep(400);

const f = await js();
const fse = await se();
say("");
say("STATE 3 - retried and finished:");
say(`    status=${f.status} attempts=${f.attempts} finished_at=${tz(f.finished_at)} locked_by=${f.locked_by || "(null)"}`);
say(`    sent_emails.state=${fse.state} provider_message_id=${fse.provider_message_id ? "(set)" : "(none)"}`);
say("");
const attempts = (await pool.query(`SELECT attempt_no, worker_id, started_at, finished_at, backoff_bound_ms, delay_ms, error FROM job_attempts WHERE job_id=$1 ORDER BY attempt_no`, [f.id])).rows;
say("job_attempts history for this job:");
say("#  worker_id                  started(UTC)          finished(UTC)         bound_ms  delay_ms  error");
for (const x of attempts) {
  say(`${String(x.attempt_no).padEnd(2)} ${String(x.worker_id).padEnd(26)} ${tz(x.started_at)}  ${(x.finished_at ? tz(x.finished_at) : "(not finished)")}  ${String(x.backoff_bound_ms ?? "-").padEnd(8)}  ${String(x.delay_ms ?? "-").padEnd(8)}  ${x.error || "ok"}`);
}
say("");
say(`saw the intermediate 'failed' state: ${sawFailed}`);
say(`AFTER counts: ${JSON.stringify(await counts(pool))}`);

writeFileSync(join(OUT, "item4_stuck_recovery.txt"), lines.join("\n") + "\n");
console.log("written item4_stuck_recovery.txt");
await app.close();
await pool.end();
process.exit(0);
