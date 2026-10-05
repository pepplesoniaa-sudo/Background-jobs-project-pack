import type { Pool } from "pg";

type Db = Pick<Pool, "query">;

// Runs `work` inside ONE BEGIN ... COMMIT, on its own connection. `work` says whether to keep what it
// wrote: with commit: false the transaction is ROLLED BACK, so nothing it wrote survives. If `work`
// throws, the transaction is rolled back and the error goes on to the caller. The connection always
// goes back to the pool.
export async function runInTransaction<T>(
  pool: Pool,
  work: (db: Db) => Promise<{ commit: boolean; value: T }>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let outcome: { commit: boolean; value: T };
    try {
      outcome = await work(client);
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    }
    await client.query(outcome.commit ? "COMMIT" : "ROLLBACK");
    return outcome.value;
  } finally {
    client.release();
  }
}
