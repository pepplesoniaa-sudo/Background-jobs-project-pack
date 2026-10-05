import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type SMTPTransport from "nodemailer/lib/smtp-transport/index.js";
import type { Pool } from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { ADMIN_PAGE_JS } from "../src/adminPage.js";
import { loadWebConfig } from "../src/config.js";
import { JOB_REF_LENGTH, jobRefFor, messageIdForRef, senderDomainOf } from "../src/messageId.js";
import { buildServer } from "../src/server.js";
import { SmtpTransport } from "../src/smtpTransport.js";
import { startFakeSmtp, type FakeSmtp } from "./helpers/fakeSmtp.js";

// DATABASE-FREE AND MAIL-FREE. Mail goes only to a scripted SMTP server on 127.0.0.1 inside this test.
// The dead-page route runs through Fastify's inject() with a stub pool that returns canned rows, so
// there is no network and no database. Safe to run at any time, with or without a worker.

const JOB_ID = "0765bf9f-07ee-45ef-9b45-39af6173e08d";
const OTHER_ID = "11111111-2222-4333-8444-555555555555";
const ADDRESS = "nobody@example.invalid";
const FROM = "Sender <sender@example.invalid>";
const message = { to: ADDRESS, subject: "hello subject", body: "hello body" };
const TIMEOUT_MS = 500;

const expectedRef = (id: string) => createHash("sha256").update(id).digest("hex").slice(0, 20);

describe("X-Job-Ref: first 20 hex characters of the SHA-256 of the job id", () => {
  it("has exactly 20 lowercase hex characters and matches an independent computation", () => {
    expect(JOB_REF_LENGTH).toBe(20);
    for (const id of [JOB_ID, OTHER_ID, "not-even-a-uuid"]) {
      const ref = jobRefFor(id);
      expect(ref).toMatch(/^[0-9a-f]{20}$/);
      expect(ref).toBe(expectedRef(id));
    }
  });
  it("is stable for one id and different for different ids", () => {
    expect(jobRefFor(JOB_ID)).toBe(jobRefFor(JOB_ID));
    expect(jobRefFor(JOB_ID)).not.toBe(jobRefFor(OTHER_ID));
  });
  it("does not contain the job id or the start of it", () => {
    const ref = jobRefFor(JOB_ID);
    expect(ref).not.toContain(JOB_ID);
    expect(ref).not.toContain(JOB_ID.slice(0, 8));
    expect(ref).not.toContain("-");
  });
});

describe("senderDomainOf: the domain of the configured sender", () => {
  it("reads the domain from a plain address, a display-name form, and a quoted display name", () => {
    expect(senderDomainOf("sender@example.invalid")).toBe("example.invalid");
    expect(senderDomainOf("Sender <sender@example.invalid>")).toBe("example.invalid");
    expect(senderDomainOf('"Name, With Comma" <a@b.example>')).toBe("b.example");
    expect(senderDomainOf("  Mixed <Case@Example.COM>  ")).toBe("example.com");
  });
  it("throws when there is no usable domain, and the message never repeats the input", () => {
    for (const bad of ["secret-no-domain-value", "a@", "a@localhost", "", "a@b..c", "<a@>", "a@-b.example"]) {
      let message = "";
      try {
        senderDomainOf(bad);
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toBe("EMAIL_FROM must hold a sender address with a domain");
      if (bad) expect(message).not.toContain(bad);
    }
  });
  it("builds the Message-ID from the ref and the domain", () => {
    expect(messageIdForRef("abc123", "example.invalid")).toBe("<abc123@example.invalid>");
  });
});

let server: FakeSmtp | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

function options(port: number): SMTPTransport.Options {
  return {
    host: "127.0.0.1",
    port,
    secure: false,
    ignoreTLS: true,
    auth: { user: "user", pass: "pass" },
    connectionTimeout: TIMEOUT_MS,
    greetingTimeout: TIMEOUT_MS,
    socketTimeout: TIMEOUT_MS,
  };
}

const sendOpts = { idempotencyKey: JOB_ID, timeoutMs: TIMEOUT_MS };
const headerBlock = (raw: string) => raw.slice(0, raw.indexOf("\r\n\r\n"));

describe("SmtpTransport headers, against the scripted local server", () => {
  it("sends X-Job-Ref and a Message-ID built from the ref and the sender's domain", async () => {
    server = await startFakeSmtp();
    const out = await new SmtpTransport(options(server.port), FROM).send(message, sendOpts);
    const ref = expectedRef(JOB_ID);
    const headers = headerBlock(server.messages[0]);
    expect(headers.toLowerCase()).toContain(`x-job-ref: ${ref}`);
    expect(headers).toContain(`Message-ID: <${ref}@example.invalid>`);
    expect(out).toEqual({ outcome: "accepted", messageId: `<${ref}@example.invalid>` });
  });

  it("the raw job id appears NOWHERE in the message: not in any header, not in the body", async () => {
    server = await startFakeSmtp();
    await new SmtpTransport(options(server.port), FROM).send(message, sendOpts);
    const raw = server.messages[0];
    expect(raw).not.toContain(JOB_ID);
    expect(headerBlock(raw)).not.toContain(JOB_ID);
    expect(raw.toLowerCase()).not.toContain("x-background-job-id");
    expect(raw.toLowerCase()).not.toContain("bgjobs.invalid");
  });

  it("the domain follows the configured sender, not a fixed value", async () => {
    server = await startFakeSmtp();
    const out = await new SmtpTransport(options(server.port), "A <a@other.example>").send(message, sendOpts);
    expect(headerBlock(server.messages[0])).toContain(`Message-ID: <${expectedRef(JOB_ID)}@other.example>`);
    expect(out).toMatchObject({ outcome: "accepted", messageId: `<${expectedRef(JOB_ID)}@other.example>` });
  });

  it("a sender with no domain fails at construction, without repeating the setting", () => {
    let message = "";
    try {
      new SmtpTransport(options(1), "secret-sender-without-domain");
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toBe("EMAIL_FROM must hold a sender address with a domain");
    expect(message).not.toContain("secret-sender-without-domain");
  });
});

describe("the web side shows only the ref and never reads the sender", () => {
  const webEnv = { DATABASE_URL: "x", MAX_ATTEMPTS: "5", PORT: "3000", ADMIN_TOKEN: "t".repeat(20) };

  it("loadWebConfig needs no EMAIL_* setting and returns nothing about the sender", () => {
    const c = loadWebConfig(webEnv); // no EMAIL_HOST, EMAIL_USER, EMAIL_PASSWORD or EMAIL_FROM given
    expect(Object.keys(c).sort()).toEqual(["adminToken", "databaseUrl", "maxAttempts", "port"]);
  });

  it("no web-side source file mentions the sender settings", () => {
    for (const file of ["src/adminRoutes.ts", "src/adminPage.ts", "src/server.ts", "src/homePage.ts", "src/main.ts"]) {
      const text = readFileSync(file, "utf8");
      for (const word of ["EMAIL_FROM", "EMAIL_USER", "EMAIL_PASSWORD", "EMAIL_HOST", "senderDomainOf"]) {
        expect(text.includes(word), `${file} must not mention ${word}`).toBe(false);
      }
    }
  });

  it("the dead page API returns jobRef for every job, equal to the hash label, and no search string", async () => {
    const deadRows = [
      { id: JOB_ID, type: "send_email", created_at: new Date(), attempts: 2, max_attempts: 5, last_error: "uncertain send", payload: { to: ADDRESS, subject: "s", body: "b" }, sent_state: "sending" },
      { id: OTHER_ID, type: "send_email", created_at: new Date(), attempts: 5, max_attempts: 5, last_error: "provider refused with 550", payload: { to: ADDRESS, subject: "s", body: "b" }, sent_state: null },
    ];
    // Answers by what the SQL asks for (the list, the count of all dead jobs, the attempt history), not by call order.
    const pool = {
      query: async (sql: string) => {
        if (/count\(\*\)/i.test(sql)) return { rows: [{ n: deadRows.length }], rowCount: 1 };
        if (/FROM job_attempts/i.test(sql)) return { rows: [], rowCount: 0 };
        return { rows: deadRows, rowCount: deadRows.length };
      },
    } as unknown as Pool;
    const app = buildServer(pool, loadWebConfig(webEnv));
    const res = await app.inject({ method: "GET", url: "/api/admin/dead-jobs", headers: { "x-admin-token": webEnv.ADMIN_TOKEN } });
    await app.close();

    expect(res.statusCode).toBe(200);
    const body = res.json() as { jobs: Array<Record<string, unknown>> };
    expect(body.jobs.map((j) => j.jobRef)).toEqual([expectedRef(JOB_ID), expectedRef(OTHER_ID)]);
    for (const job of body.jobs) expect(Object.keys(job)).not.toContain("providerSearch");
    expect(res.body).not.toContain("rfc822msgid");
    expect(res.body).not.toContain("example.invalid>"); // no Message-ID, and so no sender domain, reaches the page
    expect(body.jobs[0]).toMatchObject({ sentState: "sending", checkProviderBeforeRetry: true });
  });

  it("the page script shows the ref with textContent only, and keeps the unknown-outcome warning", () => {
    expect(ADMIN_PAGE_JS).toContain("job.jobRef");
    expect(ADMIN_PAGE_JS).toContain("X-Job-Ref");
    expect(ADMIN_PAGE_JS).not.toContain("providerSearch");
    expect(ADMIN_PAGE_JS).not.toContain("innerHTML");
    expect(ADMIN_PAGE_JS).toContain("Outcome UNKNOWN: check the provider before retrying.");
    expect(ADMIN_PAGE_JS).not.toMatch(/localStorage|sessionStorage|document\.cookie/);
  });
});
