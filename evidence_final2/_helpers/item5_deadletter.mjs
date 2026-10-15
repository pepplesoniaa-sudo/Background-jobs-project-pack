// Item 5: the dead-letter view with at least one job. Creates a fresh dead job through the real worker
// path, then reads the dead-letter data through the real admin route (x-admin-token from .env; the token
// is never printed). Also saves the served HTML page.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadWebConfig } from "../../src/config.ts";
import { startWorker, hardKill, waitFor, counts, sleep, dbName, OUT } from "./lib.mjs";
import { makePool, makeApp, enqueue, getDeadJobs } from "./app.mjs";

const pool = makePool();
const app = makeApp(pool);
await app.ready();
const { adminToken } = loadWebConfig();
const lines = [];
const say = (s) => { console.log(s); lines.push(s); };

const P = "evid3-e5-";
const key = P + "deadletter";

say(`DB: ${dbName()}`);
say(`BEFORE counts: ${JSON.stringify(await counts(pool))}`);

const w = startWorker(
  {
    FORCE_FAIL: "true",
    UNCERTAIN_SEND_POLICY: "flag_for_human",
    FAKE_SEND_DELAY_MS: "0",
    SEND_TIMEOUT_MS: "30000",
    STUCK_TIMEOUT_MS: "90000",
    HEARTBEAT_INTERVAL_MS: "10000",
    SWEEP_INTERVAL_MS: "5000",
    POLL_INTERVAL_MS: "100",
    WORKER_CONCURRENCY: "5",
    BACKOFF_BASE_MS: "500",
    BACKOFF_CAP_MS: "1000",
  },
  "item5-worker.log",
);
await sleep(1200);
const r = await enqueue(app, {
  payload: { to: "deadletter@example.invalid", subject: "Your weekly digest", body: "Hello, this is the weekly digest." },
  idempotencyKey: key,
});
say(`enqueue status=${r.status} id=${r.body?.id}`);
await waitFor(async () => (await pool.query(`SELECT status FROM jobs WHERE idempotency_key=$1`, [key])).rows[0]?.status === "dead", { timeoutMs: 20000, intervalMs: 150, label: "job dead" });
hardKill(w);
await sleep(400);
const mine = (await pool.query(`SELECT id, status, attempts, last_error FROM jobs WHERE idempotency_key=$1`, [key])).rows[0];
say(`my dead job: id=${mine.id} status=${mine.status} attempts=${mine.attempts} last_error="${mine.last_error}"`);

say("");
say(`GET /api/admin/dead-jobs  (header x-admin-token: ****  -- read from .env, ${adminToken.length} chars, not printed)`);
const dj = await getDeadJobs(app, adminToken);
say(`HTTP ${dj.status}; total dead jobs = ${dj.body.total}; listed = ${dj.body.jobs.length}`);
say("");
say("Dead-letter rows (id8, attempts, email state, masked recipient, subject, jobRef, lastError):");
for (const j of dj.body.jobs) {
  const mark = j.id === mine.id ? "  <== created for this item" : "";
  say(`  ${j.id.slice(0, 8)}  att ${j.attempts}/${j.maxAttempts}  email=${j.sentState ?? "none"}  to=${j.payload?.to}  subj="${(j.payload?.subject ?? "").slice(0, 30)}"  ref=${j.jobRef}  err="${(j.lastError ?? "").slice(0, 40)}"${mark}`);
}

say("");
const mineView = dj.body.jobs.find((j) => j.id === mine.id);
say("The dead-letter entry for the job created above (full record):");
say(JSON.stringify(mineView, null, 2));

const html = await app.inject({ method: "GET", url: "/admin/dead" });
writeFileSync(join(OUT, "admin_dead_page.html"), html.body);
say("");
say(`GET /admin/dead -> HTTP ${html.statusCode}, ${html.body.length} bytes (saved to admin_dead_page.html)`);

writeFileSync(join(OUT, "item5_deadletter.txt"), lines.join("\n") + "\n");
writeFileSync(join(OUT, "item5_dead_jobs_api.json"), JSON.stringify(dj.body, null, 2) + "\n");
console.log("written item5_deadletter.txt and item5_dead_jobs_api.json");
await app.close();
await pool.end();
process.exit(0);
