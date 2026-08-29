// The Poseidon2 hasher, Merkle-tree builder and commitment/nullifier/KYC/
// recipient derivations now live in the shared @dshield/core package so the
// browser app and the `dshield` CLI compute every hash identically. This module
// is a thin re-export to preserve the app's existing `@/lib/poseidon2` imports.
export * from "@dshield/core/poseidon2";
