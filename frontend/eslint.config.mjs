import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Orphaned by PR #167: never had a working "./poseidon" counterpart, and
    // isn't imported anywhere. See the NOTE at the top of the file.
    "src/lib/bridge.ts",
  ]),
]);

export default eslintConfig;
