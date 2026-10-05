import type { Pool } from "pg";

type Db = Pick<Pool, "query">;

// The ONE ownership statement. It is used twice, with exactly this text: as the re-check made right
// before anything is sent (S6) and as the heartbeat repeated while a job runs (S7). It refreshes
// locked_at, so the sweep sees a live lock, and it changes a row only if this worker still owns a job
// that is still processing. Zero rows means the job was reclaimed or finished by someone else.
export const OWNERSHIP_SQL = `UPDATE jobs SET locked_at = now()
     WHERE id = $1 AND locked_by = $2 AND status = 'processing'
     RETURNING id`;

export async function stillOwned(db: Db, jobId: string, workerId: string): Promise<boolean> {
  const refreshed = await db.query(OWNERSHIP_SQL, [jobId, workerId]);
  return (refreshed.rowCount ?? 0) > 0;
}

// A short, safe label for a thrown error: the database error code if there is one (e.g. 57P01),
// else the error's name (e.g. Error). Never the message, which could hold an address or a payload.
export function errorClassOf(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  const name = (err as { name?: unknown } | null)?.name;
  const raw = typeof code === "string" && code ? code : typeof name === "string" && name ? name : "unknown";
  return /^[A-Za-z0-9_.-]{1,40}$/.test(raw) ? raw : "unknown";
}

export interface Heartbeat {
  // Stops the timer for good and waits for a beat that is already in flight, so no beat can run
  // after this returns. Safe to call more than once.
  stop(): Promise<void>;
}

let running = 0;
// How many heartbeat timers are alive right now. A test reads it to prove no timer outlives its job.
export const activeHeartbeats = (): number => running;

// The way to end every live heartbeat at once, for shutdown. A job whose heartbeat was ended this way
// is never marked finished by it: its lock simply stops being refreshed, so the sweep can recover it.
const live = new Set<() => void>();
export function stopAllHeartbeats(): number {
  const ends = [...live];
  for (const end of ends) end();
  return ends.length;
}

// Repeats the ownership statement every intervalMs while a job runs. If a beat changes zero rows the
// job was lost: the timer stops itself and onLost() is called once. A beat that FAILS (a database
// hiccup) proves nothing, so it is ignored and the next beat tries again.
export function startHeartbeat(
  db: Db,
  jobId: string,
  workerId: string,
  intervalMs: number,
  onLost: () => void,
  onError: (errorClass: string) => void = () => undefined,
  onRecovered: (failedBeats: number) => void = () => undefined,
): Heartbeat {
  running += 1;
  let ended = false;
  let failedBeats = 0; // beats that threw since the last good one
  let inFlight: Promise<void> | null = null;

  const end = () => {
    if (ended) return;
    ended = true;
    clearInterval(timer);
    live.delete(end);
    running -= 1;
  };
  live.add(end);

  const beat = async () => {
    try {
      const owned = await stillOwned(db, jobId, workerId);
      reportRecovery(); // a beat got through, so an earlier run of failed beats is over
      if (!owned && !ended) {
        end();
        onLost();
      }
    } catch (err) {
      // not a loss: report the failure's class (never its message, which could carry data) and try again
      failedBeats += 1;
      if (!ended) onError(errorClassOf(err));
    }
  };

  // Says once how many beats failed in a row, when beating resumes or when the job ends.
  const reportRecovery = () => {
    if (failedBeats === 0) return;
    const n = failedBeats;
    failedBeats = 0;
    onRecovered(n);
  };

  const timer = setInterval(() => {
    if (ended || inFlight) return;
    inFlight = beat().finally(() => {
      inFlight = null;
    });
  }, intervalMs);
  timer.unref(); // a forgotten timer must never keep the process alive

  return {
    stop: async () => {
      end();
      if (inFlight) await inFlight;
      reportRecovery(); // the job ended while beats were still failing
    },
  };
}
