import { defineConfig } from "vitest/config";

// Test files share one dev database and the worker claims any runnable job, so run files one at a time.
export default defineConfig({ test: { fileParallelism: false } });
