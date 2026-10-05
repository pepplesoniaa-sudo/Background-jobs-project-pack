import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import type { WebConfig } from "./config.js";
import { ADMIN_PAGE_HTML, ADMIN_PAGE_JS } from "./adminPage.js";
import { maskPayload } from "./mask.js";
import { jobRefFor } from "./messageId.js";
import { runInTransaction } from "./transaction.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEAD_JOB_LIMIT = 100;
const BODY_PREFIX_CHARS = 200;

const sha256 = (value: string) => createHash("sha256").update(value).digest();

// What the dead page may show of a payload: the masked recipient, the subject, and only the first
// BODY_PREFIX_CHARS characters of the body. Any other field is dropped. A missing field is left out.
export function deadPayloadView(payload: unknown): Record<string, unknown> {
  const masked = maskPayload(payload);
  const view: Record<string, unknown> = { to: masked.to };
  if (typeof masked.subject === "string") view.subject = masked.subject;
  if (typeof masked.body === "string") {
    const chars = [...masked.body];
    view.body = chars.slice(0, BODY_PREFIX_CHARS).join("");
    view.bodyTruncated = chars.length > BODY_PREFIX_CHARS;
  }
  return view;
}

// Compares digests, so the length of the token does not leak and the compare takes constant time.
export function tokenMatches(given: unknown, expected: string): boolean {
  if (typeof given !== "string") return false;
  return timingSafeEqual(sha256(given), sha256(expected));
}

// CSP: the page may load only its own script, and talk only to its own origin.
const PAGE_CSP =
  "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'";

interface DeadRow {
  id: string;
  status: string;
  type: string;
  created_at: Date;
  finished_at: Date | null;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  payload: unknown;
  sent_state: string | null;
}

interface AttemptRow {
  job_id: string;
  attempt_no: number;
  worker_id: string | null;
  started_at: Date;
  finished_at: Date | null;
  error: string | null;
  backoff_bound_ms: number | null;
  delay_ms: number | null;
}

// Dead letter routes (PRD FR10, FR12). Every /api/admin route needs ADMIN_TOKEN in a header.
export function registerAdminRoutes(app: FastifyInstance, pool: Pool, config: WebConfig): void {
  // The page itself holds no data and no token, so it is served without the gate.
  app.get("/admin/dead", async (_request, reply) =>
    reply.header("content-security-policy", PAGE_CSP).type("text/html; charset=utf-8").send(ADMIN_PAGE_HTML),
  );
  app.get("/admin/dead.js", async (_request, reply) =>
    reply.header("content-security-policy", PAGE_CSP).type("text/javascript; charset=utf-8").send(ADMIN_PAGE_JS),
  );

  app.register(
    async (admin) => {
      // The admin routes read no request body, so any content type is accepted and the body ignored.
      // Without this a client that sends an empty form POST (some tools do) gets a 415.
      admin.addContentTypeParser("*", (_request, _payload, done) => done(null, undefined));

      admin.addHook("onRequest", async (request: FastifyRequest, reply) => {
        if (!tokenMatches(request.headers["x-admin-token"], config.adminToken)) {
          return reply.code(401).send({ error: "admin token required" });
        }
      });

      admin.get("/dead-jobs", async () => {
        const dead = await pool.query<DeadRow>(
          `SELECT j.id, j.status, j.type, j.created_at, j.finished_at, j.attempts, j.max_attempts, j.last_error, j.payload,
                  s.state AS sent_state
           FROM jobs j LEFT JOIN sent_emails s ON s.job_id = j.id
           WHERE j.status = 'dead'
           ORDER BY j.finished_at DESC NULLS LAST, j.created_at DESC
           LIMIT ${DEAD_JOB_LIMIT}`,
        );
        const total = await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM jobs WHERE status = 'dead'");
        const ids = dead.rows.map((r) => r.id);
        const history = ids.length
          ? await pool.query<AttemptRow>(
              `SELECT job_id, attempt_no, worker_id, started_at, finished_at, error, backoff_bound_ms, delay_ms
               FROM job_attempts WHERE job_id = ANY($1) ORDER BY job_id, attempt_no`,
              [ids],
            )
          : { rows: [] as AttemptRow[] };

        return {
          total: total.rows[0].n, // all dead jobs, not only the (at most DEAD_JOB_LIMIT) listed
          jobs: dead.rows.map((r) => ({
            id: r.id,
            status: r.status, // the page shows its action buttons only for "dead"
            type: r.type,
            createdAt: r.created_at,
            finishedAt: r.finished_at, // when it died (UTC)
            attempts: r.attempts,
            maxAttempts: r.max_attempts,
            lastError: r.last_error,
            payload: deadPayloadView(r.payload),
            sentState: r.sent_state,
            // "sending" means the outcome of the last try is unknown (FR10).
            checkProviderBeforeRetry: r.sent_state === "sending",
            // The short one-way label this job's email carries in its X-Job-Ref header and Message-ID.
            // It is all the web side knows: it never reads the sender settings or the sender's domain.
            jobRef: jobRefFor(r.id),
            attempts_history: history.rows
              .filter((a) => a.job_id === r.id)
              .map((a) => ({
                attemptNo: a.attempt_no,
                workerId: a.worker_id,
                startedAt: a.started_at,
                finishedAt: a.finished_at,
                error: a.error,
                backoffBoundMs: a.backoff_bound_ms,
                delayMs: a.delay_ms,
              })),
          })),
        };
      });

      // SKILLS: manual-retry. Attempts are NOT reset: job_attempts is UNIQUE on (job_id, attempt_no)
      // and history stays. The job gets a fresh allowance instead.
      admin.post<{ Params: { id: string } }>("/dead-jobs/:id/retry", async (request, reply) => {
        if (!UUID.test(request.params.id)) return reply.code(404).send({ error: "not found" });
        const updated = await pool.query(
          `UPDATE jobs
           SET status = 'pending', max_attempts = attempts + $1, run_at = now(),
               locked_by = NULL, locked_at = NULL
           WHERE id = $2 AND status = 'dead'
           RETURNING id`,
          [config.maxAttempts, request.params.id],
        );
        if (updated.rowCount === 0) {
          const exists = await pool.query("SELECT 1 FROM jobs WHERE id = $1", [request.params.id]);
          return reply.code(exists.rowCount === 0 ? 404 : 409).send({ error: exists.rowCount === 0 ? "not found" : "job is not dead" });
        }
        return { id: request.params.id, status: "pending" };
      });

      // For the operator who checked the provider and confirmed the last try never went out.
      // It clears the "sending" record of an UNKNOWN outcome so that a retry can send again.
      // Without it, flag_for_human would kill every retry of such a job with "uncertain send".
      // Only a dead job whose email state is exactly "sending" is touched. The job id is logged,
      // nothing else. There is no stored audit record of this action (that would need a schema change).
      admin.post<{ Params: { id: string } }>("/dead-jobs/:id/mark-not-sent", async (request, reply) => {
        const { id } = request.params;
        if (!UUID.test(id)) return reply.code(404).send({ error: "not found" });
        const cleared = await pool.query(
          `DELETE FROM sent_emails s USING jobs j
           WHERE s.job_id = $1 AND j.id = s.job_id AND j.status = 'dead' AND s.state = 'sending'
           RETURNING s.job_id`,
          [id],
        );
        if (cleared.rowCount === 0) {
          const found = await pool.query<{ status: string; state: string | null }>(
            `SELECT j.status, s.state FROM jobs j LEFT JOIN sent_emails s ON s.job_id = j.id WHERE j.id = $1`,
            [id],
          );
          const row = found.rows[0];
          if (!row) return reply.code(404).send({ error: "not found" });
          return reply
            .code(409)
            .send({ error: row.status !== "dead" ? "job is not dead" : "no unknown-outcome send to clear" });
        }
        request.log.info({ jobId: id }, "operator marked job as not sent");
        return { id, sentState: null };
      });

      // For the operator who checked the provider and found the email WAS delivered. One transaction:
      // the job goes dead -> succeeded (guarded by status = 'dead') and the email record goes
      // sending -> sent. If either update changes zero rows the transaction is rolled back and nothing
      // is changed. Only the job id is logged.
      admin.post<{ Params: { id: string } }>("/dead-jobs/:id/mark-sent", async (request, reply) => {
        const { id } = request.params;
        if (!UUID.test(id)) return reply.code(404).send({ error: "not found" });
        const result = await runInTransaction<"done" | "not_dead" | "no_sending_row">(pool, async (db) => {
          const job = await db.query(
            `UPDATE jobs
             SET status = 'succeeded', finished_at = now(), last_error = 'marked sent by operator',
                 locked_by = NULL, locked_at = NULL
             WHERE id = $1 AND status = 'dead'
             RETURNING id`,
            [id],
          );
          if (job.rowCount === 0) return { commit: false, value: "not_dead" };
          const sent = await db.query(
            `UPDATE sent_emails SET state = 'sent', updated_at = now()
             WHERE job_id = $1 AND state = 'sending'
             RETURNING job_id`,
            [id],
          );
          if (sent.rowCount === 0) return { commit: false, value: "no_sending_row" };
          return { commit: true, value: "done" };
        });
        if (result === "not_dead") {
          const exists = await pool.query("SELECT 1 FROM jobs WHERE id = $1", [id]);
          const missing = exists.rowCount === 0;
          return reply.code(missing ? 404 : 409).send({ error: missing ? "not found" : "job is not dead" });
        }
        if (result === "no_sending_row") return reply.code(409).send({ error: "no unknown-outcome send to mark as sent" });
        request.log.info({ jobId: id }, "operator marked job as sent");
        return { id, status: "succeeded", sentState: "sent" };
      });
    },
    { prefix: "/api/admin" },
  );
}
