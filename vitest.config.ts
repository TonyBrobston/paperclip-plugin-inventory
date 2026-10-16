import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.spec.ts"],
    environment: "node",
    // The integration suite waits on a real PostgreSQL connection, which is
    // slower than the default per-test budget allows for on a cold container.
    testTimeout: 30_000,
  },
});
