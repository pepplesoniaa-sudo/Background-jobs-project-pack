import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { loadWebConfig } from "../src/config.js";
import { hashPayload } from "../src/enqueue.js";
import { validateRecipient } from "../src/recipient.js";
import { buildServer } from "../src/server.js";

// DATABASE-FREE AND MAIL-FREE. The function tests are pure. The API tests run through Fastify's
// inject() (no network) with a stub pool that only records the SQL it is given, so "writes no row"
// is proved as "ran zero queries". Nothing here can reach jobs_dev, jobs_test or any mail server.

const JOB = "0765bf9f-07ee-45ef-9b45-39af6173e08d";
const webEnv = { DATABASE_URL: "x", MAX_ATTEMPTS: "5", PORT: "3000", ADMIN_TOKEN: "t".repeat(20) };
const tooLongDomain = `a@${"b".repeat(60)}.${"c".repeat(60)}.${"d".repeat(60)}.${"e".repeat(60)}.example.test`;

// [input, the phrase that must follow "payload.to"]
const REJECTED: Array<[string, string]> = [
  ["", "is empty"],
  ["   ", "is empty"],
  ["a b@example.test", "must not contain spaces"],
  [" a@example.test", "must not contain spaces"],
  ["a@example.test ", "must not contain spaces"],
  ["Name <a@example.test>", "must not contain spaces"],
  ["a\t@example.test", "must not contain spaces"],
  ["no-at-sign-here", "must contain exactly one @"],
  ["a@b@example.test", "must contain exactly one @"],
  ["a@", "needs a domain after the @"],
  ["@example.test", "needs a name before the @"],
  ["a@localhost", "must have a domain that looks like name.tld"],
  ["a@example", "must have a domain that looks like name.tld"],
  ["a@.example.test", "must have a domain that looks like name.tld"],
  ["a@example..test", "must have a domain that looks like name.tld"],
  ["a@-example.test", "must have a domain that looks like name.tld"],
  ["a@example-.test", "must have a domain that looks like name.tld"],
  ["a@example.t", "must have a domain that looks like name.tld"],
  ["a@example.123", "must have a domain that looks like name.tld"],
  ["a@1.2.3.4", "must have a domain that looks like name.tld"],
  ["a@exa_mple.test", "must have a domain that looks like name.tld"],
  ["a,b@example.test", "must be one plain address, with no commas, semicolons, quotes or angle brackets"],
  ["a@example.test,b@example.test", "must be one plain address, with no commas, semicolons, quotes or angle brackets"],
  ["a@example.test;b@example.test", "must be one plain address, with no commas, semicolons, quotes or angle brackets"],
  ["<a@example.test>", "must be one plain address, with no commas, semicolons, quotes or angle brackets"],
  ['"a"@example.test', "must be one plain address, with no commas, semicolons, quotes or angle brackets"],
  [".a@example.test", "has characters or dots that are not allowed before the @"],
  ["a.@example.test", "has characters or dots that are not allowed before the @"],
  ["a..b@example.test", "has characters or dots that are not allowed before the @"],
  ["a(b)@example.test", "has characters or dots that are not allowed before the @"],
  ["a\\b@example.test", "has characters or dots that are not allowed before the @"],
  [`${"a".repeat(65)}@example.test`, "is too long"],
  [tooLongDomain, "is too long"],
];

const ACCEPTED = [
  "nobody@example.test",
  "nobody@example.invalid", // well-formed, and a mailbox that does not exist: the shape check cannot know
  "a.b+tag@sub.example.co",
  "UPPER@EXAMPLE.COM",
  "o'neil@example.org",
  "a_b-c@my-domain.example",
  `${"a".repeat(64)}@example.test`,
  "x@xn--example-9d0b.test",
];

describe("validateRecipient: the shape of one address", () => {
  it("accepts well-formed addresses, including one whose mailbox does not exist", () => {
    for (const ok of ACCEPTED) expect(validateRecipient(ok), ok).toEqual({ ok: true });
  });

  it("refuses each bad shape with its own phrase", () => {
    for (const [input, message] of REJECTED) {
      expect(validateRecipient(input), JSON.stringify(input.length > 80 ? "(long)" : input)).toEqual({ ok: false, message });
    }
  });

  it("refuses a missing or non-text value", () => {
    expect(validateRecipient(undefined)).toEqual({ ok: false, message: "is missing" });
    expect(validateRecipient(null)).toEqual({ ok: false, message: "is missing" });
    for (const bad of [42, true, {}, ["a@example.test"]]) {
      expect(validateRecipient(bad)).toEqual({ ok: false, message: "must be text" });
    }
  });

  it("never repeats the input in its message", () => {
    for (const [input] of REJECTED) {
      const check = validateRecipient(input);
      if (!check.ok && input.trim().length > 3) expect(check.message).not.toContain(input);
    }
  });

  it("does not change or trim what it is given (it only judges it)", () => {
    const value = "nobody@example.test";
    validateRecipient(value);
    expect(value).toBe("nobody@example.test");
  });
});

// ---- POST /api/jobs through inject(), with a stub pool ----------------------------------------------

type Mode = "fresh" | "existing" | "conflict";

function stubPool(mode: Mode, type: string, payload: unknown) {
  const calls: string[] = [];
  const pool = {
    query: async (sql: string) => {
      calls.push(sql);
      if (/^\s*INSERT INTO jobs/i.test(sql)) {
        return mode === "fresh" ? { rows: [{ id: JOB }], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      if (/FROM jobs WHERE idempotency_key/i.test(sql)) {
        const hash = mode === "existing" ? hashPayload(type, payload) : "a-different-hash";
        return { rows: [{ id: JOB, owner_id: "user-a", payload_hash: hash }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  return { pool: pool as unknown as Pool, calls };
}

async function post(body: unknown, mode: Mode = "fresh", headers: Record<string, string> = { "x-user-id": "user-a" }) {
  const b = body as { type?: string; payload?: unknown };
  const { pool, calls } = stubPool(mode, b.type ?? "send_email", b.payload);
  const app = buildServer(pool, loadWebConfig(webEnv));
  const res = await app.inject({
    method: "POST",
    url: "/api/jobs",
    headers: { "content-type": "application/json", ...headers },
    payload: JSON.stringify(body),
  });
  await app.close();
  return { res, calls };
}

const order = (to: unknown, key = "k-1") => ({
  type: "send_email",
  idempotencyKey: key,
  payload: { to, subject: "s", body: "b" },
});

describe("POST /api/jobs: a badly formed recipient is a 400 and writes no row", () => {
  it("every bad shape gets 400, the exact message, and ZERO queries (so no row)", async () => {
    for (const [input, message] of REJECTED) {
      const { res, calls } = await post(order(input));
      expect(res.statusCode, JSON.stringify(input.length > 80 ? "(long)" : input)).toBe(400);
      expect(res.json()).toEqual({ error: `invalid recipient: payload.to ${message}` });
      expect(calls).toHaveLength(0);
      if (input.trim().length > 3) expect(res.body).not.toContain(input); // the reply never repeats the address
    }
  });

  it("a payload with no 'to', a null 'to' and a non-text 'to' are 400 with zero queries", async () => {
    const noTo = await post({ type: "send_email", idempotencyKey: "k-2", payload: { subject: "s", body: "b" } });
    expect(noTo.res.statusCode).toBe(400);
    expect(noTo.res.json()).toEqual({ error: "invalid recipient: payload.to is missing" });
    expect(noTo.calls).toHaveLength(0);
    for (const bad of [null, 42, ["a@example.test"]]) {
      const r = await post(order(bad));
      expect(r.res.statusCode).toBe(400);
      expect(r.calls).toHaveLength(0);
    }
  });

  it("a well-formed address passes (202) with exactly one insert, even if its mailbox cannot exist", async () => {
    for (const ok of ["nobody@example.test", "nobody@example.invalid"]) {
      const { res, calls } = await post(order(ok));
      expect(res.statusCode).toBe(202);
      expect(res.json()).toEqual({ id: JOB });
      expect(calls.filter((c) => /INSERT INTO jobs/i.test(c))).toHaveLength(1);
    }
  });
});

describe("POST /api/jobs: 200, 409, 401 and the schema 400 are unchanged", () => {
  it("the same key, owner and content returns 200 with the existing id", async () => {
    const { res } = await post(order("nobody@example.test"), "existing");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: JOB });
  });

  it("the same key with different content or another owner returns 409", async () => {
    const { res } = await post(order("nobody@example.test"), "conflict");
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "idempotency key already used with a different payload or owner" });
  });

  it("no x-user-id header is still 401, checked before the recipient, with zero queries", async () => {
    const withBad = await post(order("not an address"), "fresh", {});
    expect(withBad.res.statusCode).toBe(401);
    expect(withBad.res.json()).toEqual({ error: "x-user-id header required" });
    expect(withBad.calls).toHaveLength(0);
    const withGood = await post(order("nobody@example.test"), "fresh", {});
    expect(withGood.res.statusCode).toBe(401);
  });

  it("the body schema still answers first: a missing key or an unknown type is a 400 with zero queries", async () => {
    const noKey = await post({ type: "send_email", payload: { to: "nobody@example.test" } });
    expect(noKey.res.statusCode).toBe(400);
    expect(noKey.calls).toHaveLength(0);
    const badType = await post({ type: "send_sms", idempotencyKey: "k-3", payload: { to: "nobody@example.test" } });
    expect(badType.res.statusCode).toBe(400);
    expect(badType.calls).toHaveLength(0);
  });
});
