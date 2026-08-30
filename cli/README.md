# `dshield` — DShield command-line client

Script deposits, withdrawals, note management, and compliance reports against a
DShield shielded pool — no browser, no wallet extension. The CLI reuses the exact
note, commitment, Merkle, and proof logic the web app uses, via the shared
[`@dshield/core`](../packages/core) package, so a note minted here is spendable in
the app and vice-versa.

## Install

The CLI runs its TypeScript source through [`tsx`](https://tsx.is) — there's no
build step. From the repository root (a pnpm workspace covering `packages/*` and
`cli`):

```bash
pnpm install
```

Then invoke it one of these ways:

```bash
# Via the workspace binary
pnpm --filter @dshield/cli exec dshield --help

# Or link it onto your PATH
cd cli && pnpm link --global    # provides a global `dshield`
dshield --help

# Or run the entrypoint directly
node cli/bin/dshield.mjs --help
```

Requires Node.js 20.6+ (the CLI uses `module.register` to load the tsx ESM loader).

## Configuration

Every command needs to know which network and pool to talk to, and — for
anything that submits a transaction — a signing key. Settings are resolved in
this order (highest priority first):

1. **CLI flags** — `--rpc`, `--network-passphrase`, `--pool`, `--compliance`,
   `--usdc-code`, `--usdc-issuer`, `--secret-key`, `--issuer-secret`,
   `--sign-with`, `--home`, `--env-file`.
2. **Environment variables** — `DSHIELD_RPC_URL`, `DSHIELD_NETWORK_PASSPHRASE`,
   `DSHIELD_POOL_ID`, `DSHIELD_COMPLIANCE_ID`, `DSHIELD_USDC_CODE`,
   `DSHIELD_USDC_ISSUER`, `DSHIELD_SECRET_KEY`, `DSHIELD_ISSUER_SECRET`,
   `DSHIELD_SIGN_WITH`, `DSHIELD_PUBLIC_KEY`, `DSHIELD_HOME`, `DSHIELD_ENV_FILE`.
3. **`~/.dshield/config.json`** — a JSON object with any of the `DshieldConfig`
   keys (`rpcUrl`, `networkPassphrase`, `poolId`, `complianceId`, `usdcCode`,
   `usdcIssuer`, `secretKey`, `issuerSecret`, `signWith`).
4. **`frontend/.env.local`** — auto-detected by walking up from the current
   directory. This is the file `just deploy` writes, so inside a checkout with a
   live local/testnet deployment the CLI needs **zero** configuration.
5. **Built-in defaults** — local quickstart RPC (`http://localhost:8000/soroban/rpc`)
   and the Standalone network passphrase.

Global flags go **before** the command, e.g. `dshield --json --pool C… deposit …`.

### Wallet / signing

Unlike the browser (which uses Stellar Wallets Kit / Freighter), the CLI signs
locally or delegates to an external signer:

- **Local key** — a Stellar secret seed (`S…`) via `--secret-key`,
  `DSHIELD_SECRET_KEY`, `~/.dshield/config.json`, or a `~/.dshield/key` file
  containing just the seed.
- **External / hardware signer** — `--sign-with "<command>"`. The command
  receives the unsigned transaction as base64 XDR on **stdin** and must print the
  **signed** XDR on **stdout**. The seed never enters this process. Provide the
  source account's public key via `DSHIELD_PUBLIC_KEY` (or also pass
  `--secret-key` to derive it). Point it at a `stellar tx sign` helper or a
  Ledger bridge.

The note store and keyfile live under `~/.dshield` (override with `--home`).
**The note file holds every nullifier and secret — it is the only key to your
shielded funds. Back it up and keep it private.**

## Commands

### `dshield deposit --amount <usdc> [--dry-run]`

Shields `<usdc>` into the pool and prints a private note (save it!).

- On a test network, if the wallet's USDC balance is short and `--issuer-secret`
  (or `USDC_ISSUER_SECRET` from `.env.local`) is available, the CLI mints test
  USDC to cover it — the CLI-side equivalent of the app's faucet.
- `--dry-run` builds and stores the note **offline** (no network, no signing) and
  prints it. Useful for scripting, tests, and CI smoke checks.

```bash
dshield --pool C… --secret-key S… deposit --amount 10.5
```

### `dshield withdraw (--note <string> | --commitment <hex>) [--to <G…>] [--amount <usdc>]`

Redeems a note. Omit `--amount` to withdraw the whole note; pass it to withdraw
part and re-shield the remainder into a fresh note (printed on success). Use a
`--to` address different from your wallet for an unlinkable payout.

```bash
# Full withdrawal to yourself
dshield withdraw --commitment 1a2b… 

# Partial withdrawal to someone else
dshield withdraw --note dshield-v1-… --to GRECIPIENT… --amount 4
```

Generating the zero-knowledge proof takes ~1 minute.

### `dshield notes list`

Lists stored notes with amount, status (`active` / `pending` / `spent` /
`empty`), and leaf index.

### `dshield notes export [--out <file>]`

Writes all stored notes as a backup blob to stdout (or a file). This blob is the
full set of keys to your funds.

### `dshield notes import <input>`

Imports notes from a backup file **or** an inline note string, de-duplicating by
commitment.

```bash
dshield notes import ./dshield-notes.txt
dshield notes import "dshield-v1-C…-3-10000000-…"
```

### `dshield compliance disclose (--note <string> | --commitment <hex>) [--out <file>] [--offline]`

Produces a verifiable compliance report for a note: it recomputes the commitment
and nullifier hash from the note (proving integrity) and confirms the deposit and
withdrawal status from the pool's authoritative on-chain state. It deliberately
**never includes the note itself**, so the report is safe to share with an
auditor. `--offline` reports only the note-integrity check without any chain
reads.

```bash
dshield compliance disclose --commitment 1a2b… --out report.txt
```

## Full deposit → withdraw cycle (no browser)

Against a local deployment (`just e2e` / `just deploy` first, which writes
`frontend/.env.local`):

```bash
# Deposit 10 USDC (config + funding auto-detected from frontend/.env.local)
NOTE=$(dshield --json deposit --amount 10 | jq -r .note)

# Withdraw 4 USDC to another address; 6 is re-shielded into a new note
dshield withdraw --note "$NOTE" --to GRECIPIENT… --amount 4

# Prove what happened, for an auditor
dshield compliance disclose --note "$NOTE" --out report.txt
```

## `--json`

Pass the global `--json` flag to emit machine-readable JSON on stdout (progress
lines go to stderr). Ideal for scripting and CI.

## Development

```bash
pnpm --filter @dshield/cli test        # unit tests (vitest)
pnpm --filter @dshield/cli typecheck   # tsc --noEmit
pnpm --filter @dshield/cli exec dshield --help
```
