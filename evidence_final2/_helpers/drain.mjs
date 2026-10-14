// One-off: complete the pre-existing leftover runnable jobs (from the earlier phase) using a normal
// worker, so they cannot pollute the fresh evidence run. Non-destructive: schema untouched, no rows
// edited, no reset. Uses the real worker path with the fake transport.
import { newPool, startWorker, hardKill, waitFor, counts, sleep, dbName } from "./lib.mjs";

const pool = newPool();
console.log("DB:", dbName());
console.log("BEFORE:", JSON.stringify(await counts(pool)));

const worker = startWorker({}, "drain-worker.log");
console.log("worker pid:", worker.pid);

try {
  await waitFor(
    async () => {
      const c = await counts(pool);
      return (c.pending || 0) + (c.failed || 0) + (c.processing || 0) === 0;
    },
    { timeoutMs: 90000, intervalMs: 1000, label: "no runnable jobs" },
  );
  console.log("RESULT: drained");
} catch (e) {
  console.log("RESULT: drain error:", e.message);
}

hardKill(worker);
await sleep(700);
console.log("AFTER:", JSON.stringify(await counts(pool)));
await pool.end();
process.exit(0);
