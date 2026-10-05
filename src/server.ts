import Fastify, { type FastifyInstance } from "fastify";
import type { Pool } from "pg";
import type { WebConfig } from "./config.js";
import { registerAdminRoutes } from "./adminRoutes.js";
import { enqueueJob } from "./enqueue.js";
import { registerHomePage } from "./homePage.js";
import { validateRecipient } from "./recipient.js";

const ALLOWED_TYPES = ["send_email"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const createJobSchema = {
  body: {
    type: "object",
    required: ["type", "payload", "idempotencyKey"],
    properties: {
      type: { type: "string", enum: ALLOWED_TYPES },
      payload: { type: "object" },
      idempotencyKey: { type: "string", minLength: 1, maxLength: 200 },
    },
  },
} as const;

interface LogStream {
  write(message: string): void;
}

// Request logs keep the method and the path only. The query string is dropped because a caller
// could put a secret in it (FR12 forbids that, but a log must not turn the mistake into a leak),
// and headers and bodies are never logged (FR13).
const logSerializers = {
  req: (request: { method?: string; url?: string }) => ({
    method: request.method,
    path: (request.url ?? "").split("?")[0],
  }),
};

export function buildServer(pool: Pool, config: WebConfig, logger: boolean | LogStream = false): FastifyInstance {
  const app = Fastify({
    logger: logger === false ? false : { serializers: logSerializers, ...(logger === true ? {} : { stream: logger }) },
  });

  // Demo-level identification only (PRD FR1): the caller is whoever the header says.
  app.post<{ Body: { type: string; payload: object; idempotencyKey: string } }>(
    "/api/jobs",
    { schema: createJobSchema },
    async (request, reply) => {
      const ownerId = request.headers["x-user-id"];
      if (typeof ownerId !== "string" || ownerId.length === 0) {
        return reply.code(401).send({ error: "x-user-id header required" });
      }

      const { type, payload, idempotencyKey } = request.body;

      // S4: a badly formed recipient is refused with 400 BEFORE anything is written, so it leaves no row.
      // This checks the shape only: a well-formed address with a nonexistent mailbox still passes.
      // The reply never repeats the address.
      if (type === "send_email") {
        const check = validateRecipient((payload as { to?: unknown }).to);
        if (!check.ok) return reply.code(400).send({ error: `invalid recipient: payload.to ${check.message}` });
      }

      const result = await enqueueJob(pool, {
        ownerId,
        idempotencyKey,
        type,
        payload,
        maxAttempts: config.maxAttempts,
      });

      if (result.outcome === "created") return reply.code(202).send({ id: result.jobId });
      if (result.outcome === "existing") return reply.code(200).send({ id: result.jobId });
      return reply.code(409).send({ error: "idempotency key already used with a different payload or owner" });
    },
  );

  // FR11: status for the owner only. Anyone else, and any id that does not exist, gets the same 404.
  // The response never carries the payload or the recipient (FR13). last_error is short and address-free.
  app.get<{ Params: { id: string } }>("/api/jobs/:id", async (request, reply) => {
    const ownerId = request.headers["x-user-id"];
    if (typeof ownerId !== "string" || ownerId.length === 0) {
      return reply.code(401).send({ error: "x-user-id header required" });
    }
    if (!UUID.test(request.params.id)) return reply.code(404).send({ error: "not found" });

    const found = await pool.query<{
      id: string;
      status: string;
      attempts: number;
      max_attempts: number;
      run_at: Date;
      finished_at: Date | null;
      last_error: string | null;
    }>(
      `SELECT id, status, attempts, max_attempts, run_at, finished_at, last_error
       FROM jobs WHERE id = $1 AND owner_id = $2`,
      [request.params.id, ownerId],
    );
    const job = found.rows[0];
    if (!job) return reply.code(404).send({ error: "not found" });
    return {
      id: job.id,
      status: job.status,
      attempts: job.attempts,
      maxAttempts: job.max_attempts,
      runAt: job.run_at,
      finishedAt: job.finished_at,
      error: job.last_error,
    };
  });

  registerHomePage(app);
  registerAdminRoutes(app, pool, config);

  return app;
}
