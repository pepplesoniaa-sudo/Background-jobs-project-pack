import { stopAllHeartbeats } from "./ownership.js";
import type { StopResult } from "./workerLoop.js";

export interface ShutdownDeps {
  workerId: string;
  loop: { stop(timeoutMs?: number): Promise<StopResult> };
  timeoutMs: number; // SEND_TIMEOUT_MS: how long running jobs get to finish
  stopTimers: () => void; // the sweep timer
  closePool: () => Promise<void>;
  exit: (code: number) => void;
  log: (line: string) => void;
}

// Signals the worker listens for. SIGINT is Ctrl+C. SIGTERM is what a service manager or `kill` sends
// (Windows never delivers it). SIGBREAK is Ctrl+Break and SIGHUP is the console window closing, both on
// Windows. See docs/PRD-CHANGES.md.
export const SHUTDOWN_SIGNALS = ["SIGINT", "SIGTERM", "SIGBREAK", "SIGHUP"] as const;

// The first signal: stop claiming, give running jobs up to SEND_TIMEOUT_MS to finish, stop every timer,
// then exit. Jobs still running after the wait are NOT marked finished: their locks go stale and the
// sweep recovers them, exactly as after a hard kill. A second signal exits at once.
export function createShutdownHandler(deps: ShutdownDeps): (signal: string) => Promise<void> {
  let started = false;
  return async (signal: string) => {
    if (started) {
      deps.log(`worker=${deps.workerId} received ${signal} again, exiting at once`);
      deps.exit(1);
      return;
    }
    started = true;
    deps.log(`worker=${deps.workerId} received ${signal}, shutting down`);
    deps.stopTimers();
    let result: StopResult = { timedOut: true, remaining: 0 };
    try {
      result = await deps.loop.stop(deps.timeoutMs);
    } catch {
      deps.log(`WARN worker=${deps.workerId} stopping the loop failed, exiting anyway`);
    } finally {
      stopAllHeartbeats(); // belt and braces: no heartbeat timer may be left at exit
    }
    // After a give-up, jobs are still running and may hold connections, so closing the pool could wait
    // on them. The process is about to end, which drops the connections.
    if (!result.timedOut) await deps.closePool().catch(() => undefined);
    deps.exit(0);
  };
}
