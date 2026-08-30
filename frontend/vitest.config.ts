import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./src/lib/test-setup.ts"],
  },
  resolve: {
    alias: [
      // Order matters: match the @dshield/core subpaths before the bare "@"
      // src alias, and the bare specifier before the subpath rule.
      {
        find: /^@dshield\/core$/,
        replacement: path.resolve(__dirname, "../packages/core/src/index.ts"),
      },
      {
        find: /^@dshield\/core\/(.*)$/,
        replacement: path.resolve(__dirname, "../packages/core/src/$1.ts"),
      },
      { find: /^@\/(.*)$/, replacement: path.resolve(__dirname, "./src/$1") },
    ],
  },
});
