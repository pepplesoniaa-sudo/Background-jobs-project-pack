import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadWebConfig } from "../src/config.js";
import { buildServer } from "../src/server.js";

// Real Postgres (local dev DB) and real HTTP. Test rows are removed by key prefix only.
const PREFIX = "s2test-";
const config = loadWebConfig();
const pool = new pg.Pool({ connectionString: config.databaseUrl });
const app = buildServer(pool, config);
let base = "";

function post(key: string | undefined, payload: object, user: string | null = "user-a", type = "send_email") {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (user !== null) headers["x-user-id"] = user;
  const body: Record<string, unknown> = { type, payload };
  if (key !== undefined) body.idempotencyKey = key;
  return fetch(`${base}/api/jobs`, { method: "POST", headers, body: JSON.stringify(body) });
}

const email = { to: "nobody@example.invalid", subject: "s", body: "b" };

async function rowsFor(key: string) {
  return (await pool.query("SELECT * FROM jobs WHERE idempotency_key = $1", [key])).rows;
}

beforeAll(async () => {
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

describe("FR1 enqueue", () => {
  it("writes one pending row and returns 202 with the job id", async () => {
    const res = await post(`${PREFIX}new`, email);
    expect(res.status).toBe(202);
    const { id } = (await res.json()) as { id: string };
    const rows = await rowsFor(`${PREFIX}new`);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(id);
    expect(rows[0].status).toBe("pending");
    expect(rows[0].attempts).toBe(0);
    expect(rows[0].max_attempts).toBe(config.maxAttempts);
    expect(rows[0].owner_id).toBe("user-a");
    expect(rows[0].payload_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects a request with no x-user-id header", async () => {
    expect((await post(`${PREFIX}nouser`, email, null)).status).toBe(401);
    expect(await rowsFor(`${PREFIX}nouser`)).toHaveLength(0);
  });

  it("rejects a missing key, an unknown type and a non-object payload", async () => {
    expect((await post(undefined, email)).status).toBe(400);
    expect((await post(`${PREFIX}badtype`, email, "user-a", "send_sms")).status).toBe(400);
    expect((await post(`${PREFIX}badpayload`, "text" as unknown as object)).status).toBe(400);
  });
});

describe("T4 duplicate key", () => {
  it("same key twice in a row: one row, same id, 202 then 200", async () => {
    const first = await post(`${PREFIX}seq`, email);
    const second = await post(`${PREFIX}seq`, email);
    expect(first.status).toBe(202);
    expect(second.status).toBe(200);
    const a = (await first.json()) as { id: string };
    const b = (await second.json()) as { id: string };
    expect(b.id).toBe(a.id);
    expect(await rowsFor(`${PREFIX}seq`)).toHaveLength(1);
  });

  it("20 requests at the same instant: exactly one row, one 202, nineteen 200s, one id", async () => {
    const responses = await Promise.all(Array.from({ length: 20 }, () => post(`${PREFIX}race`, email)));
    const statuses = responses.map((r) => r.status);
    const ids = new Set((await Promise.all(responses.map((r) => r.json()))).map((j) => (j as { id: string }).id));
    expect(statuses.filter((s) => s === 202)).toHaveLength(1);
    expect(statuses.filter((s) => s === 200)).toHaveLength(19);
    expect(ids.size).toBe(1);
    expect(await rowsFor(`${PREFIX}race`)).toHaveLength(1);
  });

  it("same key with a different payload gets 409 and changes nothing", async () => {
    const first = await post(`${PREFIX}diff`, email);
    const original = (await first.json()) as { id: string };
    const res = await post(`${PREFIX}diff`, { ...email, subject: "different" });
    expect(res.status).toBe(409);
    const rows = await rowsFor(`${PREFIX}diff`);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(original.id);
  });

  it("same key from a different owner gets 409", async () => {
    await post(`${PREFIX}owner`, email, "user-a");
    expect((await post(`${PREFIX}owner`, email, "user-b")).status).toBe(409);
    expect(await rowsFor(`${PREFIX}owner`)).toHaveLength(1);
  });

  it("payload key order does not make a different payload", async () => {
    await post(`${PREFIX}order`, { to: "x@example.invalid", subject: "s", body: "b" });
    const res = await post(`${PREFIX}order`, { body: "b", subject: "s", to: "x@example.invalid" });
    expect(res.status).toBe(200);
  });
});
