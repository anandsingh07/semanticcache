import { defineConfig } from "vitest/config";

// Unit tests: fast, no external services. Integration tests (Testcontainers) use
// vitest.integration.config.ts.
export default defineConfig({
  test: {
    include: ["test/unit/**/*.test.ts"],
    environment: "node",
    globals: true,
    setupFiles: ["test/setup.ts"],
  },
});
