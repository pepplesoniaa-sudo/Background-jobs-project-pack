export interface Config {
  databaseUrl: string;
  maxAttempts: number;
  port: number;
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

// Validated at startup (PRD FR14). Only the keys S2 needs; the rest arrive with their steps.
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    databaseUrl: requireString(env, "DATABASE_URL"),
    maxAttempts: requireInt(env, "MAX_ATTEMPTS", 1),
    port: requireInt(env, "PORT", 0),
  };
}
