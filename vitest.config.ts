import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Redirects DATABASE_URL to a dedicated <name>_test database and creates it
    // if missing. The integration suite truncates every table, so it must never
    // be able to reach a development database.
    setupFiles: ["tests/setup-db.ts"],
    coverage: { reporter: ["text", "lcov"], include: ["src/**/*.ts"] },
  },
});
