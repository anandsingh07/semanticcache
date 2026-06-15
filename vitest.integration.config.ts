import { defineConfig } from "vitest/config";

// Integration tests spin up real Postgres (pgvector) + Redis via Testcontainers, so they
// need a generous timeout and must run serially (shared containers, no test parallelism).
export default defineConfig({
  test: {
    include: ["test/integration/**/*.test.ts"],
    environment: "node",
    globals: true,
    testTimeout: 120_000,
    hookTimeout: 180_000,
    fileParallelism: false,
  },
});
