// Reusable cleanup: flush any leftover runnable/locked jobs so the next item starts clean.
// Uses the real worker with resend policy and a short stuck timeout so even a killed mid-send job recovers.
import { startWorker, hardKill, waitFor, counts, sleep, dbName, newPool } from "./lib.mjs";

const pool = newPool();
console.log("cleanup DB:", dbName());
console.log("cleanup before:", JSON.stringify(await counts(pool)));

const w = startWorker(
  {
    SEND_TIMEOUT_MS: "1000",
    FAKE_SEND_DELAY_MS: "0",
    STUCK_TIMEOUT_MS: "5000",
    HEARTBEAT_INTERVAL_MS: "1000",
    SWEEP_INTERVAL_MS: "1000",
    POLL_INTERVAL_MS: "300",
    WORKER_CONCURRENCY: "5",
    UNCERTAIN_SEND_POLICY: "resend",
    BACKOFF_BASE_MS: "1000",
    BACKOFF_CAP_MS: "2000",
  },
  "cleanup-worker.log",
);
try {
  await waitFor(
    async () => {
      const c = await counts(pool);
      return (c.pending || 0) + (c.failed || 0) + (c.processing || 0) === 0;
    },
    { timeoutMs: 90000, intervalMs: 500, label: "no runnable jobs" },
  );
  console.log("cleanup: drained");
} catch (e) {
  console.log("cleanup error:", e.message);
}
hardKill(w);
await sleep(500);
console.log("cleanup after:", JSON.stringify(await counts(pool)));
await pool.end();
process.exit(0);
