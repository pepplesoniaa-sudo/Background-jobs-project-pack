import { hostname } from "node:os";
import pg from "pg";
import { loadWorkerConfig } from "./config.js";
import { SmtpTransport, smtpOptions } from "./smtpTransport.js";
import { FakeTransport, type MailTransport } from "./transport.js";
import { sweepStuck } from "./sweep.js";
import { createShutdownHandler, SHUTDOWN_SIGNALS } from "./shutdown.js";
import { workerPoolOptions } from "./workerPool.js";
import { startWorkerLoop } from "./workerLoop.js";

const MAILBOX_PATH = ".fake-mailbox.jsonl";

const config = loadWorkerConfig();
// Sized for two connections per running job (statements and heartbeat), the claim loop and the sweep,
// with a connection timeout so that exhaustion is an error and not an endless wait. See workerPool.ts.
const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  ...workerPoolOptions(config.workerConcurrency, config.sendTimeoutMs),
});
const workerId = `${hostname()}-${process.pid}`;
// MAIL_TRANSPORT defaults to fake. The real one runs only when it is set to "real" (RULES 27).
const transport: MailTransport = config.smtp
  ? new SmtpTransport(smtpOptions(config.smtp, config.sendTimeoutMs), config.smtp.from)
  : new FakeTransport(MAILBOX_PATH, config.fakeSendDelayMs, config.forceFail);
const deps = {
  pool,
  transport,
  sendTimeoutMs: config.sendTimeoutMs,
  uncertainSendPolicy: config.uncertainSendPolicy,
  backoffBaseMs: config.backoffBaseMs,
  backoffCapMs: config.backoffCapMs,
  heartbeatIntervalMs: config.heartbeatIntervalMs,
};
const log = (line: string) => console.log(line);

// Every worker sweeps. SKIP LOCKED keeps two sweeps from touching the same job.
let sweeping = false;
const sweepTimer = setInterval(async () => {
  if (sweeping) return;
  sweeping = true;
  try {
    await sweepStuck(pool, config, log);
  } catch {
    log(`WARN worker=${workerId} sweep failed`);
  } finally {
    sweeping = false;
  }
}, config.sweepIntervalMs);

log(`worker=${workerId} started concurrency=${config.workerConcurrency} transport=${config.mailTransport}`);
const loop = startWorkerLoop(
  deps,
  workerId,
  { concurrency: config.workerConcurrency, pollIntervalMs: config.pollIntervalMs },
  log,
);

// Graceful stop: stop claiming, give running jobs up to SEND_TIMEOUT_MS, leave the rest to the sweep.
// A second signal exits at once. See shutdown.ts.
const shutdown = createShutdownHandler({
  workerId,
  loop,
  timeoutMs: config.sendTimeoutMs,
  stopTimers: () => clearInterval(sweepTimer),
  closePool: () => pool.end(),
  exit: (code) => process.exit(code),
  log,
});
for (const signal of SHUTDOWN_SIGNALS) process.on(signal, () => void shutdown(signal));
