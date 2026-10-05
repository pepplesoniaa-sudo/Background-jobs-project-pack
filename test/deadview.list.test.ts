import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerAdminRoutes } from "../src/adminRoutes.js";

// DATABASE-FREE AND MAIL-FREE. The list route runs against a stub pool that answers from canned rows and
// records the SQL it was given. It proves the route's own logic (cap, order, total, payload shaping);
// the same behaviour is also tested against jobs_test in api.test.ts.

const TOKEN = "t".repeat(32);
const SECRET = "secret.person@example.invalid";

function stubPool(rows: Array<Record<string, unknown>>, total: number) {
  const sql: string[] = [];
  const pool = {
    query: async (text: string) => {
      sql.push(text.replace(/\s+/g, " ").trim());
      if (/count\(\*\)/i.test(text)) return { rows: [{ n: total }], rowCount: 1 };
      if (/FROM job_attempts/i.test(text)) return { rows: [], rowCount: 0 };
      return { rows, rowCount: rows.length };
    },
  };
  return { pool, sql };
}

async function getList(rows: Array<Record<string, unknown>>, total: number) {
  const { pool, sql } = stubPool(rows, total);
  const app = Fastify();
  registerAdminRoutes(app, pool as any, { adminToken: TOKEN, maxAttempts: 3 } as any);
  const res = await app.inject({ method: "GET", url: "/api/admin/dead-jobs", headers: { "x-admin-token": TOKEN } });
  await app.close();
  return { res, sql, body: res.json() as any, text: res.body };
}

const row = (id: string, payload: unknown, finished = new Date("2026-10-05T00:31:12.000Z")) => ({
  id, status: "dead", type: "send_email", created_at: new Date("2026-10-05T00:10:00.000Z"), finished_at: finished,
  attempts: 3, max_attempts: 3, last_error: "provider refused with 550", payload, sent_state: null,
});

describe("dead view list route (stub pool)", () => {
  it("asks for at most 100 rows, newest death first, and counts ALL dead jobs separately", async () => {
    const { sql, body } = await getList([row("11111111-1111-4111-8111-111111111111", { to: SECRET })], 105);
    const main = sql.find((s) => s.includes("FROM jobs j LEFT JOIN sent_emails"))!;
    expect(main).toContain("WHERE j.status = 'dead'");
    expect(main).toContain("ORDER BY j.finished_at DESC NULLS LAST, j.created_at DESC");
    expect(main).toMatch(/LIMIT 100$/);
    expect(sql.some((s) => /SELECT count\(\*\)::int AS n FROM jobs WHERE status = 'dead'/.test(s))).toBe(true);
    expect(body.total).toBe(105);
  });

  it("returns finishedAt (when it died) and keeps every earlier field", async () => {
    const { body } = await getList([row("11111111-1111-4111-8111-111111111111", { to: SECRET, subject: "s", body: "b" })], 1);
    const job = body.jobs[0];
    expect(job.finishedAt).toBe("2026-10-05T00:31:12.000Z");
    for (const key of ["id", "status", "type", "createdAt", "attempts", "maxAttempts", "lastError", "payload", "sentState", "checkProviderBeforeRetry", "jobRef", "attempts_history"]) {
      expect(Object.keys(job)).toContain(key);
    }
    expect(job.attempts).toBe(3);
    expect(job.maxAttempts).toBe(3);
  });

  it("never returns the address or any payload field other than to (masked), subject and the body prefix", async () => {
    const { body, text } = await getList(
      [row("11111111-1111-4111-8111-111111111111", { to: SECRET, subject: "hello", body: "A".repeat(200) + "B".repeat(50), apiKey: "should-not-appear-123" })],
      1,
    );
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("secret.person");
    expect(text).not.toContain("should-not-appear-123");
    expect(text).not.toContain("BBBBBBBBBB");
    expect(body.jobs[0].payload).toEqual({ to: "s***@example.invalid", subject: "hello", body: "A".repeat(200), bodyTruncated: true });
  });

  it("a missing subject or body is simply absent; an odd payload does not crash the route", async () => {
    const { body } = await getList(
      [
        row("11111111-1111-4111-8111-111111111111", { to: SECRET }),
        row("22222222-2222-4222-8222-222222222222", null),
        row("33333333-3333-4333-8333-333333333333", { to: 42, subject: 7, body: ["x"] }),
      ],
      3,
    );
    expect(body.jobs[0].payload).toEqual({ to: "s***@example.invalid" });
    expect(body.jobs[1].payload).toEqual({ to: "[invalid]" });
    expect(body.jobs[2].payload).toEqual({ to: "[invalid]" });
  });

  it("a job with no died time returns finishedAt null", async () => {
    const { body } = await getList([{ ...row("11111111-1111-4111-8111-111111111111", { to: SECRET }), finished_at: null }], 1);
    expect(body.jobs[0].finishedAt).toBeNull();
  });
});
