# DShield Indexer Service

A standalone Node service that scans a DShield pool contract's `deposit`/`withdraw`
events over Stellar RPC, maintains a local commitment/tree store, and serves
Merkle paths over a small HTTP/JSON API — so a withdrawal proof can be built
without scanning RPC events or paging `get_commitments_page` in-browser.

It is optional. The frontend works fully without one (see
`frontend/src/lib/indexer.ts`'s `fetchCommitmentsFromChain`/`syncDepositsFromChain`),
scanning RPC directly. Point the frontend at a self-hosted instance of this
service (see "Trust model" below) to skip that in-browser work, or run it as
the basis for another client (a CLI, a mobile app) that needs the same data.

## Running it

```sh
cd services/indexer
npm install
npm run build
POOL_CONTRACT_ID=C... npm start
```

### Configuration (environment variables)

| Variable | Default | Description |
|---|---|---|
| `POOL_CONTRACT_ID` | *(required)* | The pool contract to index. |
| `RPC_URL` | `http://localhost:8000/soroban/rpc` | Stellar RPC endpoint. |
| `NETWORK_PASSPHRASE` | `Standalone Network ; February 2017` | Network passphrase matching `RPC_URL`. |
| `PORT` | `8091` | HTTP port to listen on. |
| `DATA_FILE` | `./data/indexer-store.json` | Where the local commitment/cursor cache is persisted between restarts. |
| `POLL_INTERVAL_MS` | `5000` | How often to poll RPC for new events. |

The service scans from ledger 1 on first run (falling back to the RPC's
recent-event retention window if that's rejected, same as the frontend's
in-browser sync) and checkpoints its cursor to `DATA_FILE` after every page, so
a restart resumes rather than rescanning.

To point the frontend at a running instance, set
`NEXT_PUBLIC_INDEXER_SERVICE_URL` to its base URL (e.g. `http://localhost:8091`)
before building/running the frontend.

## API

All responses are JSON. All routes are read-only (`GET`).

### `GET /health`

```json
{ "ok": true, "poolId": "C...", "leafCount": 42, "spentNullifierCount": 3 }
```

### `GET /commitments`

Every commitment the service has indexed, in leaf-index order (unseen indices
hold the zero leaf).

```json
{ "poolId": "C...", "count": 42, "commitments": ["0x00...", "0x1a2b..."] }
```

### `GET /root`

The Merkle root over the currently indexed commitment set.

```json
{ "poolId": "C...", "leafCount": 42, "root": "0x..." }
```

### `GET /proof/:leafIndex`

The sibling path from `leafIndex` up to the current root. 404s if `leafIndex`
hasn't been indexed yet.

```json
{
  "poolId": "C...",
  "leafIndex": 7,
  "root": "0x...",
  "pathSiblings": ["0x...", "..."],
  "pathBits": [0, 1, 0, "..."]
}
```

## Trust model

**This service is a convenience cache, not a source of truth.** It is not part
of the pool's trust boundary, and a client is never required to trust it:

- The pool contract itself is the only authority on which root is valid — it
  keeps a bounded history of the last 30 roots it has ever produced
  (`is_known_root` / `ROOT_HISTORY_SIZE` in `contracts/pool/src/lib.rs`) and
  rejects any withdrawal proof whose public `root` isn't in that set.
- A withdrawal proof is built entirely from data this service returns
  (`pathSiblings`, `pathBits`, and the `root` they resolve to), but the proof
  is only useful if that root matches one the contract actually produced. If
  this service is stale, buggy, or actively malicious, the worst it can do is
  hand out a path that resolves to a root the contract doesn't recognize — the
  withdrawal then fails cleanly (`RootMismatch`) rather than paying out
  anything incorrectly. It cannot forge a valid proof for funds it doesn't
  control, redirect a payout, or double-spend a nullifier: none of that data
  passes through this service at all.
- Because of this, anyone can run their own instance against public RPC and
  get answers they don't have to trust anyone else for — that's the point of
  it being a standalone, self-hostable service rather than a hosted API this
  deployment's frontend depends on.

In short: point the frontend at whichever instance you trust to be
*available*, since none of them need to be trusted to be *correct*.

## Tests

```sh
npm test
```

`test/tree-equivalence.test.ts` applies a fixture set of deposit/withdraw
events (`test/fixtures/*.json`) to the same store/tree code this service runs,
and checks the resulting root and every leaf's Merkle path against
`@dshield/core`'s `buildMerkleTree` called directly on the same raw commitment
list — i.e. that the service's tree reconstruction agrees with a client
scanning and rebuilding the tree itself.

## Design notes

- The Merkle tree math (`buildMerkleTree`, `computeZeroHashes`) and the
  Stellar RPC scanning helpers live in `packages/core`, shared with the
  frontend so both implementations of "how the pool's tree is built" can't
  drift apart. See `packages/core/src/tree.ts` and `src/chain.ts`.
- Poseidon2 hashing (`src/poseidon.ts`) runs the same compiled `hasher` Noir
  circuit the frontend runs in the browser (`circuits/hasher.json`, committed
  here and refreshed by CI from `circuits/hasher/` at the repo root) via
  `@noir-lang/noir_js` — no WASM proving backend needed, just circuit
  execution, so there's no `@aztec/bb.js` dependency.
- The commitment store (`src/store.ts`) is a single JSON file, not a database.
  A pool's tree tops out at `2^20` leaves; that's small enough that a flat
  file plus a full in-memory tree rebuild per request is simpler than
  standing up a database, and easy to inspect or delete to force a rescan.
