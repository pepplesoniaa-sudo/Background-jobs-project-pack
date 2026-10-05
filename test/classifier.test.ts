import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { SendError } from "../src/errors.js";
import { sendEmailSafely } from "../src/sendEmail.js";
import { classifySmtpError } from "../src/smtpTransport.js";
import type { MailTransport, TransportOutcome } from "../src/transport.js";

// DATABASE-FREE AND MAIL-FREE. This file imports no database client and opens no connection. The
// classifier is a pure function; sendEmailSafely is exercised with a stub pool (it only records the
// SQL it is given) and a stub transport (it only returns a canned outcome). Nothing here can write
// to jobs_dev or send an email, so it may run at any time, with or without a worker running.

const ADDRESS = "nobody@example.invalid";
const LOGIN = "mail account login failed";

// An error shaped like the ones nodemailer raises (see its smtp-connection source for the codes).
const smtpError = (fields: { code?: string; command?: string; responseCode?: number }) =>
  Object.assign(new Error(`failure for ${ADDRESS}`), fields); // the text deliberately holds an address

const phases = [false, true]; // body not pulled yet, body pulled

describe("temporary refusals: 4xx is retryable, nothing was sent", () => {
  for (const code of [421, 450, 451, 452, 454]) {
    it(`${code} is retryable in either phase`, () => {
      for (const pulled of phases) {
        expect(classifySmtpError(smtpError({ responseCode: code, command: "RCPT TO" }), pulled)).toEqual({
          outcome: "refused",
          status: code,
          retryable: true,
        });
      }
    });
  }
  it("454 at the login step is a TEMPORARY login refusal and stays retryable", () => {
    for (const pulled of phases) {
      expect(classifySmtpError(smtpError({ responseCode: 454, command: "AUTH PLAIN", code: "EAUTH" }), pulled)).toEqual({
        outcome: "refused",
        status: 454,
        retryable: true,
      });
    }
  });
});

describe("permanent refusals: any 5xx from the mail server", () => {
  for (const code of [500, 501, 550, 551, 552, 553, 554, 599]) {
    it(`${code} is permanent in either phase`, () => {
      for (const pulled of phases) {
        for (const command of ["MAIL FROM", "RCPT TO", "DATA"]) {
          expect(classifySmtpError(smtpError({ responseCode: code, command }), pulled)).toEqual({
            outcome: "refused",
            status: code,
            retryable: false,
          });
        }
      }
    });
  }
});

describe("login failures are permanent with one fixed summary", () => {
  for (const code of [530, 534, 535]) {
    it(`${code} is permanent: 'mail account login failed'`, () => {
      for (const pulled of phases) {
        for (const command of ["AUTH PLAIN", "AUTH LOGIN", "MAIL FROM", undefined]) {
          expect(classifySmtpError(smtpError({ responseCode: code, command }), pulled)).toEqual({
            outcome: "refused",
            status: code,
            retryable: false,
            summary: LOGIN,
          });
        }
      }
    });
  }
  it("any other 5xx at the AUTH step is also a login failure", () => {
    expect(classifySmtpError(smtpError({ responseCode: 538, command: "AUTH PLAIN" }), false)).toMatchObject({
      retryable: false,
      summary: LOGIN,
    });
  });
  it("RULING 5: EAUTH with no server reply is a login failure, permanent, same summary", () => {
    for (const pulled of phases) {
      expect(classifySmtpError(smtpError({ code: "EAUTH", command: "AUTH PLAIN" }), pulled)).toMatchObject({
        outcome: "refused",
        retryable: false,
        summary: LOGIN,
      });
      expect(classifySmtpError(smtpError({ code: "EAUTH" }), pulled)).toMatchObject({ retryable: false, summary: LOGIN });
    }
  });
});

describe("RULING 5: a rejection made by the mail library itself is permanent", () => {
  it("EENVELOPE with no reply (a malformed recipient) is permanent, nothing was sent", () => {
    for (const pulled of phases) {
      expect(classifySmtpError(smtpError({ code: "EENVELOPE", command: "API" }), pulled)).toEqual({
        outcome: "refused",
        status: 550,
        retryable: false,
        summary: "recipient address rejected",
      });
    }
  });
  it("EMESSAGE with no reply (for example message size) is permanent", () => {
    for (const pulled of phases) {
      expect(classifySmtpError(smtpError({ code: "EMESSAGE", command: "MAIL FROM" }), pulled)).toEqual({
        outcome: "refused",
        status: 552,
        retryable: false,
        summary: "message rejected before sending",
      });
    }
  });
  it("EENVELOPE WITH a server reply (every recipient rejected, 550) follows the reply: permanent", () => {
    for (const pulled of phases) {
      expect(classifySmtpError(smtpError({ code: "EENVELOPE", command: "RCPT TO", responseCode: 550 }), pulled)).toEqual({
        outcome: "refused",
        status: 550,
        retryable: false,
      });
    }
  });
  it("EMESSAGE WITH a server reply (message failed after the body, 554) follows the reply", () => {
    expect(classifySmtpError(smtpError({ code: "EMESSAGE", command: "DATA", responseCode: 554 }), true)).toEqual({
      outcome: "refused",
      status: 554,
      retryable: false,
    });
  });
  it("EENVELOPE WITH a temporary reply (451) stays retryable", () => {
    expect(classifySmtpError(smtpError({ code: "EENVELOPE", command: "RCPT TO", responseCode: 451 }), false)).toMatchObject({
      retryable: true,
    });
  });
});

describe("no reply at all: today's logic is kept (before the body, retryable and not sent; after, unknown)", () => {
  // nodemailer renames DNS failures EDNS and a refused connection ECONNECTION (checked in its source).
  for (const code of ["EDNS", "ENOTFOUND", "ECONNECTION", "ECONNREFUSED", "ETIMEDOUT", "ESOCKET", "ETLS", "EPROTOCOL"]) {
    it(`${code} before the body is retryable and known not sent`, () => {
      expect(classifySmtpError(smtpError({ code, command: "CONN" }), false)).toEqual({
        outcome: "refused",
        status: 421,
        retryable: true,
      });
    });
    it(`${code} after the body started is UNKNOWN (the sending row is kept), whatever command is named`, () => {
      for (const command of ["CONN", "DATA", "RCPT TO", undefined]) {
        expect(classifySmtpError(smtpError({ code, command }), true)).toEqual({ outcome: "unknown", reason: `smtp ${code}` });
      }
    });
  }
  it("a plain Error, a string and undefined follow the same two-way rule", () => {
    for (const bad of [new Error("boom"), "text", undefined, null, 42]) {
      expect(classifySmtpError(bad, false)).toMatchObject({ outcome: "refused", retryable: true });
      expect(classifySmtpError(bad, true)).toEqual({ outcome: "unknown", reason: "smtp error" });
    }
  });
});

describe("no address ever reaches a result", () => {
  it("whatever the error says, the outcome holds no @ sign", () => {
    const errors = [
      smtpError({ responseCode: 421 }),
      smtpError({ responseCode: 550, command: "RCPT TO" }),
      smtpError({ responseCode: 535, command: "AUTH PLAIN" }),
      smtpError({ code: "EAUTH" }),
      smtpError({ code: "EENVELOPE" }),
      smtpError({ code: "EMESSAGE" }),
      smtpError({ code: "EDNS", command: "CONN" }),
      smtpError({ code: "ETIMEDOUT", command: "CONN" }),
      smtpError({}),
    ];
    for (const err of errors) {
      for (const pulled of phases) {
        expect(JSON.stringify(classifySmtpError(err, pulled))).not.toContain("@");
      }
    }
  });
});

// ---- sendEmailSafely, with a stub pool and a stub transport -------------------------------------

interface Call {
  sql: string;
  params: unknown[];
}

// Answers the four statements sendEmailSafely uses, as for a job with no sent_emails row yet.
function stubPool() {
  const calls: Call[] = [];
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (/^\s*SELECT state FROM sent_emails/i.test(sql)) return { rows: [], rowCount: 0 };
      if (/INSERT INTO sent_emails/i.test(sql)) return { rows: [{ job_id: "j" }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    },
  };
  return { pool: pool as unknown as Pool, calls };
}

const stubTransport = (outcome: TransportOutcome): MailTransport => ({ send: async () => outcome });
const message = { to: ADDRESS, subject: "s", body: "b" };
const JOB = "0765bf9f-07ee-45ef-9b45-39af6173e08d";

async function run(outcome: TransportOutcome) {
  const { pool, calls } = stubPool();
  const err = await sendEmailSafely(
    { pool, transport: stubTransport(outcome), sendTimeoutMs: 1000, uncertainSendPolicy: "flag_for_human" },
    JOB,
    message,
  ).then(
    () => null,
    (e: unknown) => e,
  );
  return { err: err as SendError | null, calls };
}

describe("sendEmailSafely maps the outcomes (stub pool, stub transport: no database, no mail)", () => {
  it("accepted: the sent record uses a GUARDED update that only moves 'sending' to 'sent'", async () => {
    const { err, calls } = await run({ outcome: "accepted", messageId: "<m1>" });
    expect(err).toBeNull();
    const update = calls.find((c) => /UPDATE sent_emails/i.test(c.sql))!;
    expect(update.sql).toMatch(/SET state = 'sent'/);
    expect(update.sql).toMatch(/WHERE job_id = \$1 AND state = 'sending'/);
    expect(update.sql).not.toMatch(/SET[^W]*state = 'sending'/); // nothing sets a row back to sending
    expect(update.params).toEqual([JOB, "<m1>"]);
  });

  it("a login failure becomes a permanent SendError with the fixed summary, and the sending row is cleared", async () => {
    const outcome = classifySmtpError(smtpError({ responseCode: 535, command: "AUTH PLAIN" }), false);
    const { err, calls } = await run(outcome);
    expect(err).toBeInstanceOf(SendError);
    expect(err!.message).toBe(LOGIN);
    expect(err!.kind).toBe("permanent");
    expect(calls.some((c) => /DELETE FROM sent_emails WHERE job_id = \$1 AND state = 'sending'/.test(c.sql))).toBe(true);
  });

  it("EAUTH with no reply goes the same way", async () => {
    const { err } = await run(classifySmtpError(smtpError({ code: "EAUTH" }), false));
    expect(err!.message).toBe(LOGIN);
    expect(err!.kind).toBe("permanent");
  });

  it("a malformed recipient is permanent with its own summary, and the sending row is cleared", async () => {
    const { err, calls } = await run(classifySmtpError(smtpError({ code: "EENVELOPE" }), false));
    expect(err!.message).toBe("recipient address rejected");
    expect(err!.kind).toBe("permanent");
    expect(calls.some((c) => /^\s*DELETE FROM sent_emails/i.test(c.sql))).toBe(true);
  });

  it("a 4xx keeps the plain text and is retryable; a 5xx keeps the plain text and is permanent", async () => {
    const temp = await run(classifySmtpError(smtpError({ responseCode: 451, command: "MAIL FROM" }), false));
    expect(temp.err!.message).toBe("provider refused with 451");
    expect(temp.err!.kind).toBe("retryable");
    const perm = await run(classifySmtpError(smtpError({ responseCode: 550, command: "RCPT TO" }), false));
    expect(perm.err!.message).toBe("provider refused with 550");
    expect(perm.err!.kind).toBe("permanent");
  });

  it("an unknown outcome keeps the sending row (no DELETE) and is retryable", async () => {
    const { err, calls } = await run(classifySmtpError(smtpError({ code: "ETIMEDOUT", command: "CONN" }), true));
    expect(err!.message).toBe("provider outcome unknown: smtp ETIMEDOUT");
    expect(err!.kind).toBe("retryable");
    expect(calls.some((c) => /DELETE FROM sent_emails/i.test(c.sql))).toBe(false);
  });

  it("RULING 4: the stub default is unchanged (a refusal with no 'retryable' flag: only 429 is retryable)", async () => {
    expect((await run({ outcome: "refused", status: 429 })).err!.kind).toBe("retryable");
    expect((await run({ outcome: "refused", status: 422 })).err!.kind).toBe("permanent");
    expect((await run({ outcome: "refused", status: 429 })).err!.message).toBe("provider refused with 429");
  });

  it("no stored message holds an address, whatever the underlying error said", async () => {
    const cases = [
      smtpError({ responseCode: 535, command: "AUTH PLAIN" }),
      smtpError({ code: "EENVELOPE" }),
      smtpError({ responseCode: 550, command: "RCPT TO" }),
      smtpError({ code: "ETIMEDOUT", command: "CONN" }),
    ];
    for (const e of cases) {
      for (const pulled of phases) {
        const { err } = await run(classifySmtpError(e, pulled));
        expect(err!.message).not.toContain("@");
      }
    }
  });
});
