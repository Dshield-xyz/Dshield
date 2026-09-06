import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Only run the TypeScript sources. dist/ holds build output, and running a
    // compiled copy of a test alongside its source means a stale build fails
    // the suite for changes that are actually fine.
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    exclude: ["dist/**", "node_modules/**"],
  },
});
