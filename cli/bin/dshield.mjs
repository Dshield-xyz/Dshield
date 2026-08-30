#!/usr/bin/env node
// The CLI is shipped as TypeScript source and run through tsx, which transpiles
// TS on the fly and handles the ESM-only WASM dependencies (@noir-lang/noir_js,
// @aztec/bb.js) and the JSON circuit imports in @dshield/core without a separate
// build step. This shim registers the tsx ESM loader, then hands off to the real
// entrypoint.
// tsx's official programmatic API transpiles the TypeScript entrypoint (and its
// @dshield/core imports + JSON circuit files) on the fly, so the CLI ships as
// source with no build step. tsImport scopes the loader to this import graph.
import { tsImport } from "tsx/esm/api";

await tsImport("../src/index.ts", import.meta.url);
