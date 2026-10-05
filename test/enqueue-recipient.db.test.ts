import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadWebConfig } from "../src/config.js";
import { buildServer } from "../src/server.js";

// THIS FILE WRITES TO A DATABASE. It is written but NOT to be run until the owner says so, and only
// against the separate database jobs_test, never jobs_dev. It refuses to run against any other
// database (see the first test hook). Point it at jobs_test with DATABASE_URL in the process
// environment. It touches only rows whose key starts with PREFIX.
const PREFIX = "s4rcpt-";
const config = loadWebConfig();
const pool = new pg.Pool({ connectionString: config.databaseUrl });
const app = buildServer(pool, config);
let base = "";
let counter = 0;

function post(key: string, to: unknown, user: string | null = "user-a") {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (user !== null) headers["x-user-id"] = user;
  return fetch(`${base}/api/jobs`, {
    method: "POST",
    headers,
    body: JSON.stringify({ type: "send_email", idempotencyKey: key, payload: { to, subject: "s", body: "b" } }),
  });
}

const rowsFor = async (key: string) =>
  (await pool.query("SELECT id, status FROM jobs WHERE idempotency_key = $1", [key])).rows;

beforeAll(async () => {
  // Safety: refuse to run anywhere except the separate test database.
  const who = await pool.query("SELECT current_database() AS db");
  if (who.rows[0].db !== "jobs_test") {
    throw new Error(`refusing to run: connected to database "${who.rows[0].db}", expected "jobs_test"`);
  }
  base = await app.listen({ port: 0, host: "127.0.0.1" });
});
beforeEach(async () => {
  await pool.query("DELETE FROM jobs WHERE idempotency_key LIKE $1", [`${PREFIX}%`]);
});
afterAll(async () => {
  await pool.query("DELETE FROM jobs WHERE idempotency_key LIKE $1", [`${PREFIX}%`]);
  await app.close();
  await pool.end();
});

const BAD = ["", "   ", "a b@example.test", "no-at-sign", "a@b@example.test", "a@", "@example.test", "a@localhost", "a,b@example.test", "<a@example.test>"];

describe("S4 against a real database (jobs_test)", () => {
  it("every badly formed recipient is a 400 and leaves NO row", async () => {
    for (const bad of BAD) {
      const key = `${PREFIX}bad-${++counter}`;
      const res = await post(key, bad);
      expect(res.status, JSON.stringify(bad)).toBe(400);
      expect(await rowsFor(key)).toHaveLength(0);
    }
  });

  it("a missing, null or non-text recipient is a 400 and leaves no row", async () => {
    for (const bad of [undefined, null, 42]) {
      const key = `${PREFIX}odd-${++counter}`;
      expect((await post(key, bad)).status).toBe(400);
      expect(await rowsFor(key)).toHaveLength(0);
    }
  });

  it("a well-formed address gives 202 and one pending row, even if the mailbox cannot exist", async () => {
    const key = `${PREFIX}ok-${++counter}`;
    const res = await post(key, "nobody@example.invalid");
    expect(res.status).toBe(202);
    const rows = await rowsFor(key);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("pending");
  });

  it("202, 200, 409 and 401 are unchanged", async () => {
    const key = `${PREFIX}codes-${++counter}`;
    const first = await post(key, "nobody@example.test");
    const again = await post(key, "nobody@example.test");
    expect(first.status).toBe(202);
    expect(again.status).toBe(200);
    expect(((await again.json()) as { id: string }).id).toBe(((await first.json()) as { id: string }).id);
    expect((await post(key, "other@example.test")).status).toBe(409);
    const noUser = `${PREFIX}nouser-${++counter}`;
    expect((await post(noUser, "nobody@example.test", null)).status).toBe(401);
    expect(await rowsFor(noUser)).toHaveLength(0);
    expect(await rowsFor(key)).toHaveLength(1);
  });
});
