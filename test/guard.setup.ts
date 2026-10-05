import pg from "pg";

// TEST DATABASE GUARD. Registered in vitest.config.ts as a setup file, so it runs before every test
// file. It refuses to let any test talk to a database other than jobs_test.
//
// It decides from the database NAME in the connection settings, BEFORE any connection is opened, so
// nothing is ever sent to the wrong database. It only acts when a test actually uses a pg Pool or
// Client, so database-free tests (which never connect) are not affected. The password is masked.
const ALLOWED = "jobs_test";

const mask = (url: string) => url.replace(/(:\/\/[^:/@]+:)[^@]*@/, "$1****@");

function nameOf(url: string): string | null {
  try {
    return decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
  } catch {
    return null;
  }
}

function guard(settings: { connectionString?: string; database?: string }): void {
  const url = settings.connectionString;
  const seen = url ? nameOf(url) : (settings.database ?? process.env.PGDATABASE ?? null);
  if (seen !== ALLOWED) {
    throw new Error(
      `Refusing to run: this test would connect to database "${seen ?? "(unreadable)"}" at ` +
        `${url ? mask(url) : "(no connection string given)"}, but tests may only use "${ALLOWED}". Nothing was sent.`,
    );
  }
}

type Fn = (...args: unknown[]) => unknown;
const wrap = (proto: object, method: string, settingsOf: (self: any) => Parameters<typeof guard>[0]) => {
  const original = (proto as Record<string, Fn>)[method];
  (proto as Record<string, Fn>)[method] = function (this: unknown, ...args: unknown[]) {
    guard(settingsOf(this));
    return original.apply(this, args);
  };
};

wrap(pg.Pool.prototype, "query", (pool) => pool.options ?? {});
wrap(pg.Pool.prototype, "connect", (pool) => pool.options ?? {});
wrap(pg.Client.prototype, "connect", (client) => ({ database: client.connectionParameters?.database }));
