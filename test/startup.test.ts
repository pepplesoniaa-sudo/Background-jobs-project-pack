import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadWorkerConfig } from "../src/config.js";
import { OWNERSHIP_SQL } from "../src/ownership.js";
import { POOL_FLOOR, workerPoolOptions } from "../src/workerPool.js";

// DATABASE-FREE AND MAIL-FREE. Pure functions and a read of two source files. Nothing here opens a
// connection, so it may run at any time, with or without a worker running.

const base = {
  DATABASE_URL: "x",
  MAX_ATTEMPTS: "5",
  PORT: "3000",
  POLL_INTERVAL_MS: "1000",
  SEND_TIMEOUT_MS: "30000",
  FAKE_SEND_DELAY_MS: "0",
  UNCERTAIN_SEND_POLICY: "flag_for_human",
  BACKOFF_BASE_MS: "2000",
  BACKOFF_CAP_MS: "300000",
  STUCK_TIMEOUT_MS: "120000",
  SWEEP_INTERVAL_MS: "15000",
  WORKER_CONCURRENCY: "5",
  HEARTBEAT_INTERVAL_MS: "10000",
};

const refusal = (env: Record<string, string>): string | null => {
  try {
    loadWorkerConfig(env);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
};

describe("S7 startup checks: STUCK_TIMEOUT_MS against SEND_TIMEOUT_MS and HEARTBEAT_INTERVAL_MS", () => {
  it("accepts the real settings (stuck 120000, send 30000, heartbeat 10000) and reads the heartbeat interval", () => {
    expect(refusal(base)).toBeNull();
    expect(loadWorkerConfig(base).heartbeatIntervalMs).toBe(10000);
  });

  it("accepts a stuck timeout of exactly 3 times the heartbeat interval", () => {
    expect(refusal({ ...base, HEARTBEAT_INTERVAL_MS: "40000" })).toBeNull(); // 3 * 40000 = 120000
  });

  it("REFUSES a stuck timeout below 3 times the heartbeat interval, with this exact text", () => {
    expect(refusal({ ...base, HEARTBEAT_INTERVAL_MS: "40001" })).toBe("STUCK_TIMEOUT_MS must be at least 3 * HEARTBEAT_INTERVAL_MS");
  });

  it("still REFUSES a stuck timeout below 3 times the send timeout, with this exact text", () => {
    expect(refusal({ ...base, STUCK_TIMEOUT_MS: "89999" })).toBe("STUCK_TIMEOUT_MS must be at least 3 * SEND_TIMEOUT_MS");
  });

  it("when both rules are broken the send-timeout rule is reported first", () => {
    expect(refusal({ ...base, STUCK_TIMEOUT_MS: "89999", HEARTBEAT_INTERVAL_MS: "40000" })).toBe(
      "STUCK_TIMEOUT_MS must be at least 3 * SEND_TIMEOUT_MS",
    );
  });

  it("REFUSES to start when HEARTBEAT_INTERVAL_MS is missing, empty, zero or not a whole number", () => {
    const { HEARTBEAT_INTERVAL_MS: _omit, ...without } = base;
    expect(refusal(without)).toBe("Missing required environment variable HEARTBEAT_INTERVAL_MS");
    expect(refusal({ ...base, HEARTBEAT_INTERVAL_MS: "" })).toBe("Missing required environment variable HEARTBEAT_INTERVAL_MS");
    for (const bad of ["0", "-5", "2.5", "ten"]) {
      expect(refusal({ ...base, HEARTBEAT_INTERVAL_MS: bad })).toBe("HEARTBEAT_INTERVAL_MS must be an integer >= 1");
    }
  });
});

describe("S7 worker pool sizing", () => {
  it("max is at least 2 * WORKER_CONCURRENCY + 4, with a floor of 10", () => {
    expect(POOL_FLOOR).toBe(10);
    const cases: Array<[number, number]> = [[1, 10], [2, 10], [3, 10], [5, 14], [6, 16], [8, 20], [20, 44]];
    for (const [n, expectedMax] of cases) {
      const { max } = workerPoolOptions(n, 30000);
      expect(max, `N=${n}`).toBe(expectedMax);
      expect(max).toBeGreaterThanOrEqual(2 * n + 4);
      expect(max).toBeGreaterThanOrEqual(10);
    }
  });

  it("the connection timeout is 2 * SEND_TIMEOUT_MS: above the send timeout, below the stuck timeout", () => {
    const { connectionTimeoutMillis } = workerPoolOptions(5, 30000);
    expect(connectionTimeoutMillis).toBe(60000);
    expect(connectionTimeoutMillis).toBeGreaterThan(30000); // comfortably above SEND_TIMEOUT_MS
    for (const send of [1000, 30000, 45000]) {
      const timeout = workerPoolOptions(5, send).connectionTimeoutMillis;
      expect(timeout).toBeGreaterThan(send);
      expect(timeout).toBeLessThan(3 * send); // the startup check forces STUCK_TIMEOUT_MS >= 3 * send, so it is always below that
    }
  });
});

describe("S7 wiring and the pinned statement", () => {
  it("workerMain.ts sizes the pool with workerPoolOptions and gives the worker its heartbeat interval", () => {
    const text = readFileSync("src/workerMain.ts", "utf8");
    expect(text).toContain("workerPoolOptions(config.workerConcurrency, config.sendTimeoutMs)");
    expect(text).toContain("heartbeatIntervalMs: config.heartbeatIntervalMs");
    expect(text).not.toContain("Math.max(10, config.workerConcurrency + 2)"); // the old, too small sizing
  });

  it("the ownership statement is exactly the pinned text (the S6 re-check and the S7 heartbeat share it)", () => {
    expect(OWNERSHIP_SQL.replace(/\s+/g, " ").trim()).toBe(
      "UPDATE jobs SET locked_at = now() WHERE id = $1 AND locked_by = $2 AND status = 'processing' RETURNING id",
    );
  });

  it("worker.ts and the heartbeat use that one statement: neither repeats it as text", () => {
    for (const file of ["src/worker.ts", "src/ownership.ts"]) {
      const text = readFileSync(file, "utf8");
      const copies = text.split("SET locked_at = now()").length - 1;
      expect(copies, file).toBe(file === "src/ownership.ts" ? 1 : 0);
    }
  });
});

describe("S8 ruling 1b: the real entry point wires the heartbeat from config into the worker", () => {
  it("the deps object in workerMain.ts carries heartbeatIntervalMs from config.heartbeatIntervalMs, and that same object runs the loop", () => {
    const text = readFileSync("src/workerMain.ts", "utf8");
    const deps = /const deps = \{([\s\S]*?)\};/.exec(text);
    expect(deps, "workerMain.ts must build one `deps` object").not.toBeNull();
    expect(deps![1]).toMatch(/\bheartbeatIntervalMs:\s*config\.heartbeatIntervalMs\b/);
    expect(text).toMatch(/startWorkerLoop\(\s*deps,/); // the loop gets exactly that object
    expect(text).toContain("loadWorkerConfig()"); // and config comes from the real loader
  });

  it("the worker only runs a heartbeat when heartbeatIntervalMs is given, so a missing wire would turn it off: the worker source starts it from deps", () => {
    const text = readFileSync("src/worker.ts", "utf8");
    expect(text).toMatch(/deps\.heartbeatIntervalMs !== undefined/);
    expect(text).toMatch(/startHeartbeat\(\s*deps\.pool,\s*job\.id,\s*workerId,\s*deps\.heartbeatIntervalMs/);
  });
});
