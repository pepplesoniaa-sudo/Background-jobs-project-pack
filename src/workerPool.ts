// Sizing of the worker's database pool (S7). One place, so the worker and its test use the same rule.
//
// max: at least 2 * WORKER_CONCURRENCY + 4, never below 10. A running job can use one connection for
//   its own statements AND one for its heartbeat at the same moment (2 per job), plus one for the
//   claim loop and one for the sweep (2), plus 2 spare for the lost-job read and the like.
//
// connectionTimeoutMillis: 2 * SEND_TIMEOUT_MS. It is comfortably ABOVE SEND_TIMEOUT_MS, because a
//   connection is held only for single statements or one short transaction and never during an SMTP
//   send, so a wait that long means a broken pool or database, not a busy one. It is always BELOW
//   STUCK_TIMEOUT_MS (the startup check forces that to be at least 3 * SEND_TIMEOUT_MS), so a job
//   blocked waiting for a connection errors out before the sweep could mistake it for stuck. With it,
//   exhaustion becomes an error instead of an endless wait. No new setting is needed.
export const POOL_FLOOR = 10;

export function workerPoolOptions(
  workerConcurrency: number,
  sendTimeoutMs: number,
): { max: number; connectionTimeoutMillis: number } {
  return {
    max: Math.max(POOL_FLOOR, 2 * workerConcurrency + 4),
    connectionTimeoutMillis: 2 * sendTimeoutMs,
  };
}
