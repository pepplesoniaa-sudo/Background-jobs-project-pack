// Shared helper for the evidence run. Loaded with `node --env-file=.env evidence_final/_helpers/lib.mjs`.
// It never prints or writes the DATABASE_URL. It rewrites the database name to jobs_evidence.
import pg from "pg";
import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(here, "..", "..");
export const OUT = join(ROOT, "evidence_final2");

export function evidenceUrl() {
  const u = new URL(process.env.DATABASE_URL);
  u.pathname = "/jobs_evidence"; // rule 2: evidence DB only
  return u.toString();
}

export const dbName = () => new URL(evidenceUrl()).pathname.replace(/^\//, "");

export function newPool() {
  return new pg.Pool({ connectionString: evidenceUrl() });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Spawns a real worker process. stdout+stderr go to the given log file so the child survives without us.
export function startWorker(overrides = {}, logFile = "worker.log") {
  const env = {
    ...process.env,
    DATABASE_URL: evidenceUrl(),
    MAIL_TRANSPORT: "fake", // rule 3: never a real send
    EMAIL_HOST: "",
    EMAIL_USER: "",
    EMAIL_PASSWORD: "",
    EMAIL_FROM: "",
    ...overrides,
  };
  const fd = openSync(join(OUT, logFile), "a");
  const child = spawn(
    process.execPath,
    ["--env-file=.env", "--import", "tsx", "src/workerMain.ts"],
    { cwd: ROOT, env, stdio: ["ignore", fd, fd] },
  );
  return child;
}

// Hard kill (rule 8: on Windows this is a hard kill; signal handlers do not run).
export function hardKill(child) {
  try {
    child.kill("SIGKILL");
  } catch {
    /* ignore */
  }
}

export async function waitFor(predicate, { timeoutMs = 60000, intervalMs = 250, label = "condition" } = {}) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() > end) throw new Error(`timeout waiting for ${label}`);
    await sleep(intervalMs);
  }
}

export async function counts(pool) {
  const r = await pool.query("SELECT status, count(*)::int AS n FROM jobs GROUP BY status ORDER BY status");
  const out = {};
  for (const row of r.rows) out[row.status] = row.n;
  return out;
}

export const nowIso = () => new Date().toISOString();
