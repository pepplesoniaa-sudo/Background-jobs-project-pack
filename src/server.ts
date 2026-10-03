import Fastify, { type FastifyInstance } from "fastify";
import type { Pool } from "pg";
import type { Config } from "./config.js";
import { enqueueJob } from "./enqueue.js";

const ALLOWED_TYPES = ["send_email"];

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

export function buildServer(pool: Pool, config: Config, logger = false): FastifyInstance {
  const app = Fastify({ logger });

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

  return app;
}
