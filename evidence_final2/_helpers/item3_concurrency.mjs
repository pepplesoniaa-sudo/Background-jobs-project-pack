// Item 3: enqueue 50 jobs and prove the worker's concurrency cap (5 per process) holds.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startWorker, hardKill, waitFor, counts, sleep, dbName, OUT } from "./lib.mjs";
import { makePool, makeApp, enqueue } from "./app.mjs";

const N = 50;
const PREFIX = "evid3-conc-";
const pool = makePool();
const app = makeApp(pool);
await app.ready();
const lines = [];
const say = (s) => { console.log(s); lines.push(s); };

say(`DB: ${dbName()}`);
say(`BEFORE counts: ${JSON.stringify(await counts(pool))}`);

const worker = startWorker(
  {
    WORKER_CONCURRENCY: "5",
    FAKE_SEND_DELAY_MS: "800",
    SEND_TIMEOUT_MS: "10000",
    STUCK_TIMEOUT_MS: "30000",
    HEARTBEAT_INTERVAL_MS: "5000",
    SWEEP_INTERVAL_MS: "1000",
    POLL_INTERVAL_MS: "100",
    UNCERTAIN_SEND_POLICY: "resend",
    BACKOFF_BASE_MS: "2000",
    BACKOFF_CAP_MS: "300000",
  },
  "item3-worker.log",
);
say(`worker pid=${worker.pid} WORKER_CONCURRENCY=5 FAKE_SEND_DELAY_MS=800`);
await sleep(1500);

const ids = [];
for (let i = 0; i < N; i++) {
  const r = await enqueue(app, {
    payload: { to: `user${i}@example.invalid`, subject: `conc ${i}`, body: "concurrency" },
    idempotencyKey: `${PREFIX}${i}`,
  });
  if (r.status !== 202 && r.status !== 200) say(`enqueue ${i} status=${r.status} body=${JSON.stringify(r.body)}`);
  ids.push(r.body?.id);
}
say(`enqueued ${ids.length} jobs (POST /api/jobs, x-user-id=evidence2)`);

const samples = [];
let sampling = true;
const sampler = (async () => {
  while (sampling) {
    const r = await pool.query(
      `SELECT count(*)::int AS n FROM jobs WHERE status='processing' AND idempotency_key LIKE $1`,
      [`${PREFIX}%`],
    );
    samples.push({ t: new Date().toISOString(), n: r.rows[0].n });
    await sleep(200);
  }
})();

await waitFor(
  async () => {
    const r = await pool.query(
      `SELECT count(*)::int AS n FROM jobs WHERE idempotency_key LIKE $1 AND status='succeeded'`,
      [`${PREFIX}%`],
    );
    return r.rows[0].n >= N;
  },
  { timeoutMs: 60000, intervalMs: 200, label: "all 50 succeeded" },
);
sampling = false;
await sampler;

hardKill(worker);
await sleep(500);

const maxSeen = Math.max(...samples.map((s) => s.n));
say(`samples=${samples.length}`);
say(`MAX_CONCURRENT_PROCESSING_SEEN=${maxSeen}`);
say(`samples_at_cap_5=${samples.filter((s) => s.n === 5).length}`);
say(`final_counts=${JSON.stringify(await counts(pool))}`);
say("processing-count series (iso_time  processing):");
for (const s of samples) say(`  ${s.t}  ${s.n}`);

let logText = "";
try {
  logText = readFileSync(join(OUT, "item3-worker.log"), "utf8");
} catch {}
const seen = [...logText.matchAll(/max_seen=(\d+)/g)].map((m) => Number(m[1]));
say(`worker_log_max_seen=${seen.length ? Math.max(...seen) : "n/a"}`);

writeFileSync(join(OUT, "item3_concurrency.txt"), lines.join("\n") + "\n");
console.log("written item3_concurrency.txt");
await app.close();
await pool.end();
process.exit(0);
