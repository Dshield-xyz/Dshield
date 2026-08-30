import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import path from "node:path";

const dir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    environment: "node",
  },
  resolve: {
    // Resolve @dshield/core to its TypeScript source so tests don't depend on a
    // build step or on the workspace symlink being present.
    alias: [
      {
        find: /^@dshield\/core$/,
        replacement: path.resolve(dir, "../packages/core/src/index.ts"),
      },
      {
        find: /^@dshield\/core\/(.*)$/,
        replacement: path.resolve(dir, "../packages/core/src/$1.ts"),
      },
    ],
  },
});
