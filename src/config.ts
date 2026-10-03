export interface Config {
  databaseUrl: string;
  maxAttempts: number;
  port: number;
}

export type UncertainSendPolicy = "resend" | "flag_for_human";

export interface WorkerConfig extends Config {
  pollIntervalMs: number;
  sendTimeoutMs: number;
  fakeSendDelayMs: number;
  uncertainSendPolicy: UncertainSendPolicy;
}

function requireString(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

function requireInt(env: NodeJS.ProcessEnv, name: string, min: number): number {
  const raw = requireString(env, name);
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) {
    throw new Error(`${name} must be an integer >= ${min}`);
  }
  return value;
}

// Validated at startup (PRD FR14). The web app needs only these keys.
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    databaseUrl: requireString(env, "DATABASE_URL"),
    maxAttempts: requireInt(env, "MAX_ATTEMPTS", 1),
    port: requireInt(env, "PORT", 0),
  };
}

// The worker needs the web keys plus its own. Keys for later steps arrive with their steps.
export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const policy = requireString(env, "UNCERTAIN_SEND_POLICY");
  if (policy !== "resend" && policy !== "flag_for_human") {
    throw new Error("UNCERTAIN_SEND_POLICY must be resend or flag_for_human");
  }
  const config: WorkerConfig = {
    ...loadConfig(env),
    pollIntervalMs: requireInt(env, "POLL_INTERVAL_MS", 1),
    sendTimeoutMs: requireInt(env, "SEND_TIMEOUT_MS", 1),
    fakeSendDelayMs: requireInt(env, "FAKE_SEND_DELAY_MS", 0),
    uncertainSendPolicy: policy,
  };
  // Otherwise the fake send would time out instead of hang (PRD FR14).
  if (config.fakeSendDelayMs >= config.sendTimeoutMs) {
    throw new Error("FAKE_SEND_DELAY_MS must be below SEND_TIMEOUT_MS");
  }
  return config;
}
