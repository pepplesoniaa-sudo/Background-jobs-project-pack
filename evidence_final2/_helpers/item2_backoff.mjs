// Item 2: prove the retry delay grows between attempts. The fake provider is forced to fail, and the
// resend policy keeps retrying the unknown outcome, so the job walks attempts 1..5. Each attempt row
// records backoff_bound_ms and delay_ms (the equal-jitter delay actually chosen). The job dies at attempt 5.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { startWorker, hardKill, waitFor, counts, sleep, dbName, OUT } from "./lib.mjs";
import { makePool, makeApp, enqueue } from "./app.mjs";

const pool = makePool();
const app = makeApp(pool);
await app.ready();
const lines = [];
const say = (s) => { console.log(s); lines.push(s); };

const P = "evid3-e2-";
const key = P + "backoff";
const row = async () => (await pool.query(`SELECT * FROM jobs WHERE idempotency_key=$1`, [key])).rows[0];

say(`DB: ${dbName()}`);
say(`BEFORE counts: ${JSON.stringify(await counts(pool))}`);
say("config: BACKOFF_BASE_MS=2000  BACKOFF_CAP_MS=300000  UNCERTAIN_SEND_POLICY=resend  FORCE_FAIL=true  MAX_ATTEMPTS=5");

const w = startWorker(
  {
    FORCE_FAIL: "true",
    UNCERTAIN_SEND_POLICY: "resend",
    BACKOFF_BASE_MS: "2000",
    BACKOFF_CAP_MS: "300000",
    FAKE_SEND_DELAY_MS: "0",
    SEND_TIMEOUT_MS: "30000",
    STUCK_TIMEOUT_MS: "90000",
    HEARTBEAT_INTERVAL_MS: "10000",
    SWEEP_INTERVAL_MS: "5000",
    POLL_INTERVAL_MS: "100",
    WORKER_CONCURRENCY: "5",
  },
  "item2-worker.log",
);
await sleep(1200);
const r = await enqueue(app, { payload: { to: "backoff@example.invalid", subject: "e2 backoff", body: "x" }, idempotencyKey: key });
say(`enqueue status=${r.status} id=${r.body?.id}`);

await waitFor(async () => (await row())?.status === "dead", { timeoutMs: 90000, intervalMs: 250, label: "job dead after exhausting attempts" });
hardKill(w);
await sleep(400);

const j = await row();
say(`FINAL: status=${j.status} attempts=${j.attempts} max_attempts=${j.max_attempts} last_error="${j.last_error}"`);
say("");

const attempts = (await pool.query(
  `SELECT attempt_no, worker_id, started_at, finished_at, backoff_bound_ms, delay_ms, error
   FROM job_attempts WHERE job_id=$1 ORDER BY attempt_no`,
  [j.id],
)).rows;

say("job_attempts rows for this job (bound = min(cap, base*2^(attempt-1)); delay = bound/2 + random*bound/2):");
say("#  started(UTC)          finished(UTC)         bound_ms   delay_ms   gap_prev_finish_to_this_start_ms   error");
let prevFinish = null;
for (const a of attempts) {
  const start = new Date(a.started_at);
  const fin = a.finished_at ? new Date(a.finished_at) : null;
  const gap = prevFinish ? start.getTime() - prevFinish.getTime() : "";
  say(
    `${String(a.attempt_no).padEnd(2)} ${a.started_at.toISOString().replace("T", " ").slice(0, 19)}  ${(fin ? fin.toISOString().replace("T", " ").slice(0, 19) : "(not finished)")}  ${String(a.backoff_bound_ms ?? "-").padEnd(9)}  ${String(a.delay_ms ?? "-").padEnd(8)}  ${String(gap).padEnd(34)}  ${a.error || "ok"}`,
  );
  prevFinish = fin;
}
writeFileSync(join(OUT, "item2_backoff.txt"), lines.join("\n") + "\n");
console.log("written item2_backoff.txt");
await app.close();
await pool.end();
process.exit(0);
