export interface Config {
  databaseUrl: string;
  maxAttempts: number;
  port: number;
}

export interface WebConfig extends Config {
  adminToken: string;
}

export type UncertainSendPolicy = "resend" | "flag_for_human";
export type MailTransportKind = "fake" | "real";

// The real transport is Gmail SMTP (D3). The password is a secret: environment only, never logged.
export interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  from: string;
}

export interface WorkerConfig extends Config {
  pollIntervalMs: number;
  sendTimeoutMs: number;
  fakeSendDelayMs: number;
  uncertainSendPolicy: UncertainSendPolicy;
  backoffBaseMs: number;
  backoffCapMs: number;
  forceFail: boolean;
  stuckTimeoutMs: number;
  sweepIntervalMs: number;
  workerConcurrency: number;
  heartbeatIntervalMs: number;
  mailTransport: MailTransportKind;
  smtp: SmtpConfig | null; // set only when mailTransport is "real"
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

const MIN_ADMIN_TOKEN_LENGTH = 16;

// The web app also needs the admin token, which guards the dead letter routes (PRD FR12).
export function loadWebConfig(env: NodeJS.ProcessEnv = process.env): WebConfig {
  const adminToken = requireString(env, "ADMIN_TOKEN");
  if (adminToken.length < MIN_ADMIN_TOKEN_LENGTH) {
    throw new Error(`ADMIN_TOKEN must be at least ${MIN_ADMIN_TOKEN_LENGTH} characters`);
  }
  return { ...loadConfig(env), adminToken };
}

// The worker needs the web keys plus its own. Keys for later steps arrive with their steps.
export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const policy = requireString(env, "UNCERTAIN_SEND_POLICY");
  if (policy !== "resend" && policy !== "flag_for_human") {
    throw new Error("UNCERTAIN_SEND_POLICY must be resend or flag_for_human");
  }
  // PRD section 8: MAIL_TRANSPORT defaults to fake. Anything else must be spelled out.
  const mailTransport = env.MAIL_TRANSPORT ?? "fake";
  if (mailTransport !== "fake" && mailTransport !== "real") {
    throw new Error("MAIL_TRANSPORT must be fake or real");
  }
  const config: WorkerConfig = {
    ...loadConfig(env),
    pollIntervalMs: requireInt(env, "POLL_INTERVAL_MS", 1),
    sendTimeoutMs: requireInt(env, "SEND_TIMEOUT_MS", 1),
    fakeSendDelayMs: requireInt(env, "FAKE_SEND_DELAY_MS", 0),
    uncertainSendPolicy: policy,
    backoffBaseMs: requireInt(env, "BACKOFF_BASE_MS", 1),
    backoffCapMs: requireInt(env, "BACKOFF_CAP_MS", 1),
    forceFail: env.FORCE_FAIL === "true", // optional, default false (PRD section 8)
    stuckTimeoutMs: requireInt(env, "STUCK_TIMEOUT_MS", 1),
    sweepIntervalMs: requireInt(env, "SWEEP_INTERVAL_MS", 1),
    workerConcurrency: requireInt(env, "WORKER_CONCURRENCY", 1),
    heartbeatIntervalMs: requireInt(env, "HEARTBEAT_INTERVAL_MS", 1),
    mailTransport,
    smtp:
      mailTransport === "real"
        ? {
            host: requireString(env, "EMAIL_HOST"),
            port: requireInt(env, "EMAIL_PORT", 1),
            user: requireString(env, "EMAIL_USER"),
            password: requireString(env, "EMAIL_PASSWORD"),
            from: requireString(env, "EMAIL_FROM"),
          }
        : null,
  };
  // FORCE_FAIL belongs to the fake. With the real transport it would silently do nothing.
  if (config.mailTransport === "real" && config.forceFail) {
    throw new Error("FORCE_FAIL only works with MAIL_TRANSPORT=fake");
  }
  // A slow but alive send must never look stuck (PRD FR9, FR14).
  if (config.stuckTimeoutMs < 3 * config.sendTimeoutMs) {
    throw new Error("STUCK_TIMEOUT_MS must be at least 3 * SEND_TIMEOUT_MS");
  }
  // A live worker refreshes its lock every HEARTBEAT_INTERVAL_MS. Two missed beats must still leave the
  // job well inside the time after which the sweep reclaims it.
  if (config.stuckTimeoutMs < 3 * config.heartbeatIntervalMs) {
    throw new Error("STUCK_TIMEOUT_MS must be at least 3 * HEARTBEAT_INTERVAL_MS");
  }
  if (config.backoffCapMs < config.backoffBaseMs) {
    throw new Error("BACKOFF_CAP_MS must be at least BACKOFF_BASE_MS");
  }
  // Otherwise the fake send would time out instead of hang (PRD FR14).
  if (config.fakeSendDelayMs >= config.sendTimeoutMs) {
    throw new Error("FAKE_SEND_DELAY_MS must be below SEND_TIMEOUT_MS");
  }
  return config;
}
