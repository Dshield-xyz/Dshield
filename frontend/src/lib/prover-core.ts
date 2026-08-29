// The Noir witness execution + UltraHonk proof generation lives in the shared
// @dshield/core package so the app and the `dshield` CLI prove identically. This
// module is a thin re-export to preserve the app's `@/lib/prover-core` imports
// (used by the Web Worker in `prover.worker.ts`).
export * from "@dshield/core/prover-core";
