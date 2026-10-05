import { defineConfig } from "vitest/config";

// Test files share one database and the worker claims any runnable job, so run files one at a time.
// guard.setup.ts refuses any database except jobs_test, before a connection is opened.
export default defineConfig({ test: { fileParallelism: false, setupFiles: ["./test/guard.setup.ts"] } });
