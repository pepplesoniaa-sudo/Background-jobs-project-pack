// Item 1: show the jobs table with one freshly created job in every status (pending, processing,
// succeeded, failed, dead). Each status is produced by the real worker path, not by editing rows.
// The "processing" and "pending" jobs are captured in the same instant: one worker, concurrency 1,
// busy sending the processing job, so the pending job waits behind it.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { startWorker, hardKill, waitFor, counts, sleep, dbName, OUT } from "./lib.mjs";
import { makePool, makeApp, enqueue } from "./app.mjs";

const pool = makePool();
const app = makeApp(pool);
await app.ready();
const lines = [];
const say = (s) => { console.log(s); lines.push(s); };

const P = "evid3-e1-";
const jobRow = async (key) => (await pool.query(`SELECT * FROM jobs WHERE idempotency_key=$1`, [P + key])).rows[0];
const wk = {
  SEND_TIMEOUT_MS: "30000",
  STUCK_TIMEOUT_MS: "90000",
  HEARTBEAT_INTERVAL_MS: "5000",
  SWEEP_INTERVAL_MS: "5000",
  BACKOFF_CAP_MS: "300000",
};

say(`DB: ${dbName()}`);
say(`BEFORE counts: ${JSON.stringify(await counts(pool))}`);

// Phase 1 - succeeded
{
  const w = startWorker({ ...wk, WORKER_CONCURRENCY: "5", FAKE_SEND_DELAY_MS: "0", POLL_INTERVAL_MS: "200", UNCERTAIN_SEND_POLICY: "resend", BACKOFF_BASE_MS: "2000" }, "item1-worker.log");
  await sleep(1200);
  const r = await enqueue(app, { payload: { to: "success@example.invalid", subject: "e1 success", body: "ok" }, idempotencyKey: P + "succ" });
  say(`phase1 (succeeded) enqueue status=${r.status} id=${r.body?.id}`);
  await waitFor(async () => (await jobRow("succ"))?.status === "succeeded", { timeoutMs: 20000, intervalMs: 200, label: "succ succeeded" });
  hardKill(w);
  await sleep(400);
}

// Phase 2 - dead (fake provider refuses every attempt; flag_for_human turns the 2nd attempt into a permanent stop)
{
  const w = startWorker({ ...wk, WORKER_CONCURRENCY: "5", FORCE_FAIL: "true", UNCERTAIN_SEND_POLICY: "flag_for_human", FAKE_SEND_DELAY_MS: "0", POLL_INTERVAL_MS: "100", BACKOFF_BASE_MS: "500", BACKOFF_CAP_MS: "1000" }, "item1-worker.log");
  await sleep(1200);
  const r = await enqueue(app, { payload: { to: "dead@example.invalid", subject: "e1 dead", body: "x" }, idempotencyKey: P + "dead" });
  say(`phase2 (dead) enqueue status=${r.status} id=${r.body?.id}`);
  await waitFor(async () => (await jobRow("dead"))?.status === "dead", { timeoutMs: 20000, intervalMs: 150, label: "dead" });
  hardKill(w);
  await sleep(400);
}

// Phase 3 - failed (one retryable failure, long backoff so it is still 'failed' at snapshot time)
{
  const w = startWorker({ ...wk, WORKER_CONCURRENCY: "5", FORCE_FAIL: "true", UNCERTAIN_SEND_POLICY: "flag_for_human", FAKE_SEND_DELAY_MS: "0", POLL_INTERVAL_MS: "100", BACKOFF_BASE_MS: "15000", BACKOFF_CAP_MS: "30000" }, "item1-worker.log");
  await sleep(1200);
  const r = await enqueue(app, { payload: { to: "failed@example.invalid", subject: "e1 failed", body: "x" }, idempotencyKey: P + "failed" });
  say(`phase3 (failed) enqueue status=${r.status} id=${r.body?.id}`);
  await waitFor(async () => (await jobRow("failed"))?.status === "failed", { timeoutMs: 20000, intervalMs: 100, label: "failed" });
  hardKill(w);
  await sleep(400);
  const j = await jobRow("failed");
  say(`phase3 result: status=${j.status} attempts=${j.attempts} run_at=${new Date(j.run_at).toISOString()} last_error="${j.last_error}"`);
}

// Phase 4 - processing + pending, captured together
{
  const w = startWorker({ ...wk, WORKER_CONCURRENCY: "1", FAKE_SEND_DELAY_MS: "15000", POLL_INTERVAL_MS: "200", UNCERTAIN_SEND_POLICY: "resend", BACKOFF_BASE_MS: "2000" }, "item1-worker.log");
  await sleep(1500);
  const rp = await enqueue(app, { payload: { to: "processing@example.invalid", subject: "e1 processing", body: "x" }, idempotencyKey: P + "proc" });
  say(`phase4 enqueue processing status=${rp.status} id=${rp.body?.id}`);
  await waitFor(async () => (await jobRow("proc"))?.status === "processing", { timeoutMs: 15000, intervalMs: 100, label: "proc processing" });
  const rpend = await enqueue(app, { payload: { to: "pending@example.invalid", subject: "e1 pending", body: "x" }, idempotencyKey: P + "pend" });
  say(`phase4 enqueue pending status=${rpend.status} id=${rpend.body?.id}`);
  await sleep(700);

  const rows = (await pool.query(`SELECT * FROM jobs WHERE idempotency_key LIKE $1 ORDER BY created_at`, [P + "%"])).rows;
  const f = (d) => (d ? new Date(d).toISOString().replace("T", " ").slice(0, 19) : "(null)");
  say("");
  say("SNAPSHOT - the 5 fresh jobs (one per status), captured while the single worker is mid-send on 'proc':");
  say("id(8)     key       status       att/max  run_at                        locked_by                                locked_at                     last_error");
  for (const row of rows) {
    say(
      `${row.id.slice(0, 8)}   ${row.idempotency_key.replace(P, "").padEnd(8)} ${row.status.padEnd(12)} ${(row.attempts + "/" + row.max_attempts).padEnd(8)} ${f(row.run_at).padEnd(29)} ${String(row.locked_by || "(null)").padEnd(40)} ${f(row.locked_at).padEnd(29)} ${(row.last_error || "").slice(0, 45)}`,
    );
  }
  const c = {};
  for (const row of rows) c[row.status] = (c[row.status] || 0) + 1;
  say("");
  say(`STATUS COUNTS among the 5 fresh jobs: ${JSON.stringify(c)}`);
  say(`HAS ALL FIVE STATUSES: ${["pending", "processing", "succeeded", "failed", "dead"].every((s) => (c[s] || 0) >= 1)}`);

  hardKill(w);
  await sleep(400);
  say("phase4 worker killed mid-send (the 'proc' job now stays 'processing' until a sweep recovers it).");
}

say("");
say(`AFTER counts (all jobs, incl. history): ${JSON.stringify(await counts(pool))}`);
writeFileSync(join(OUT, "item1_all_statuses.txt"), lines.join("\n") + "\n");
console.log("written item1_all_statuses.txt");
await app.close();
await pool.end();
process.exit(0);
