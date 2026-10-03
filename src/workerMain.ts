import { hostname } from "node:os";
import pg from "pg";
import { loadWorkerConfig } from "./config.js";
import { FakeTransport } from "./transport.js";
import { runOne } from "./worker.js";

const MAILBOX_PATH = ".fake-mailbox.jsonl";

// MAIL_TRANSPORT defaults to fake and the real transport does not exist before S8 (RULES 27).
if ((process.env.MAIL_TRANSPORT ?? "fake") !== "fake") {
  throw new Error("Only MAIL_TRANSPORT=fake exists before step 8");
}

const config = loadWorkerConfig();
const pool = new pg.Pool({ connectionString: config.databaseUrl });
const workerId = `${hostname()}-${process.pid}`;
const transport = new FakeTransport(MAILBOX_PATH, config.fakeSendDelayMs, config.forceFail);
const deps = {
  pool,
  transport,
  sendTimeoutMs: config.sendTimeoutMs,
  uncertainSendPolicy: config.uncertainSendPolicy,
  backoffBaseMs: config.backoffBaseMs,
  backoffCapMs: config.backoffCapMs,
};
const log = (line: string) => console.log(line);

log(`worker=${workerId} started`);
for (;;) {
  const didWork = await runOne(deps, workerId, log);
  if (!didWork) await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs));
}
