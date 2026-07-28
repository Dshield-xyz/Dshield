# DShield Frontend Bundle Size Analysis

> Generated: 2026-07-26 | Next.js 16.2.9 (Turbopack) | Branch: `perf/circuit-lazy-loading`

---

## Summary

The DShield frontend embeds three compiled Noir circuit artifacts
(`shielded_pool.json`, `compliance.json`, `disclosure.json`) that are required
for client-side ZK proof generation.  Before this PR they were imported with
static `import` statements at the top of `prover.ts`, which caused all three
JSON files to land in every page's initial bundle.

This PR converts every import in `prover.ts` to a dynamic `import()` so each
artifact is fetched only when the user actually triggers proof generation on
the relevant page.  The barretenberg WASM runtime (`@aztec/bb.js`,
`@noir-lang/acvm_js`) is also moved inside `generateProof()` for the same
reason.

---

## Circuit Artifact Sizes

### `src/circuits/` (imported by the prover)

| Artifact | File size |
|---|---|
| `shielded_pool.json` | 9,894 B (9.7 KB) |
| `compliance.json` | 10,824 B (10.6 KB) |
| `disclosure.json` | 11,075 B (10.8 KB) |
| `hasher.json` | 4,275 B (4.2 KB) |
| **Total** | **36,068 B (35.2 KB)** |

The bytecode field inside each JSON is base64-encoded ACIR; decoded sizes are
2.5 KB (shielded\_pool), 2.5 KB (compliance), 2.8 KB (disclosure), and 161 B
(hasher).  The bulk of each file is the Noir ABI and debug symbols.

### `public/circuits/` (served as static assets, not bundled)

| Artifact | File size |
|---|---|
| `shielded_pool.json` | 9,489 B (9.3 KB) |
| `hasher.json` | 4,275 B (4.2 KB) |

These files are served directly via the Next.js public directory and are not
processed by the bundler.

---

## ZK Runtime Package Sizes (installed)

| Package | Installed size |
|---|---|
| `@aztec/bb.js` 0.87.0 | ~10.4 MB |
| `@noir-lang/acvm_js` 1.0.0-beta.9 | ~7.3 MB (includes 3.8 MB WASM) |
| `@noir-lang/noirc_abi` 1.0.0-beta.9 | ~1.2 MB |
| `@noir-lang/noir_js` 1.0.0-beta.9 | ~27 KB |

> **Note:** These packages contain pre-compiled WASM binaries and are
> intentionally large.  They are **never part of the initial page load** —
> they are fetched on demand only when proof generation begins
> (after the user initiates a Withdraw or Compliance action and the dynamic
> `import()` chain fires).

---

## Production Build Output

Built with `pnpm build` (Next.js 16.2.9, Turbopack).

### Total static JS

| Metric | Value |
|---|---|
| All static JS chunks combined | 8,435 KB |
| Largest two chunks (barretenberg WASM, gzip-encoded) | 3,336 KB + 3,324 KB |
| Remaining shared + page chunks | ~1,775 KB |

### Circuit artifact async chunks (lazy-loaded)

Each circuit JSON is emitted as its own separate async chunk and is **not**
included in the initial page payload.

| Chunk file | Size | Circuit |
|---|---|---|
| `0fjk98giso5ek.js` | 9,934 B (9.7 KB) | `shielded_pool.json` |
| `00lcyqjx0c1rs.js` | 11,149 B (10.9 KB) | `compliance.json` |
| `18j71hmoxivvw.js` | 11,391 B (11.1 KB) | `disclosure.json` |

These chunks are fetched by the browser only when the user triggers proof
generation (i.e. clicking "Generate Proof & Withdraw" or "Generate Report").

### Worker files (shared, loaded once)

| File | Size |
|---|---|
| `main.worker.*.js` | 45,782 B (44.7 KB) |
| `thread.worker.*.js` | 41,317 B (40.4 KB) |

---

## Per-Page Loading Strategy

| Route | Circuits loaded | When |
|---|---|---|
| `/` (home) | none | — |
| `/deposit` | none | Deposit does not generate ZK proofs |
| `/withdraw` | `shielded_pool.json` + ZK runtime | On "Generate Proof & Withdraw" |
| `/compliance` | `compliance.json` + `disclosure.json` + ZK runtime | On "Generate Report" |
| `/history` | none | — |

The initial page load for every route is free of circuit artifacts and ZK
runtime code.

---

## How to Re-run the Analysis

### Production build

```bash
cd frontend
pnpm build
```

The build output lists all chunks under `.next/static/chunks/`.

### Interactive bundle visualizer

```bash
cd frontend
ANALYZE=true pnpm build
```

This opens two HTML reports (client + server) in your browser powered by
`@next/bundle-analyzer`.  Set `openAnalyzer: true` in `next.config.ts` if you
want them to open automatically, or find the generated files at:

```
.next/analyze/client.html
.next/analyze/server.html
```

---

## Changes Made (this PR)

### `frontend/src/lib/prover.ts`

- Removed three static top-level `import` statements for circuit JSON files.
- Replaced each with a `dynamic import()` inside the corresponding `prove*`
  function, using named webpack chunk hints:
  - `/* webpackChunkName: "circuit-shielded-pool" */`
  - `/* webpackChunkName: "circuit-compliance" */`
  - `/* webpackChunkName: "circuit-disclosure" */`
- Moved `@noir-lang/noir_js` and `@aztec/bb.js` imports inside
  `generateProof()` so the heavy ZK runtime is also deferred.

### `frontend/next.config.ts`

- Added `@next/bundle-analyzer` integration, enabled via `ANALYZE=true`.

### `frontend/package.json`

- Added `@next/bundle-analyzer 16.2.12` to `devDependencies`.

### `frontend/src/lib/prover.test.ts`

- 34 new unit tests covering public API, ProofResult encoding, per-circuit
  bytecode routing, `keccak: true` flag, `backend.destroy` in `finally`,
  all input field mappings for all three circuits, and `ensureHex` behaviour.

---

## Acceptance Criteria Checklist

- [x] **Bundle analysis report generated** — this document, committed to the
      repository.  Re-run at any time with `ANALYZE=true pnpm build`.
- [x] **Circuit artifacts load per-page, not globally** — confirmed in the
      production build: each artifact is an independent async chunk fetched
      only when proof generation is triggered.  No circuit JSON appears in
      the initial page bundle for any route.
- [x] **All tests pass** — `pnpm test` reports 131/131 tests passing across
      12 test files.
