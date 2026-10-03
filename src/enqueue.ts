import { createHash } from "node:crypto";
import type { Pool } from "pg";

export interface EnqueueInput {
  ownerId: string;
  idempotencyKey: string;
  type: string;
  payload: unknown;
  maxAttempts: number;
}

export type EnqueueResult =
  | { outcome: "created"; jobId: string }
  | { outcome: "existing"; jobId: string }
  | { outcome: "conflict" };

// Stable JSON: object keys sorted, so the same payload always hashes the same.
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, canonicalize(v)]),
    );
  }
  return value;
}

export function hashPayload(type: string, payload: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize({ type, payload })))
    .digest("hex");
}

// SKILLS: enqueue-idempotent. Insert first, let the UNIQUE constraint decide. Never check first.
export async function enqueueJob(pool: Pool, input: EnqueueInput): Promise<EnqueueResult> {
  const payloadHash = hashPayload(input.type, input.payload);

  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO jobs (type, owner_id, payload, payload_hash, max_attempts, idempotency_key)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING id`,
    [input.type, input.ownerId, JSON.stringify(input.payload), payloadHash, input.maxAttempts, input.idempotencyKey],
  );
  if (inserted.rows[0]) return { outcome: "created", jobId: inserted.rows[0].id };

  const existing = await pool.query<{ id: string; owner_id: string; payload_hash: string }>(
    `SELECT id, owner_id, payload_hash FROM jobs WHERE idempotency_key = $1`,
    [input.idempotencyKey],
  );
  const row = existing.rows[0];
  if (row && row.owner_id === input.ownerId && row.payload_hash === payloadHash) {
    return { outcome: "existing", jobId: row.id };
  }
  return { outcome: "conflict" };
}
