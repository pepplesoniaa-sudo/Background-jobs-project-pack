import { createHash } from "node:crypto";
import pg from "pg";
import type SMTPTransport from "nodemailer/lib/smtp-transport/index.js";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, loadWorkerConfig } from "../src/config.js";
import { enqueueJob } from "../src/enqueue.js";
import { SmtpTransport, classifySmtpError, smtpOptions } from "../src/smtpTransport.js";
import { runOne, type WorkerDeps } from "../src/worker.js";
import { startFakeSmtp, type FakeSmtp, type SmtpBehavior } from "./helpers/fakeSmtp.js";

// The SMTP transport is tested against a scripted local server only. No real mail is sent.
const PREFIX = "s8test-";
const config = loadConfig();
const pool = new pg.Pool({ connectionString: config.databaseUrl });
const ADDRESS = "nobody@example.invalid";
const FROM = "Sender <sender@example.invalid>";
const SECRET_PASSWORD = "very-secret-password-value";
const message = { to: ADDRESS, subject: "hello subject", body: "hello body" };
const TIMEOUT_MS = 500;

let server: FakeSmtp | null = null;
let counter = 0;

async function start(behavior: SmtpBehavior = {}) {
  server = await startFakeSmtp(behavior);
  return server;
}

// Options for the local test server: no TLS (it has none), short timeouts.
function options(port: number): SMTPTransport.Options {
  return {
    host: "127.0.0.1",
    port,
    secure: false,
    ignoreTLS: true,
    auth: { user: "user", pass: SECRET_PASSWORD },
    connectionTimeout: TIMEOUT_MS,
    greetingTimeout: TIMEOUT_MS,
    socketTimeout: TIMEOUT_MS,
  };
}

const sendOpts = { idempotencyKey: "0765bf9f-07ee-45ef-9b45-39af6173e08d", timeoutMs: TIMEOUT_MS };

afterEach(async () => {
  await server?.close();
  server = null;
});

describe("SmtpTransport against a scripted server", () => {
  it("accepted: returns the message id and the server holds one message addressed correctly", async () => {
    const s = await start();
    const out = await new SmtpTransport(options(s.port), FROM).send(message, sendOpts);
    expect(out.outcome).toBe("accepted");
    expect(s.messages).toHaveLength(1);
    expect(s.recipients).toEqual([ADDRESS]);
  });

  it("puts X-Job-Ref and a ref-based Message-ID in the email, and the raw job id in no header", async () => {
    const s = await start();
    const out = await new SmtpTransport(options(s.port), FROM).send(message, sendOpts);
    const raw = s.messages[0];
    const ref = createHash("sha256").update(sendOpts.idempotencyKey).digest("hex").slice(0, 20);
    const headers = raw.slice(0, raw.indexOf("\r\n\r\n"));
    expect(headers.toLowerCase()).toContain(`x-job-ref: ${ref}`); // header names are case-insensitive
    expect(headers).toContain(`Message-ID: <${ref}@example.invalid>`); // the domain of the test's sender
    expect(raw).not.toContain(sendOpts.idempotencyKey); // the raw job id is in no header, no Message-ID, no body
    expect(out).toMatchObject({ outcome: "accepted" });
    expect(raw).not.toContain(SECRET_PASSWORD); // the password is never part of a message
  });

  it("a refused recipient (550) is a permanent refusal: known not sent", async () => {
    const s = await start({ rcpt: "550 5.1.1 no such user" });
    const out = await new SmtpTransport(options(s.port), FROM).send(message, sendOpts);
    expect(out).toEqual({ outcome: "refused", status: 550, retryable: false });
    expect(s.messages).toHaveLength(0);
  });

  it("a temporary refusal at MAIL FROM (451) is retryable, known not sent", async () => {
    const s = await start({ mail: "451 4.3.0 try later" });
    const out = await new SmtpTransport(options(s.port), FROM).send(message, sendOpts);
    expect(out).toEqual({ outcome: "refused", status: 451, retryable: true });
  });

  it("content rejected after the body (554) is a permanent refusal", async () => {
    const s = await start({ final: "554 5.7.1 message rejected as spam" });
    const out = await new SmtpTransport(options(s.port), FROM).send(message, sendOpts);
    expect(out).toEqual({ outcome: "refused", status: 554, retryable: false });
  });

  it("a temporary refusal after the body (452) is retryable", async () => {
    const s = await start({ final: "452 4.2.2 mailbox full" });
    const out = await new SmtpTransport(options(s.port), FROM).send(message, sendOpts);
    expect(out).toEqual({ outcome: "refused", status: 452, retryable: true });
  });

  it("a wrong password (535) is a permanent login failure, summarised as 'mail account login failed'", async () => {
    const s = await start({ auth: "535 5.7.8 bad credentials" });
    const out = await new SmtpTransport(options(s.port), FROM).send(message, sendOpts);
    expect(out).toEqual({ outcome: "refused", status: 535, retryable: false, summary: "mail account login failed" });
    expect(s.messages).toHaveLength(0);
  });

  it("a server that is busy at the greeting (421) is retryable, known not sent", async () => {
    const s = await start({ greeting: "421 4.3.2 busy" });
    const out = await new SmtpTransport(options(s.port), FROM).send(message, sendOpts);
    expect(out).toMatchObject({ outcome: "refused", retryable: true });
    expect(s.messages).toHaveLength(0);
  });

  it("nothing listening: connection refused is retryable, known not sent", async () => {
    const s = await start();
    const port = s.port;
    await s.close();
    server = null;
    const out = await new SmtpTransport(options(port), FROM).send(message, sendOpts);
    expect(out).toMatchObject({ outcome: "refused", retryable: true });
  });

  it("UNKNOWN: the body was sent and the server never answered (timeout)", async () => {
    const s = await start({ final: "hang" });
    const out = await new SmtpTransport(options(s.port), FROM).send(message, sendOpts);
    expect(out.outcome).toBe("unknown");
    expect(s.messages).toHaveLength(1); // it really did receive the message
    expect((out as { reason: string }).reason).toMatch(/^smtp \w+$/);
    expect((out as { reason: string }).reason).not.toContain(ADDRESS);
  });

  it("UNKNOWN: the connection drops after the body, so it might have been queued", async () => {
    const s = await start({ final: "drop" });
    const out = await new SmtpTransport(options(s.port), FROM).send(message, sendOpts);
    expect(out.outcome).toBe("unknown");
    expect(s.messages).toHaveLength(1);
  });

  it("a server that accepts the connection but never greets: known not sent, retryable", async () => {
    const s = await start({ greeting: "silent" });
    const out = await new SmtpTransport(options(s.port), FROM).send(message, sendOpts);
    expect(out).toMatchObject({ outcome: "refused", retryable: true });
    expect(s.messages).toHaveLength(0);
  });

  it("a server that never answers RCPT TO: the message body was never sent, so nothing went out", async () => {
    const s = await start({ rcpt: "hang" });
    const out = await new SmtpTransport(options(s.port), FROM).send(message, sendOpts);
    expect(s.messages).toHaveLength(0);
    // Refused (known not sent) or unknown are both safe here. Delivering is the only thing that is not.
    expect(["refused", "unknown"]).toContain(out.outcome);
  });

  it("INVARIANT: whenever the server received the complete message, the outcome is never 'refused'", async () => {
    // 'refused' means "known not sent", so the sending record is deleted and a retry sends again.
    // If the message did arrive, that would be a duplicate email.
    const scenarios: SmtpBehavior[] = [{ final: "hang" }, { final: "drop" }, {}];
    for (const behavior of scenarios) {
      const s = await start(behavior);
      const out = await new SmtpTransport(options(s.port), FROM).send(message, sendOpts);
      if (s.messages.length > 0) expect(out.outcome).not.toBe("refused");
      await s.close();
      server = null;
    }
  });

  it("a send that times out does not hold the caller much past the timeout", async () => {
    const s = await start({ final: "hang" });
    const started = Date.now();
    await new SmtpTransport(options(s.port), FROM).send(message, sendOpts);
    expect(Date.now() - started).toBeLessThan(TIMEOUT_MS * 4);
  });
});

describe("classifySmtpError", () => {
  it("no answer once the body was pulled is 'unknown', whatever command nodemailer names", () => {
    // nodemailer reports command "CONN" even for a failure after the whole message was sent.
    for (const command of ["CONN", "EHLO", "AUTH PLAIN", "MAIL FROM", "RCPT TO", "DATA", undefined]) {
      expect(classifySmtpError({ code: "ETIMEDOUT", command }, true).outcome).toBe("unknown");
    }
    expect(classifySmtpError(new Error("boom"), true).outcome).toBe("unknown");
    expect(classifySmtpError(undefined, true).outcome).toBe("unknown");
    expect(classifySmtpError("text", true).outcome).toBe("unknown");
    expect(classifySmtpError({ code: "ESOCKET" }, true)).toEqual({ outcome: "unknown", reason: "smtp ESOCKET" });
  });
  it("no answer before any of the body was pulled is known-not-sent and retryable", () => {
    expect(classifySmtpError({ code: "ETIMEDOUT", command: "CONN" }, false)).toMatchObject({ outcome: "refused", retryable: true });
    expect(classifySmtpError({ code: "ECONNECTION" }, false)).toMatchObject({ outcome: "refused", retryable: true });
    expect(classifySmtpError(new Error("boom"), false)).toMatchObject({ outcome: "refused", retryable: true });
  });
  it("4xx is retryable, 5xx is permanent, login refusals (535, 534) are permanent, in either phase", () => {
    for (const pulled of [false, true]) {
      expect(classifySmtpError({ responseCode: 421, command: "DATA" }, pulled)).toEqual({ outcome: "refused", status: 421, retryable: true });
      expect(classifySmtpError({ responseCode: 550, command: "RCPT TO" }, pulled)).toEqual({ outcome: "refused", status: 550, retryable: false });
      expect(classifySmtpError({ responseCode: 535, command: "AUTH PLAIN" }, pulled)).toEqual({ outcome: "refused", status: 535, retryable: false, summary: "mail account login failed" });
      expect(classifySmtpError({ responseCode: 534, command: "AUTH LOGIN" }, pulled)).toMatchObject({ retryable: false, summary: "mail account login failed" });
    }
  });
});

describe("smtpOptions", () => {
  const settings = { host: "smtp.example.invalid", port: 587, user: "u", password: SECRET_PASSWORD, from: FROM };
  it("port 587 upgrades with STARTTLS and refuses to send the password without it", () => {
    const o = smtpOptions(settings, 30000);
    expect(o).toMatchObject({ secure: false, requireTLS: true, host: "smtp.example.invalid", port: 587 });
  });
  it("port 465 is TLS from the start", () => {
    expect(smtpOptions({ ...settings, port: 465 }, 30000)).toMatchObject({ secure: true, requireTLS: false });
  });
  it("all three timeouts follow SEND_TIMEOUT_MS", () => {
    expect(smtpOptions(settings, 12345)).toMatchObject({ connectionTimeout: 12345, greetingTimeout: 12345, socketTimeout: 12345 });
  });
});

describe("MAIL_TRANSPORT config", () => {
  const base = {
    DATABASE_URL: "x", MAX_ATTEMPTS: "5", PORT: "3000", POLL_INTERVAL_MS: "1000", SEND_TIMEOUT_MS: "30000",
    FAKE_SEND_DELAY_MS: "0", UNCERTAIN_SEND_POLICY: "flag_for_human", BACKOFF_BASE_MS: "2000", BACKOFF_CAP_MS: "300000",
    STUCK_TIMEOUT_MS: "120000", SWEEP_INTERVAL_MS: "15000", WORKER_CONCURRENCY: "5", HEARTBEAT_INTERVAL_MS: "10000",
  };
  const smtp = { EMAIL_HOST: "smtp.example.invalid", EMAIL_PORT: "587", EMAIL_USER: "u", EMAIL_PASSWORD: SECRET_PASSWORD, EMAIL_FROM: FROM };

  it("defaults to fake and needs no EMAIL settings", () => {
    const c = loadWorkerConfig(base);
    expect(c.mailTransport).toBe("fake");
    expect(c.smtp).toBeNull();
  });
  it("rejects any other value", () => {
    expect(() => loadWorkerConfig({ ...base, MAIL_TRANSPORT: "smtp" })).toThrow(/MAIL_TRANSPORT/);
  });
  it("real needs every EMAIL setting and reads them", () => {
    const c = loadWorkerConfig({ ...base, MAIL_TRANSPORT: "real", ...smtp });
    expect(c.mailTransport).toBe("real");
    expect(c.smtp).toMatchObject({ host: "smtp.example.invalid", port: 587, user: "u", from: FROM });
    for (const key of Object.keys(smtp)) {
      const { [key]: _omit, ...rest } = smtp as Record<string, string>;
      expect(() => loadWorkerConfig({ ...base, MAIL_TRANSPORT: "real", ...rest })).toThrow(new RegExp(key));
    }
  });
  it("real refuses FORCE_FAIL, which only the fake understands", () => {
    expect(() => loadWorkerConfig({ ...base, MAIL_TRANSPORT: "real", FORCE_FAIL: "true", ...smtp })).toThrow(/FORCE_FAIL/);
  });
  it("a fake worker ignores EMAIL settings in the environment", () => {
    expect(loadWorkerConfig({ ...base, ...smtp }).smtp).toBeNull();
  });
});

describe("worker + SmtpTransport + database, against the scripted server", () => {
  async function newJob(maxAttempts = 5): Promise<string> {
    const r = await enqueueJob(pool, {
      ownerId: "user-a",
      idempotencyKey: `${PREFIX}${++counter}-${Date.now()}`,
      type: "send_email",
      payload: message,
      maxAttempts,
    });
    if (r.outcome !== "created") throw new Error("test job not created");
    return r.jobId;
  }
  function deps(port: number, policy: WorkerDeps["uncertainSendPolicy"] = "flag_for_human"): WorkerDeps {
    return {
      pool,
      transport: new SmtpTransport(options(port), FROM),
      sendTimeoutMs: TIMEOUT_MS,
      uncertainSendPolicy: policy,
      backoffBaseMs: 50,
      backoffCapMs: 1000,
    };
  }
  const jobRow = async (id: string) => (await pool.query("SELECT * FROM jobs WHERE id = $1", [id])).rows[0];
  const sentRow = async (id: string) => (await pool.query("SELECT * FROM sent_emails WHERE job_id = $1", [id])).rows[0];
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const logs: string[] = [];
  const log = (l: string) => logs.push(l);

  async function cleanup() {
    const ids = `SELECT id FROM jobs WHERE idempotency_key LIKE '${PREFIX}%'`;
    await pool.query(`DELETE FROM sent_emails WHERE job_id IN (${ids})`);
    await pool.query(`DELETE FROM job_attempts WHERE job_id IN (${ids})`);
    await pool.query(`DELETE FROM jobs WHERE idempotency_key LIKE '${PREFIX}%'`);
  }
  beforeEach(async () => {
    logs.length = 0;
    await cleanup();
  });
  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  it("accepted: job succeeded, email state sent, provider message id stored", async () => {
    const s = await start();
    const id = await newJob();
    await runOne(deps(s.port), "w1", log);
    const job = await jobRow(id);
    expect(job.status).toBe("succeeded");
    const sent = await sentRow(id);
    expect(sent.state).toBe("sent");
    const ref = createHash("sha256").update(id).digest("hex").slice(0, 20); // computed here, not by the code under test
    expect(sent.provider_message_id).toBe(`<${ref}@example.invalid>`);
    expect(sent.provider_message_id).not.toContain(id);
    expect(s.messages).toHaveLength(1);
  });

  it("running the same job twice sends one message (the sent_emails check, not the provider, stops it)", async () => {
    const s = await start();
    const id = await newJob();
    await runOne(deps(s.port), "w1", log);
    await pool.query("UPDATE jobs SET status = 'pending' WHERE id = $1", [id]); // force a second run
    await pool.query("DELETE FROM job_attempts WHERE job_id = $1", [id]);
    await pool.query("UPDATE jobs SET attempts = 0 WHERE id = $1", [id]);
    await runOne(deps(s.port), "w1", log);
    expect(s.messages).toHaveLength(1);
  });

  it("a refused recipient (550) kills the job at once and clears the sending record", async () => {
    const s = await start({ rcpt: "550 5.1.1 no such user" });
    const id = await newJob();
    await runOne(deps(s.port), "w1", log);
    const job = await jobRow(id);
    expect(job.status).toBe("dead");
    expect(job.attempts).toBe(1);
    expect(job.last_error).toBe("provider refused with 550");
    expect(await sentRow(id)).toBeUndefined();
  });

  it("a temporary refusal (451) fails the job for a retry, and the sending record is cleared", async () => {
    const s = await start({ mail: "451 4.3.0 try later" });
    const id = await newJob();
    await runOne(deps(s.port), "w1", log);
    const job = await jobRow(id);
    expect(job.status).toBe("failed");
    expect(job.last_error).toBe("provider refused with 451");
    expect(await sentRow(id)).toBeUndefined();
  });

  it("an unknown outcome leaves the sending record; under flag_for_human the retry dies with 'uncertain send'", async () => {
    const s = await start({ final: "hang" });
    const id = await newJob();
    await runOne(deps(s.port), "w1", log);
    let job = await jobRow(id);
    expect(job.status).toBe("failed");
    expect(job.last_error).toMatch(/^provider outcome unknown: smtp \w+$/);
    expect((await sentRow(id)).state).toBe("sending");

    await sleep(150); // past the first backoff bound (50 ms)
    await runOne(deps(s.port, "flag_for_human"), "w1", log);
    job = await jobRow(id);
    expect(job.status).toBe("dead");
    expect(job.last_error).toBe("uncertain send");
    expect(s.messages).toHaveLength(1); // the second try sent nothing
  });

  it("neither last_error nor the logs contain the address or the password", async () => {
    const s = await start({ final: "hang" });
    const id = await newJob();
    await runOne(deps(s.port), "w1", log);
    const text = JSON.stringify([logs, (await jobRow(id)).last_error]);
    expect(text).not.toContain(ADDRESS);
    expect(text).not.toContain(SECRET_PASSWORD);
  });
});
