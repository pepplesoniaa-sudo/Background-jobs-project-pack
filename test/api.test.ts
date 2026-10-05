import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ADMIN_PAGE_HTML, ADMIN_PAGE_JS } from "../src/adminPage.js";
import { deadPayloadView, tokenMatches } from "../src/adminRoutes.js";
import { loadWebConfig } from "../src/config.js";
import { enqueueJob } from "../src/enqueue.js";
import { maskPayload, maskRecipient } from "../src/mask.js";
import { jobRefFor, messageIdForRef } from "../src/messageId.js";
import { buildServer } from "../src/server.js";
import { FakeTransport, readMailbox } from "../src/transport.js";
import { runOne, type WorkerDeps } from "../src/worker.js";

// Real Postgres (local dev DB) and real HTTP. Test rows are removed by key prefix only.
const PREFIX = "s7test-";
const config = loadWebConfig();
const pool = new pg.Pool({ connectionString: config.databaseUrl });
const app = buildServer(pool, config);
const dir = mkdtempSync(join(tmpdir(), "bgjobs-s7-"));
let base = "";
let mailboxPath = "";
let counter = 0;

const ADDRESS = "nobody@example.invalid";
const message = { to: ADDRESS, subject: "hello subject", body: "hello body" };
const admin = { "x-admin-token": config.adminToken };

async function newJob(owner = "user-a", maxAttempts = 5): Promise<string> {
  const r = await enqueueJob(pool, {
    ownerId: owner,
    idempotencyKey: `${PREFIX}${++counter}-${Date.now()}`,
    type: "send_email",
    payload: message,
    maxAttempts,
  });
  if (r.outcome !== "created") throw new Error("test job not created");
  return r.jobId;
}

// Puts a job straight into the dead state with some attempt history.
async function deadJob(opts: { attempts?: number; sentState?: "sending" | "sent"; lastError?: string } = {}): Promise<string> {
  const attempts = opts.attempts ?? 5;
  const id = await newJob("user-a", attempts);
  await pool.query("UPDATE jobs SET status='dead', attempts=$2, finished_at=now(), last_error=$3 WHERE id=$1", [
    id,
    attempts,
    opts.lastError ?? "provider outcome unknown: provider 503",
  ]);
  for (let n = 1; n <= attempts; n++) {
    await pool.query(
      `INSERT INTO job_attempts (job_id, attempt_no, worker_id, finished_at, error, backoff_bound_ms, delay_ms)
       VALUES ($1, $2, 'w1', now(), 'provider outcome unknown: provider 503', $3, $4)`,
      [id, n, n < attempts ? 100 * n : null, n < attempts ? 50 * n : null],
    );
  }
  if (opts.sentState) await pool.query("INSERT INTO sent_emails (job_id, state) VALUES ($1, $2)", [id, opts.sentState]);
  return id;
}

async function cleanup() {
  const ids = `SELECT id FROM jobs WHERE idempotency_key LIKE '${PREFIX}%'`;
  await pool.query(`DELETE FROM sent_emails WHERE job_id IN (${ids})`);
  await pool.query(`DELETE FROM job_attempts WHERE job_id IN (${ids})`);
  await pool.query(`DELETE FROM jobs WHERE idempotency_key LIKE '${PREFIX}%'`);
}

const jobRow = async (id: string) => (await pool.query("SELECT * FROM jobs WHERE id = $1", [id])).rows[0];
const get = (path: string, headers: Record<string, string> = {}) => fetch(`${base}${path}`, { headers });
const retry = (id: string, headers: Record<string, string> = admin) =>
  fetch(`${base}/api/admin/dead-jobs/${id}/retry`, { method: "POST", headers });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  base = await app.listen({ port: 0, host: "127.0.0.1" });
});
beforeEach(async () => {
  await cleanup();
  mailboxPath = join(dir, `mailbox-${++counter}.jsonl`);
});
afterAll(async () => {
  await cleanup();
  await app.close();
  await pool.end();
  rmSync(dir, { recursive: true, force: true });
});

describe("FR11 GET /api/jobs/:id", () => {
  it("the owner sees id, status, attempts, max_attempts, run_at, finished_at and a safe error", async () => {
    const id = await newJob("user-a", 4);
    const res = await get(`/api/jobs/${id}`, { "x-user-id": "user-a" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["attempts", "error", "finishedAt", "id", "maxAttempts", "runAt", "status"]);
    expect(body).toMatchObject({ id, status: "pending", attempts: 0, maxAttempts: 4, finishedAt: null, error: null });
    expect(new Date(body.runAt as string).getTime()).not.toBeNaN();
  });

  it("shows last_error for a dead job, and never the payload or the address", async () => {
    const id = await deadJob({ lastError: "provider refused with 422" });
    const res = await get(`/api/jobs/${id}`, { "x-user-id": "user-a" });
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({ status: "dead", error: "provider refused with 422" });
    expect(text).not.toContain(ADDRESS);
    expect(text).not.toContain("hello body");
    expect(text).not.toContain("hello subject");
  });

  it("anyone else gets 404, the same as a job that does not exist", async () => {
    const id = await newJob("user-a");
    const other = await get(`/api/jobs/${id}`, { "x-user-id": "user-b" });
    const missing = await get(`/api/jobs/00000000-0000-4000-8000-000000000000`, { "x-user-id": "user-a" });
    expect(other.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await other.json()).toEqual(await missing.json());
  });

  it("an id that is not a UUID is a 404, and a missing header is a 401", async () => {
    expect((await get(`/api/jobs/not-a-uuid`, { "x-user-id": "user-a" })).status).toBe(404);
    expect((await get(`/api/jobs/${await newJob()}`)).status).toBe(401);
  });
});

describe("FR12 admin gate", () => {
  it("dead letter API routes need the token: none and wrong both get 401", async () => {
    const id = await deadJob();
    expect((await get("/api/admin/dead-jobs")).status).toBe(401);
    expect((await get("/api/admin/dead-jobs", { "x-admin-token": "wrong-token-wrong-token" })).status).toBe(401);
    expect((await retry(id, {})).status).toBe(401);
    expect((await retry(id, { "x-admin-token": "wrong-token-wrong-token" })).status).toBe(401);
    expect((await jobRow(id)).status).toBe("dead"); // nothing changed
  });

  it("the token in a URL does not authenticate", async () => {
    expect((await get(`/api/admin/dead-jobs?token=${config.adminToken}`)).status).toBe(401);
    expect((await get(`/api/admin/dead-jobs?x-admin-token=${config.adminToken}`)).status).toBe(401);
  });

  it("a job owner's x-user-id does not open the admin routes", async () => {
    expect((await get("/api/admin/dead-jobs", { "x-user-id": "user-a" })).status).toBe(401);
  });

  it("tokenMatches is exact and handles different lengths", () => {
    expect(tokenMatches("abc", "abc")).toBe(true);
    expect(tokenMatches("abd", "abc")).toBe(false);
    expect(tokenMatches("ab", "abc")).toBe(false);
    expect(tokenMatches("abcd", "abc")).toBe(false);
    expect(tokenMatches(undefined, "abc")).toBe(false);
    expect(tokenMatches(["abc"], "abc")).toBe(false);
  });

  it("the page is served without data or token, with a strict content security policy", async () => {
    await deadJob();
    const page = await get("/admin/dead");
    const html = await page.text();
    expect(page.status).toBe(200);
    expect(html).toBe(ADMIN_PAGE_HTML);
    expect(html).not.toContain(config.adminToken);
    expect(html).not.toContain(ADDRESS);
    expect(page.headers.get("content-security-policy")).toContain("script-src 'self'");
    const script = await get("/admin/dead.js");
    expect(script.status).toBe(200);
    expect(await script.text()).toBe(ADMIN_PAGE_JS);
  });

  it("the page script writes database text with textContent only, and puts the token in a header", () => {
    expect(ADMIN_PAGE_JS).not.toContain("innerHTML");
    expect(ADMIN_PAGE_JS).not.toContain("document.write");
    expect(ADMIN_PAGE_JS).toContain("textContent");
    expect(ADMIN_PAGE_JS).toContain('"x-admin-token"');
    expect(ADMIN_PAGE_JS).not.toMatch(/\?token=|location\.search|localStorage|sessionStorage/);
  });
});

describe("FR10 dead letter list", () => {
  it("lists only dead jobs, with history, masked recipient and email state", async () => {
    const dead = await deadJob({ attempts: 3, sentState: "sent" });
    const pending = await newJob();
    const res = await get("/api/admin/dead-jobs", admin);
    expect(res.status).toBe(200);
    const text = await res.text();
    const mine = (JSON.parse(text).jobs as Array<Record<string, unknown>>).filter((j) => [dead, pending].includes(j.id as string));
    expect(mine.map((j) => j.id)).toEqual([dead]);

    const job = mine[0] as Record<string, any>;
    expect(job).toMatchObject({ type: "send_email", attempts: 3, maxAttempts: 3, sentState: "sent", checkProviderBeforeRetry: false });
    expect(job.lastError).toBe("provider outcome unknown: provider 503");
    expect(job.createdAt).toBeTruthy();
    expect(job.attempts_history.map((a: any) => a.attemptNo)).toEqual([1, 2, 3]);
    expect(job.attempts_history[0]).toMatchObject({ backoffBoundMs: 100, delayMs: 50 });
    expect(job.attempts_history[2]).toMatchObject({ backoffBoundMs: null, delayMs: null });

    expect(job.payload.to).toBe("n***@example.invalid");
    expect(job.payload.subject).toBe("hello subject");
    expect(text).not.toContain(ADDRESS); // the full address appears nowhere in the response
  });

  it("a job whose email state is 'sending' is flagged: check the provider before retrying", async () => {
    const id = await deadJob({ sentState: "sending" });
    const res = await get("/api/admin/dead-jobs", admin);
    const job = ((await res.json()) as any).jobs.find((j: any) => j.id === id);
    expect(job.sentState).toBe("sending");
    expect(job.checkProviderBeforeRetry).toBe(true);
  });

  it("every dead job carries its jobRef (first 20 hex of the SHA-256 of the job id) and no search string", async () => {
    const unknown = await deadJob({ sentState: "sending" });
    const none = await deadJob();
    const sent = await deadJob({ sentState: "sent" });
    const jobs = ((await (await get("/api/admin/dead-jobs", admin)).json()) as any).jobs;
    for (const id of [unknown, none, sent]) {
      const job = jobs.find((j: any) => j.id === id);
      expect(job.jobRef).toBe(createHash("sha256").update(id).digest("hex").slice(0, 20));
      expect(Object.keys(job)).not.toContain("providerSearch");
    }
  });

  it("the page shows the job ref, and the raw job id is in no header or Message-ID", () => {
    const id = "0765bf9f-07ee-45ef-9b45-39af6173e08d";
    const ref = createHash("sha256").update(id).digest("hex").slice(0, 20);
    expect(jobRefFor(id)).toBe(ref);
    expect(messageIdForRef(ref, "example.invalid")).toBe(`<${ref}@example.invalid>`);
    expect(messageIdForRef(ref, "example.invalid")).not.toContain(id);
    expect(ADMIN_PAGE_JS).toContain("job.jobRef");
    expect(ADMIN_PAGE_JS).toContain("X-Job-Ref");
    expect(ADMIN_PAGE_JS).not.toContain("providerSearch");
  });

  it("a job with no email row has a null state", async () => {
    const id = await deadJob();
    const job = ((await (await get("/api/admin/dead-jobs", admin)).json()) as any).jobs.find((j: any) => j.id === id);
    expect(job.sentState).toBeNull();
    expect(job.checkProviderBeforeRetry).toBe(false);
  });

  it("masking handles odd payloads", () => {
    expect(maskRecipient("nobody@example.invalid")).toBe("n***@example.invalid");
    expect(maskRecipient("a@b.c")).toBe("a***@b.c");
    expect(maskRecipient("no-at-sign")).toBe("n***");
    expect(maskRecipient(42)).toBe("[invalid]");
    expect(maskRecipient("")).toBe("[invalid]");
    expect(maskPayload("text")).toEqual({ to: "[invalid]" });
    expect(maskPayload(null)).toEqual({ to: "[invalid]" });
    expect(maskPayload({ to: "x@y.z", subject: "s" })).toEqual({ to: "x***@y.z", subject: "s" });
  });
});

describe("manual retry", () => {
  it("a dead job goes to pending with a fresh allowance, and attempts is not reset", async () => {
    const id = await deadJob({ attempts: 5 });
    const res = await retry(id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id, status: "pending" });
    const job = await jobRow(id);
    expect(job.status).toBe("pending");
    expect(job.attempts).toBe(5);
    expect(job.max_attempts).toBe(5 + config.maxAttempts);
    expect(job.locked_by).toBeNull();
    // due now, judged by the database clock that set it (the host clock can differ by tens of ms)
    const due = await pool.query("SELECT run_at <= now() AS is_due FROM jobs WHERE id = $1", [id]);
    expect(due.rows[0].is_due).toBe(true);
  });

  it("only acts on dead rows: pending, processing, failed and succeeded get 409 and are untouched", async () => {
    for (const status of ["pending", "processing", "failed", "succeeded"]) {
      const id = await newJob();
      await pool.query("UPDATE jobs SET status = $2 WHERE id = $1", [id, status]);
      expect((await retry(id)).status).toBe(409);
      expect((await jobRow(id)).status).toBe(status);
      expect((await jobRow(id)).max_attempts).toBe(config.maxAttempts);
    }
  });

  it("a second retry on the same job is a 409, not a second allowance", async () => {
    const id = await deadJob({ attempts: 2 });
    expect((await retry(id)).status).toBe(200);
    expect((await retry(id)).status).toBe(409);
    expect((await jobRow(id)).max_attempts).toBe(2 + config.maxAttempts);
  });

  it("an unknown id is 404 and a malformed id is 404", async () => {
    expect((await retry("00000000-0000-4000-8000-000000000000")).status).toBe(404);
    expect((await retry("not-a-uuid")).status).toBe(404);
  });

  it("20 simultaneous retries grant the allowance exactly once", async () => {
    const id = await deadJob({ attempts: 2 });
    const results = await Promise.all(Array.from({ length: 20 }, () => retry(id)));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(19);
    expect((await jobRow(id)).max_attempts).toBe(2 + config.maxAttempts);
  });

  function deps(over: Partial<WorkerDeps> = {}): WorkerDeps {
    return {
      pool,
      transport: new FakeTransport(mailboxPath, 0),
      sendTimeoutMs: 30000,
      uncertainSendPolicy: "resend",
      backoffBaseMs: 50,
      backoffCapMs: 10000,
      ...over,
    };
  }

  it("a retried job runs again and its attempt numbers continue, history kept", async () => {
    // Make a real dead job: 2 allowed attempts, every send fails.
    const id = await newJob("user-a", 2);
    const failing = deps({ transport: new FakeTransport(mailboxPath, 0, true) });
    await runOne(failing, "w1", () => {});
    await sleep(120); // longer than the first backoff bound (50 ms)
    await runOne(failing, "w1", () => {});
    expect((await jobRow(id)).status).toBe("dead");
    expect((await jobRow(id)).attempts).toBe(2);

    expect((await retry(id)).status).toBe(200);

    // The provider is healthy now, so the retried job succeeds as attempt 3.
    expect(await runOne(deps(), "w2", () => {})).toBe(true);
    const job = await jobRow(id);
    expect(job.status).toBe("succeeded");
    expect(job.attempts).toBe(3);
    const history = (await pool.query("SELECT attempt_no, worker_id, error FROM job_attempts WHERE job_id = $1 ORDER BY attempt_no", [id])).rows;
    expect(history.map((h) => h.attempt_no)).toEqual([1, 2, 3]);
    expect(history[0].error).not.toBeNull();
    expect(history[1].error).not.toBeNull();
    expect(history[2]).toMatchObject({ worker_id: "w2", error: null });
    expect((await readMailbox(mailboxPath)).filter((e) => e.idempotencyKey === id)).toHaveLength(1);
  });

  it("under flag_for_human a retry of a job whose email state is 'sending' dies again with 'uncertain send'", async () => {
    const id = await deadJob({ attempts: 2, sentState: "sending" });
    expect((await retry(id)).status).toBe(200);
    await runOne(deps({ uncertainSendPolicy: "flag_for_human" }), "w2", () => {});
    const job = await jobRow(id);
    expect(job.status).toBe("dead");
    expect(job.attempts).toBe(3);
    expect(job.last_error).toBe("uncertain send");
    expect(await readMailbox(mailboxPath)).toHaveLength(0);
  });
});

describe("mark as not sent (closes the 'sending' gap under flag_for_human)", () => {
  const markNotSent = (id: string, headers: Record<string, string> = admin) =>
    fetch(`${base}/api/admin/dead-jobs/${id}/mark-not-sent`, { method: "POST", headers });
  const sentRow = async (id: string) => (await pool.query("SELECT state FROM sent_emails WHERE job_id = $1", [id])).rows[0];

  function deps(over: Partial<WorkerDeps> = {}): WorkerDeps {
    return {
      pool,
      transport: new FakeTransport(mailboxPath, 0),
      sendTimeoutMs: 30000,
      uncertainSendPolicy: "flag_for_human",
      backoffBaseMs: 50,
      backoffCapMs: 10000,
      ...over,
    };
  }

  it("needs the admin token and changes nothing without it", async () => {
    const id = await deadJob({ sentState: "sending" });
    expect((await markNotSent(id, {})).status).toBe(401);
    expect((await markNotSent(id, { "x-admin-token": "wrong-token-wrong-token" })).status).toBe(401);
    expect((await sentRow(id)).state).toBe("sending");
  });

  it("clears the 'sending' record of a dead job; the list then shows no email state", async () => {
    const id = await deadJob({ sentState: "sending" });
    const res = await markNotSent(id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id, sentState: null });
    expect(await sentRow(id)).toBeUndefined();
    const job = ((await (await get("/api/admin/dead-jobs", admin)).json()) as any).jobs.find((j: any) => j.id === id);
    expect(job.sentState).toBeNull();
    expect(job.checkProviderBeforeRetry).toBe(false);
    expect((await jobRow(id)).status).toBe("dead"); // it does not retry the job by itself
  });

  it("then a retry really sends the email under flag_for_human (one message)", async () => {
    const id = await deadJob({ attempts: 2, sentState: "sending", lastError: "uncertain send" });
    expect((await markNotSent(id)).status).toBe(200);
    expect((await retry(id)).status).toBe(200);
    expect(await runOne(deps(), "w2", () => {})).toBe(true);
    const job = await jobRow(id);
    expect(job.status).toBe("succeeded");
    expect(job.attempts).toBe(3);
    expect((await sentRow(id)).state).toBe("sent");
    expect((await readMailbox(mailboxPath)).filter((e) => e.idempotencyKey === id)).toHaveLength(1);
  });

  it("refuses when the job is not dead, even if a 'sending' row exists, and keeps the row", async () => {
    for (const status of ["pending", "processing", "failed", "succeeded"]) {
      const id = await newJob();
      await pool.query("UPDATE jobs SET status = $2 WHERE id = $1", [id, status]);
      await pool.query("INSERT INTO sent_emails (job_id, state) VALUES ($1, 'sending')", [id]);
      const res = await markNotSent(id);
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: "job is not dead" });
      expect((await sentRow(id)).state).toBe("sending");
    }
  });

  it("refuses when a dead job has no 'sending' record, or a 'sent' one, and keeps 'sent'", async () => {
    const none = await deadJob();
    const noneRes = await markNotSent(none);
    expect(noneRes.status).toBe(409);
    expect(await noneRes.json()).toEqual({ error: "no unknown-outcome send to clear" });

    const sent = await deadJob({ sentState: "sent" });
    expect((await markNotSent(sent)).status).toBe(409);
    expect((await sentRow(sent)).state).toBe("sent"); // a confirmed send is never erased
  });

  it("404 for an unknown or malformed id, and other jobs' records are untouched", async () => {
    const other = await deadJob({ sentState: "sending" });
    expect((await markNotSent("00000000-0000-4000-8000-000000000000")).status).toBe(404);
    expect((await markNotSent("not-a-uuid")).status).toBe(404);
    expect((await sentRow(other)).state).toBe("sending");
  });

  it("20 simultaneous calls clear it exactly once", async () => {
    const id = await deadJob({ sentState: "sending" });
    const results = await Promise.all(Array.from({ length: 20 }, () => markNotSent(id)));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(19);
  });

  it("logs the job id and nothing personal", async () => {
    const id = await deadJob({ sentState: "sending" });
    const captured: string[] = [];
    const logged = buildServer(pool, config, { write: (m) => void captured.push(m) });
    await logged.ready();
    const res = await logged.inject({ method: "POST", url: `/api/admin/dead-jobs/${id}/mark-not-sent`, headers: admin });
    await logged.close();
    expect(res.statusCode).toBe(200);
    const text = captured.join("");
    expect(text).toContain("operator marked job as not sent");
    expect(text).toContain(id);
    expect(text).not.toContain(ADDRESS);
    expect(text).not.toContain(config.adminToken);
  });

  it("the page offers the button only for 'sending' jobs and asks for confirmation", () => {
    expect(ADMIN_PAGE_JS).toContain("mark-not-sent");
    expect(ADMIN_PAGE_JS).toContain("Mark as not sent");
    expect(ADMIN_PAGE_JS).toMatch(/sentState === "sending"[\s\S]*Mark as not sent/);
    expect(ADMIN_PAGE_JS).toContain("window.confirm");
    expect(ADMIN_PAGE_JS).not.toContain("innerHTML");
  });
});

describe("request handling found by the end-to-end run", () => {
  it("retry accepts an empty POST that carries a form content type (some clients send one)", async () => {
    const id = await deadJob({ attempts: 2 });
    const res = await fetch(`${base}/api/admin/dead-jobs/${id}/retry`, {
      method: "POST",
      headers: { ...admin, "content-type": "application/x-www-form-urlencoded" },
    });
    expect(res.status).toBe(200);
    expect((await jobRow(id)).status).toBe("pending");
  });

  it("the gate still runs first: a form-typed POST without the token is 401, not 415", async () => {
    const id = await deadJob({ attempts: 2 });
    const res = await fetch(`${base}/api/admin/dead-jobs/${id}/retry`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(res.status).toBe(401);
    expect((await jobRow(id)).status).toBe("dead");
  });

  it("request logs keep the path but never the query string, headers or a body", async () => {
    const captured: string[] = [];
    const logged = buildServer(pool, config, { write: (m) => void captured.push(m) });
    await logged.ready();
    const secret = config.adminToken;
    await logged.inject({ method: "GET", url: `/api/admin/dead-jobs?token=${secret}` });
    await logged.inject({ method: "GET", url: "/api/admin/dead-jobs", headers: admin });
    await logged.inject({
      method: "POST",
      url: "/api/jobs",
      headers: { "x-user-id": "user-a", "content-type": "application/json" },
      payload: JSON.stringify({ type: "send_email", payload: message, idempotencyKey: `${PREFIX}log-${Date.now()}` }),
    });
    await logged.close();
    const text = captured.join("");
    expect(text).toContain("/api/admin/dead-jobs");
    expect(text).not.toContain(secret);
    expect(text).not.toContain("token=");
    expect(text).not.toContain(ADDRESS);
    expect(text).not.toContain("hello body");
  });
});

describe("config", () => {
  const base = { DATABASE_URL: "x", MAX_ATTEMPTS: "5", PORT: "3000" };
  it("ADMIN_TOKEN is required and at least 16 characters", () => {
    expect(() => loadWebConfig(base)).toThrow(/ADMIN_TOKEN/);
    expect(() => loadWebConfig({ ...base, ADMIN_TOKEN: "short" })).toThrow(/ADMIN_TOKEN/);
    expect(loadWebConfig({ ...base, ADMIN_TOKEN: "x".repeat(16) }).adminToken).toHaveLength(16);
  });
});

describe("S8 mark as sent (the email WAS delivered)", () => {
  const markSent = (id: string, headers: Record<string, string> = admin) =>
    fetch(`${base}/api/admin/dead-jobs/${id}/mark-sent`, { method: "POST", headers });
  const sentRow = async (id: string) => (await pool.query("SELECT state FROM sent_emails WHERE job_id = $1", [id])).rows[0];

  it("a dead job with a 'sending' row becomes succeeded, with finished_at and the operator note, and the email row becomes 'sent'", async () => {
    const id = await deadJob({ sentState: "sending", lastError: "uncertain send" });
    const res = await markSent(id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id, status: "succeeded", sentState: "sent" });
    const job = await jobRow(id);
    expect(job.status).toBe("succeeded");
    expect(job.finished_at).not.toBeNull();
    expect(job.last_error).toBe("marked sent by operator");
    expect(job.locked_by).toBeNull();
    expect((await sentRow(id)).state).toBe("sent");
    const listed = ((await (await get("/api/admin/dead-jobs", admin)).json()) as any).jobs;
    expect(listed.find((j: any) => j.id === id)).toBeUndefined(); // it has left the dead list
  });

  it("a job that is not dead gets 409 and nothing changes (the 'sending' row stays)", async () => {
    for (const status of ["pending", "processing", "failed", "succeeded"]) {
      const id = await newJob();
      await pool.query("UPDATE jobs SET status = $2, last_error = 'unchanged' WHERE id = $1", [id, status]);
      await pool.query("INSERT INTO sent_emails (job_id, state) VALUES ($1, 'sending')", [id]);
      const res = await markSent(id);
      expect(res.status, status).toBe(409);
      expect(await res.json()).toEqual({ error: "job is not dead" });
      const job = await jobRow(id);
      expect(job.status).toBe(status);
      expect(job.last_error).toBe("unchanged");
      expect((await sentRow(id)).state).toBe("sending");
    }
  });

  it("a dead job with no 'sending' row (or an already 'sent' one) gets 409 and the job stays dead: the transaction is rolled back", async () => {
    const none = await deadJob();
    const noneRes = await markSent(none);
    expect(noneRes.status).toBe(409);
    expect(await noneRes.json()).toEqual({ error: "no unknown-outcome send to mark as sent" });
    const after = await jobRow(none);
    expect(after.status).toBe("dead");
    expect(after.last_error).toBe("provider outcome unknown: provider 503");

    const sent = await deadJob({ sentState: "sent" });
    expect((await markSent(sent)).status).toBe(409);
    expect((await jobRow(sent)).status).toBe("dead");
  });

  it("a wrong token gives 401, a missing token gives 401, and an EMPTY token unlocks nothing", async () => {
    const id = await deadJob({ sentState: "sending" });
    expect((await markSent(id, { "x-admin-token": "wrong-token-wrong-token" })).status).toBe(401);
    expect((await markSent(id, {})).status).toBe(401);
    expect((await markSent(id, { "x-admin-token": "" })).status).toBe(401);
    expect((await get("/api/admin/dead-jobs", { "x-admin-token": "" })).status).toBe(401);
    expect(tokenMatches("", config.adminToken)).toBe(false);
    expect((await jobRow(id)).status).toBe("dead");
    expect((await sentRow(id)).state).toBe("sending");
  });

  it("retry and mark-not-sent on a succeeded job are refused with 409, also right after it was marked sent", async () => {
    const id = await deadJob({ sentState: "sending" });
    expect((await markSent(id)).status).toBe(200);
    expect((await retry(id)).status).toBe(409);
    const notSent = await fetch(`${base}/api/admin/dead-jobs/${id}/mark-not-sent`, { method: "POST", headers: admin });
    expect(notSent.status).toBe(409);
    expect((await markSent(id)).status).toBe(409); // not twice
    expect((await jobRow(id)).status).toBe("succeeded");
    expect((await sentRow(id)).state).toBe("sent"); // a confirmed send is never erased
  });

  it("404 for an unknown or malformed id; other jobs are untouched", async () => {
    const other = await deadJob({ sentState: "sending" });
    expect((await markSent("00000000-0000-4000-8000-000000000000")).status).toBe(404);
    expect((await markSent("not-a-uuid")).status).toBe(404);
    expect((await jobRow(other)).status).toBe("dead");
  });

  it("20 simultaneous calls succeed exactly once", async () => {
    const id = await deadJob({ sentState: "sending" });
    const results = await Promise.all(Array.from({ length: 20 }, () => markSent(id)));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(19);
  });

  it("logs the job id and nothing personal, and the request log keeps the path only", async () => {
    const id = await deadJob({ sentState: "sending" });
    const captured: string[] = [];
    const logged = buildServer(pool, config, { write: (m) => void captured.push(m) });
    await logged.ready();
    const res = await logged.inject({ method: "POST", url: `/api/admin/dead-jobs/${id}/mark-sent?x=${config.adminToken}`, headers: admin });
    await logged.close();
    expect(res.statusCode).toBe(200);
    const text = captured.join("");
    expect(text).toContain("operator marked job as sent");
    expect(text).toContain(id);
    expect(text).not.toContain(ADDRESS);
    expect(text).not.toContain(config.adminToken);
  });
});

describe("S8 the dead page", () => {
  it("the list carries each job's status and its attempt history with worker id, start, finish and error", async () => {
    const id = await deadJob({ attempts: 3, sentState: "sending" });
    const job = ((await (await get("/api/admin/dead-jobs", admin)).json()) as any).jobs.find((j: any) => j.id === id);
    expect(job.status).toBe("dead");
    expect(job.attempts_history).toHaveLength(3);
    for (const a of job.attempts_history) {
      expect(a.workerId).toBe("w1");
      expect(a.startedAt).toBeTruthy();
      expect(a.finishedAt).toBeTruthy();
      expect(a.error).toBe("provider outcome unknown: provider 503");
    }
  });

  it("the page shows the S3 reference with the Sent-folder wording and warns that retry and mark-not-sent can send a duplicate", () => {
    expect(ADMIN_PAGE_JS).toContain("Search the Sent folder of the sending account for this reference");
    expect(ADMIN_PAGE_JS).toContain("job.jobRef");
    expect(ADMIN_PAGE_JS).toContain("Retry and Mark as not sent can each send a duplicate");
    const retryFn = /async function retry\(job\)[\s\S]*?\n  }\n/.exec(ADMIN_PAGE_JS)![0];
    const notSentFn = /async function markNotSent\(job\)[\s\S]*?\n  }\n/.exec(ADMIN_PAGE_JS)![0];
    expect(retryFn).toContain("DUPLICATE");
    expect(notSentFn).toContain("DUPLICATE");
    expect(retryFn).toContain("window.confirm");
    expect(notSentFn).toContain("window.confirm");
  });

  it("the buttons exist only for rows whose status is dead; mark-as-sent only for a 'sending' row", () => {
    const actions = /var actionCell = el\("td"\);[\s\S]*?row\.appendChild\(actionCell\);/.exec(ADMIN_PAGE_JS)![0];
    expect(actions).toMatch(/if \(job\.status === "dead"\) \{[\s\S]*"Retry"/);
    expect(actions).toMatch(/job\.sentState === "sending"[\s\S]*"Mark as not sent"[\s\S]*"Confirm mark as sent"/);
    // no other place creates an action button
    expect(ADMIN_PAGE_JS.split('el("button"').length - 1).toBe(3);
    expect(ADMIN_PAGE_JS).toContain("mark-sent");
  });

  it("the page script and page contain no token, no innerHTML, no storage, no cookie, and no token in a URL", async () => {
    for (const text of [ADMIN_PAGE_JS, ADMIN_PAGE_HTML]) {
      expect(text).not.toContain(config.adminToken);
      expect(text).not.toContain("innerHTML");
      expect(text).not.toContain("outerHTML");
      expect(text).not.toContain("insertAdjacentHTML");
      expect(text).not.toContain("document.write");
      expect(text).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie/);
      expect(text).not.toMatch(/[?&]token=/);
    }
    expect(ADMIN_PAGE_JS).toContain('"x-admin-token"'); // header only
    const page = await get("/admin/dead");
    expect(await page.text()).not.toContain(config.adminToken);
    expect(page.headers.get("content-security-policy")).toBe(
      "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'",
    );
  });
});

describe("dead view: list cap, order, total, finished time, payload privacy", () => {
  const SECRET_ADDRESS = "secret.person@example.invalid";

  // A dead job with an exact payload and an exact finished_at (seconds ago).
  async function deadWith(payload: Record<string, unknown>, diedSecondsAgo = 0): Promise<string> {
    const r = await enqueueJob(pool, {
      ownerId: "user-a", idempotencyKey: `${PREFIX}dv-${++counter}-${Date.now()}`, type: "send_email", payload, maxAttempts: 3,
    });
    if (r.outcome !== "created") throw new Error("test job not created");
    await pool.query(
      "UPDATE jobs SET status='dead', attempts=3, finished_at = now() - ($2 * interval '1 second'), last_error='provider refused with 550' WHERE id=$1",
      [r.jobId, diedSecondsAgo],
    );
    return r.jobId;
  }
  const list = async () => ((await (await get("/api/admin/dead-jobs", admin)).json()) as any);

  it("returns at most 100 jobs, newest death first, and the TOTAL number of dead jobs", async () => {
    await pool.query(
      `INSERT INTO jobs (type, owner_id, payload, payload_hash, status, attempts, max_attempts, finished_at, last_error, idempotency_key)
       SELECT 'send_email', 'user-a', $1::jsonb, 'h', 'dead', 3, 3, now() - (g * interval '1 second'), 'x', $2 || g
       FROM generate_series(1, 105) AS g`,
      [JSON.stringify({ to: "nobody@example.invalid", subject: "s", body: "b" }), `${PREFIX}cap-`],
    );
    const body = await list();
    const counted = (await pool.query("SELECT count(*)::int AS n FROM jobs WHERE status = 'dead'")).rows[0].n;
    expect(counted).toBeGreaterThanOrEqual(105);
    expect(body.total).toBe(counted);
    expect(body.jobs).toHaveLength(100);
    const times = body.jobs.map((j: any) => new Date(j.finishedAt).getTime());
    for (let i = 1; i < times.length; i++) expect(times[i - 1]).toBeGreaterThanOrEqual(times[i]); // newest first
    // the five oldest (g = 101..105 seconds ago) are the ones cut off
    const keys = (await pool.query("SELECT id FROM jobs WHERE idempotency_key = ANY($1)", [[101, 102, 103, 104, 105].map((g) => `${PREFIX}cap-${g}`)])).rows.map((r) => r.id);
    const listed = new Set(body.jobs.map((j: any) => j.id));
    for (const id of keys) expect(listed.has(id)).toBe(false);
  });

  it("each job carries finishedAt (when it died), createdAt, attempts and maxAttempts", async () => {
    const id = await deadWith({ to: ADDRESS, subject: "s", body: "b" }, 30);
    const job = (await list()).jobs.find((j: any) => j.id === id);
    const row = await jobRow(id);
    expect(new Date(job.finishedAt).getTime()).toBe(new Date(row.finished_at).getTime());
    expect(job.createdAt).toBeTruthy();
    expect(job.attempts).toBe(3);
    expect(job.maxAttempts).toBe(3);
  });

  it("the recipient address appears NOWHERE in the response, and no other payload field gets through", async () => {
    const id = await deadWith({ to: SECRET_ADDRESS, subject: "hello", body: "short body", apiKey: "should-not-appear-123", extra: { nested: true } });
    const res = await get("/api/admin/dead-jobs", admin);
    const text = await res.text();
    expect(text).not.toContain(SECRET_ADDRESS);
    expect(text).not.toContain("secret.person");
    expect(text).not.toContain("should-not-appear-123");
    const job = JSON.parse(text).jobs.find((j: any) => j.id === id);
    expect(job.payload).toEqual({ to: "s***@example.invalid", subject: "hello", body: "short body", bodyTruncated: false });
  });

  it("the subject and a 200-character body prefix are present, the rest of a long body is cut", async () => {
    const body = "A".repeat(200) + "B".repeat(60);
    const id = await deadWith({ to: ADDRESS, subject: "long one", body });
    const text = await (await get("/api/admin/dead-jobs", admin)).text();
    const job = JSON.parse(text).jobs.find((j: any) => j.id === id);
    expect(job.payload.subject).toBe("long one");
    expect(job.payload.body).toBe("A".repeat(200));
    expect(job.payload.bodyTruncated).toBe(true);
    expect(text).not.toContain("BBBBBBBBBB"); // nothing past character 200 left the server
    const exact = await deadWith({ to: ADDRESS, subject: "s", body: "C".repeat(200) });
    const exactJob = (await list()).jobs.find((j: any) => j.id === exact);
    expect(exactJob.payload.body).toBe("C".repeat(200));
    expect(exactJob.payload.bodyTruncated).toBe(false); // exactly 200 is not cut
  });

  it("counts characters, not bytes: 201 emoji become 200 emoji", async () => {
    const id = await deadWith({ to: ADDRESS, subject: "s", body: "\u{1F600}".repeat(201) });
    const job = (await list()).jobs.find((j: any) => j.id === id);
    expect([...job.payload.body]).toHaveLength(200);
    expect(job.payload.bodyTruncated).toBe(true);
  });

  it("a missing subject or body is left out of the payload (the page shows '(none)'), and odd payloads do not crash the list", async () => {
    const noSubject = await deadWith({ to: ADDRESS, body: "only a body" });
    const noBody = await deadWith({ to: ADDRESS, subject: "only a subject" });
    const odd = await deadWith({ to: 42, subject: 7, body: ["x"] });
    const jobs = (await list()).jobs;
    const a = jobs.find((j: any) => j.id === noSubject);
    const b = jobs.find((j: any) => j.id === noBody);
    const c = jobs.find((j: any) => j.id === odd);
    expect("subject" in a.payload).toBe(false);
    expect(a.payload.body).toBe("only a body");
    expect("body" in b.payload).toBe(false);
    expect(b.payload.subject).toBe("only a subject");
    expect(c.payload).toEqual({ to: "[invalid]" });
  });

  it("deadPayloadView is the only thing that shapes the payload", () => {
    expect(deadPayloadView(null)).toEqual({ to: "[invalid]" });
    expect(deadPayloadView("text")).toEqual({ to: "[invalid]" });
    expect(deadPayloadView({ to: "x@y.z", subject: "s", body: "b", token: "t" })).toEqual({
      to: "x***@y.z", subject: "s", body: "b", bodyTruncated: false,
    });
  });

  it("the 401 answer does not repeat the token that was sent", async () => {
    const sent = "this-is-a-wrong-token-1234567890";
    const res = await get("/api/admin/dead-jobs", { "x-admin-token": sent });
    expect(res.status).toBe(401);
    const text = await res.text();
    expect(text).toBe('{"error":"admin token required"}');
    expect(text).not.toContain(sent);
    expect(text).not.toContain(config.adminToken);
  });
});
