# Contributing to DShield

Thanks for your interest in contributing. DShield is a shielded stablecoin wallet on Stellar (Soroban contracts + Noir circuits + a Next.js frontend), currently a testnet demo. This guide covers how to get set up and how to submit changes.

> **New to ZK or Stellar?** See [GLOSSARY.md](GLOSSARY.md) for plain-English definitions of terms like _nullifier_, _commitment_, _Merkle root_, _UltraHonk_, _Poseidon2_, _selective disclosure_, _relayer_, and more — everything you need before diving in.

## Ground rules

- This is unaudited software handling a shielded pool of funds (testnet only, for now). Be conservative with changes to `contracts/` and `circuits/` — correctness bugs there are security bugs. See [Security Model](README.md#security-model) in the README before touching hashing, nullifiers, or recipient binding.
- Open an issue before starting significant work (new features, architecture changes) so we can align on approach before you invest time.
- Small fixes (typos, docs, obvious bugs) can go straight to a PR.

## Getting set up

Prerequisites: Rust + `wasm32v1-none` target, [`stellar` CLI](https://developers.stellar.org/docs/tools/cli), [Noir (`nargo`)](https://noir-lang.org/docs) + Barretenberg (`bb`), Node + `pnpm`, [`just`](https://github.com/casey/just).

```bash
just setup           # verify all prerequisites are installed
just start && just deploy   # local network, deploy contracts, write frontend/.env.local
cd frontend && pnpm install && pnpm dev
```

Run `just --list` for the full set of available recipes (build, deploy, demo, clean, etc).

## Making changes

1. Fork the repo and create a branch off `dev`.
2. Make your change. Keep diffs focused — unrelated cleanup makes review harder.
3. Add or update tests for any behavior change. This repo treats tests as load-bearing:
   - `just test-contracts` — Rust/Soroban contract tests
   - `just test-frontend` — frontend unit tests
   - `just test` — both
   - `just test-e2e` (or `tests/e2e.sh`) — full on-chain deposit/withdraw loop against a local network
4. If you touch a Noir circuit, make sure it still compiles and the corresponding proof round-trips: `nargo compile && nargo execute` in the circuit's directory, then regenerate the checked-in `frontend/src/circuits/*.json` / `frontend/public/circuits/*.json` artifacts the frontend embeds for client-side proving (see `just build-circuits`).
5. Run the frontend linter (`pnpm lint` in `frontend/`) and make sure `pnpm build` type-checks cleanly. The pre-commit hook runs `eslint --fix` automatically on staged `src/**/*.{ts,tsx}` files when you commit.
6. Open a PR against `dev`, not `main` — all active development merges into `dev`. Describe _why_ the change is needed, not just what changed — link the issue if there is one. CI (circuit compile/proof round-trip, contract tests, frontend tests, lint, and an on-chain e2e run) must pass before merge.

## Where things live

- `circuits/` — Noir circuits (`shielded_pool`, `compliance`, `disclosure`, `hasher`), compiled with Barretenberg's UltraHonk (keccak transform).
- `contracts/` — Soroban contracts in Rust: `pool` (deposits/withdrawals/nullifiers), `verifier` (BN254/UltraHonk proof verification), `compliance` (KYC registry + disclosure proof verification).
- `frontend/` — Next.js wallet UI, including the client-side prover.
- `scripts/`, `tests/e2e.sh` — demo and end-to-end scripts driven by the `justfile`.
- `DESIGN.md` — deeper technical design notes if you want the full picture before diving in.
- `GLOSSARY.md` — plain-English definitions of ZK and Soroban terms used throughout the codebase.

## Reporting bugs / requesting features

Use GitHub Issues. For anything that could be a security vulnerability (a way to double-spend, forge a proof, bypass recipient binding, drain the pool, etc.), do **not** open a public issue — see [SECURITY.md](SECURITY.md) instead.

## Changelog Requirements

All user-facing or architectural PRs must include a corresponding entry in the `CHANGELOG.md` file under the `## [Unreleased]` header, utilizing standard changelog tags:

- `Added` - for new features
- `Changed` - for changes in existing functionality
- `Deprecated` - for soon-to-be removed features
- `Removed` - for now removed features
- `Fixed` - for any bug fixes
- `Security` - in case of vulnerabilities

## Code of conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). Be respectful; disagreements about code are fine, personal attacks aren't.
