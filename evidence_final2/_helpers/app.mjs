// In-process build of the real web app (same routes as src/main.ts) pointed at jobs_evidence.
// Uses Fastify's inject() so no port or long-lived server process is needed. Requires the tsx loader:
//   node --env-file=.env --import tsx <script>
import pg from "pg";
import { loadWebConfig } from "../../src/config.ts";
import { buildServer } from "../../src/server.ts";
import { evidenceUrl } from "./lib.mjs";

export function makePool() {
  return new pg.Pool({ connectionString: evidenceUrl() });
}

export function makeApp(pool) {
  return buildServer(pool, loadWebConfig(), false);
}

export async function enqueue(app, { payload, idempotencyKey, type = "send_email", userId = "evidence2" }) {
  const res = await app.inject({
    method: "POST",
    url: "/api/jobs",
    headers: { "content-type": "application/json", "x-user-id": userId },
    payload: { type, payload, idempotencyKey },
  });
  let body = null;
  try {
    body = res.json();
  } catch {}
  return { status: res.statusCode, body };
}

export async function getDeadJobs(app, adminToken) {
  const res = await app.inject({
    method: "GET",
    url: "/api/admin/dead-jobs",
    headers: { "x-admin-token": adminToken },
  });
  let body = null;
  try {
    body = res.json();
  } catch {}
  return { status: res.statusCode, body };
}
