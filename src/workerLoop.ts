import { stopAllHeartbeats } from "./ownership.js";
import { claimJob, processJob, type WorkerDeps } from "./worker.js";

export interface LoopOptions {
  concurrency: number; // WORKER_CONCURRENCY, per worker process
  pollIntervalMs: number;
}

export interface StopResult {
  timedOut: boolean; // true: the wait ran out, and `remaining` jobs were still running
  remaining: number;
}

export interface LoopHandle {
  stats(): { running: number; maxSeen: number };
  // Stop claiming, wait for the jobs already running, then log the final max_concurrent line. With
  // timeoutMs it gives up waiting after that long (counted from the call) and says how many jobs were
  // left running; without it, it waits for as long as the jobs take.
  stop(timeoutMs?: number): Promise<StopResult>;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// An error's name and code only. Its message can carry hosts or connection details.
const describe = (err: unknown) => `${(err as Error)?.name ?? "Error"}${(err as { code?: string })?.code ? ` code=${(err as { code?: string }).code}` : ""}`;

// SKILLS: concurrency-cap. N is per worker process, so two workers can run 2N jobs.
export function startWorkerLoop(
  deps: WorkerDeps,
  workerId: string,
  options: LoopOptions,
  log: (line: string) => void,
): LoopHandle {
  let running = 0;
  let maxSeen = 0;
  let stopping = false;
  const inFlight = new Set<Promise<void>>();
  const report = () => log(`worker=${workerId} concurrent=${running} max_seen=${maxSeen}`);

  const loop = (async () => {
    while (!stopping) {
      // Claim only while a slot is free. Otherwise, or when nothing is ready, wait and look again.
      if (running < options.concurrency) {
        let job = null;
        try {
          job = await claimJob(deps.pool, workerId);
        } catch (err) {
          log(`WARN worker=${workerId} claim failed (${describe(err)})`);
        }
        if (job) {
          running += 1;
          maxSeen = Math.max(maxSeen, running);
          report();
          const task: Promise<void> = processJob(deps, job, workerId, log)
            .catch((err) => {
              // Left in processing on purpose: the sweep recovers it once its lock is old enough.
              log(`WARN worker=${workerId} job=${job.id} processing failed (${describe(err)})`);
            })
            .finally(() => {
              running -= 1;
              inFlight.delete(task);
              report();
            });
          inFlight.add(task);
          continue;
        }
      }
      await sleep(options.pollIntervalMs);
    }
  })();

  return {
    stats: () => ({ running, maxSeen }),
    stop: async (timeoutMs?: number) => {
      stopping = true; // no new claim starts from here on
      let timer: NodeJS.Timeout | undefined;
      const gaveUp = new Promise<"timeout">((resolve) => {
        if (timeoutMs !== undefined) timer = setTimeout(() => resolve("timeout"), timeoutMs);
      });
      const finished = (async () => {
        await loop; // a claim that was already running may still hand this worker one last job
        log(`worker=${workerId} stopping, waiting for ${running} jobs`);
        await Promise.allSettled([...inFlight]);
        return "done" as const;
      })();
      const outcome = await Promise.race([finished, gaveUp]);
      if (timer) clearTimeout(timer);
      const remaining = running;
      if (outcome === "timeout") {
        // Never mark the running jobs finished. Stop refreshing their locks instead, so the sweep
        // recovers them once the locks are old enough (the same path as a hard kill).
        stopAllHeartbeats();
        log(`worker=${workerId} gave up waiting after ${timeoutMs} ms, leaving ${remaining} jobs for the sweep`);
      }
      log(`worker=${workerId} max_concurrent=${maxSeen}`);
      return { timedOut: outcome === "timeout", remaining };
    },
  };
}
