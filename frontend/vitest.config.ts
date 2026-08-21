import { defineConfig } from "vitest/config";
import path from "path";

// Override global NODE_ENV=production so React loads its development build
// (which exports React.act — required by @testing-library/react)
process.env.NODE_ENV = "test";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./src/lib/test-setup.ts"],
    env: {
      NODE_ENV: "test",
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});