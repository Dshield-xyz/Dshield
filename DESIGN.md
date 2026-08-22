# DShield Design Document

> Research, architecture, and implementation strategy for the DShield shielded stablecoin wallet on Stellar.

---

## Table of Contents

- [Core Thesis](#core-thesis)
- [Stellar ZK Landscape](#stellar-zk-landscape)
- [What Stellar Does NOT Provide](#what-stellar-does-not-provide)
- [Competitive Analysis](#competitive-analysis)
- [Architecture](#architecture)
- [ZK Stack Selection](#zk-stack-selection)
- [Tech Stack](#tech-stack)
- [Toolchain Versions](#toolchain-versions)
- [Reference Implementations](#reference-implementations)
- [Contract Architecture](#contract-architecture)
- [Circuit Design](#circuit-design)
- [Project Structure](#project-structure)
- [Hackathon MVP Scope](#hackathon-mvp-scope)
- [Build Order](#build-order)
- [Key Risks](#key-risks)
- [Resources](#resources)

---

## Core Thesis

Stellar does not currently provide shielded transactions natively. What it does provide are the cryptographic building blocks needed to build them.

The winning projects in the Stellar Hacks: Real-World ZK hackathon will be applications and protocols built on top of those primitives. DShield is positioned as:

> The first consumer-grade shielded USDC wallet on Stellar with selective disclosure and compliance proofs.

The narrative is **"compliance-forward privacy"** rather than anonymous-by-default. This aligns with Stellar's institutional direction and avoids the regulatory problems that have sunk projects like Tornado Cash.

---

## Stellar ZK Landscape

### Protocol 25 (X-Ray)

Added foundational ZK primitives to Soroban:

- BN254 curve operations (CAP-0074)
- Pairing checks
- Poseidon hash functions (CAP-0075)
- Poseidon2 hash functions

These are essentially Stellar's version of Ethereum precompiles for zkSNARK verification.

### Protocol 26 (Yardstick)

Made ZK verification significantly cheaper:

- BN254 multi-scalar multiplication
- Scalar arithmetic
- Curve membership checks

Together, these protocols enable efficient on-chain zkSNARK proof verification within Soroban smart contracts.

### Available Host Functions

From the Soroban SDK (v26.0.1):

```
// BN254 operations
g1_add(a: BytesN<64>, b: BytesN<64>) -> BytesN<64>
// + scalar multiplication, pairing checks

// Poseidon hashing (operates on BN254 scalar field Fr)
poseidon(inputs: Vec<U256>) -> U256
poseidon2(inputs: Vec<U256>) -> U256
```

Arguments currently use raw bytes and U256 values. Future SDK versions will add native BN254 type support.

---

## What Stellar Does NOT Provide

Stellar does not provide:

- A shielded transaction protocol
- A commitment scheme
- A nullifier system
- A Merkle tree for note tracking
- Client-side proof generation
- Selective disclosure mechanisms

All of these must be built by the application layer. This is the opportunity.

---

## Competitive Analysis

### ZCash

- Strong privacy
- Terrible UX
- Expensive proving
- Separate ecosystem, limited stablecoin support

### Tornado Cash

- Good privacy
- Compliance nightmare (OFAC sanctioned)
- No selective disclosure
- Regulators actively oppose it

### Monero

- Strong privacy
- Impossible compliance
- Institutional adoption impossible
- No stablecoin support

### DShield Differentiation

DShield solves the core tension: **privacy without compliance sacrifice**.

Instead of a binary "private or public" model, DShield introduces selective disclosure:

- Users control what is revealed
- Compliance proofs work without exposing personal data
- Auditors, employers, and regulators can receive targeted proofs
- Default state is private; disclosure is opt-in

---

## Architecture

### Layer 1: Shielded Wallet

User-facing application. Users see familiar banking UX: balances, send, receive. No raw addresses or hex values.

### Layer 2: Shielded Pool

Funds move into a privacy pool managed by a Soroban smart contract. The pool stores:

- **Commitments**: Poseidon2 hash of (value, secret, nullifier) representing ownership
- **Nullifiers**: Spent-note markers to prevent double-spending
- **Merkle tree**: Incremental frontier-based tree (depth 20) tracking all commitments

This follows the same model as ZCash's note-based UTXO system.

### Layer 3: Client-Side Proof Generation

When a user sends funds, their browser/device generates a ZK proof demonstrating:

- Ownership of a valid note (Merkle inclusion proof)
- The note has not been spent (nullifier not in spent set)
- Inputs equal outputs (balance preservation)

The proof never exposes the note, the amount, or the parties involved. Sensitive data never leaves the user's device.

### Layer 4: Soroban Verifier

Two contracts work together:

1. **Verifier Contract**: Stores the immutable verification key (VK) at deployment. Accepts proof bytes and public inputs, verifies using UltraHonk via BN254 host functions.
2. **Pool Contract**: Manages the shielded pool — deposits, withdrawals, Merkle tree state, nullifier tracking. Calls the verifier contract for proof validation.

### Layer 5: Selective Disclosure

Users can generate specialized proofs for different audiences using separate Noir circuits, each with its own verifier contract:

#### Auditor Key
- "I received funds legally."
- Proves source of funds without exposing unrelated transactions.

#### Employer Key
- "Salary received."
- Proves payment receipt without exposing other income.

#### Tax Authority Key
- "Total annual income = $40,000."
- Proves aggregate amounts without exposing individual payments.

#### Compliance Proof
- "KYC completed. Wallet authorized. Jurisdiction approved."
- Proves regulatory status without revealing identity documents.

---

## ZK Stack Selection

### Noir (Primary Choice)

Noir is the most promising option for Stellar because:

1. Stellar already has **UltraHonk verifier contracts** available ([rs-soroban-ultrahonk](https://github.com/yugocabrio/rs-soroban-ultrahonk))
2. Stellar documentation includes **Noir verifier examples**
3. A complete **tornado-classic mixer** reference exists using Noir + UltraHonk on Soroban
4. The workflow is straightforward:
   - Write circuit in Noir
   - Compile with `nargo compile`
   - Generate verification key with `bb write_vk_ultra_honk`
   - Generate proof client-side with `bb prove_ultra_honk`
   - Deploy verifier contract with VK embedded
   - Submit proof to Soroban pool contract
   - Verify on-chain via cross-contract call to verifier

### RISC Zero (Alternative)

Also supported by Stellar with a [Groth16 verifier](https://github.com/NethermindEth/stellar-risc0-verifier). Flow:

1. Run arbitrary Rust program
2. Generate ZK proof of correct execution
3. Verify proof on Stellar

RISC Zero is more flexible but heavier. Noir is preferred for this use case because the circuits are well-defined and the verification is cheaper.

---

## Tech Stack

| Component        | Choice                                       |
| ---------------- | -------------------------------------------- |
| Blockchain       | Stellar                                      |
| Smart Contracts  | Soroban (Rust)                               |
| ZK Circuit       | Noir                                         |
| Proof System     | UltraHonk                                    |
| Hashing          | Poseidon2 (via `dep::poseidon::poseidon2`)   |
| Verification     | BN254 pairing checks                         |
| Verifier Crate   | `ultrahonk_soroban_verifier`                 |
| Stablecoin       | USDC on Stellar                              |
| Frontend         | Next.js + TypeScript + TailwindCSS           |
| Wallet           | Freighter / Stellar Wallets Kit              |
| Proof Generation | Browser / WebAssembly (Barretenberg)         |
| Storage          | Encrypted local notes + optional IPFS backup |

---

## Toolchain Versions

| Tool              | Version           | Purpose                          |
| ----------------- | ----------------- | -------------------------------- |
| Rust              | stable            | Smart contracts & verifier       |
| `wasm32-unknown-unknown` | (rustup target) | WASM compilation target   |
| Soroban SDK       | `26.0.1`          | Stellar smart contract SDK       |
| Stellar CLI       | `^3.2.0`          | Contract build, deploy, invoke   |
| Noir              | `1.0.0-beta.9`    | ZK circuit language              |
| Barretenberg      | `0.87.0`          | UltraHonk proof backend          |
| Just              | latest            | Task runner for build workflows  |
| Node.js           | latest LTS        | Helper scripts & frontend        |
| Docker            | latest            | Stellar localnet                 |

Install commands:

```bash
# Rust & WASM target
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
rustup target add wasm32-unknown-unknown

# Stellar CLI
cargo install --locked stellar-cli@^3.2.0

# Noir & Barretenberg
noirup -v 1.0.0-beta.9
bbup -v 0.87.0

# Task runner
cargo install just
```

---

## Reference Implementations

### rs-soroban-ultrahonk (Primary Reference)

**Repo**: https://github.com/yugocabrio/rs-soroban-ultrahonk

Contains three directly relevant contracts:

1. **UltraHonk Verifier** — Generic verifier contract. Stores VK at deployment, exposes `verify_proof(public_inputs, proof_bytes)`. DShield will use this pattern for all proof verification.

2. **Tornado Classic Mixer** — Complete privacy pool with deposits, withdrawals, Merkle tree, and nullifier tracking. Uses Poseidon2 hashing, depth-20 incremental Merkle tree with frontier optimization. **This is DShield's primary contract reference.**

3. **Identity Contract** — Proves knowledge of a Poseidon2 preimage without revealing it. Pattern for DShield's selective disclosure proofs.

### Stellar Private Payments (Architecture Reference)

**Repo**: https://github.com/NethermindEth/stellar-private-payments

Nethermind's privacy pool PoC using Circom/Groth16. Different proof system but same architectural patterns:

- Pool contract with deposit/withdraw/transfer
- ASP (Association Set Provider) membership contracts for compliance
- Sparse Merkle trees for non-membership (exclusion) proofs
- Client-side WASM proof generation in browser
- SQLite storage via Origin Private File System for local key/note management

Key insight: ASP membership/non-membership contracts provide the **compliance layer** that makes DShield different from a Tornado clone.

---

## Contract Architecture

### Verifier Contract

Thin wrapper around `ultrahonk_soroban_verifier`. One instance per circuit type.

```rust
// Pattern from rs-soroban-ultrahonk
#[contract]
pub struct VerifierContract;

impl VerifierContract {
    // VK stored immutably at deployment
    pub fn __constructor(env: Env, vk_bytes: Bytes) -> Result<(), Error> { ... }

    // Verify a proof against stored VK
    pub fn verify_proof(env: Env, public_inputs: Bytes, proof_bytes: Bytes) -> Result<(), Error> {
        let verifier = UltraHonkVerifier::new(&env, &vk_bytes)?;
        verifier.verify(&env, &proof_bytes, &public_inputs)?;
        Ok(())
    }
}
```

### Pool Contract (Mixer)

Manages the shielded pool. Key operations:

```rust
// Pattern from tornado_classic mixer
#[contract]
pub struct PoolContract;

impl PoolContract {
    // Initialize with verifier contract address
    pub fn __constructor(env: Env, verifier: Address) -> Result<(), Error> { ... }

    // Deposit: insert commitment into Merkle tree
    pub fn deposit(env: Env, commitment: BytesN<32>) -> Result<u32, Error> {
        // Check commitment not already used
        // Insert into incremental frontier Merkle tree
        // Update root
        // Emit DepositEvent { idx, commitment }
    }

    // Withdraw: verify proof, mark nullifier spent
    pub fn withdraw(env: Env, public_inputs: Bytes, proof_bytes: Bytes) -> Result<(), Error> {
        // Parse public inputs: [root, nullifier_hash]
        // Check nullifier not already used
        // Check root matches stored root
        // Cross-contract call to verifier.verify_proof()
        // Mark nullifier spent
        // Emit WithdrawEvent { nullifier_hash }
    }
}
```

### Poseidon2 Hashing On-Chain

```rust
use soroban_poseidon::{poseidon2_hash, Field};

fn poseidon2_hash2(env: &Env, a: &BytesN<32>, b: &BytesN<32>) -> BytesN<32> {
    let modulus = <BnScalar as Field>::modulus(env);
    let mut inputs = SorobanVec::new(env);
    inputs.push_back(U256::from_be_bytes(env, &a_bytes).rem_euclid(&modulus));
    inputs.push_back(U256::from_be_bytes(env, &b_bytes).rem_euclid(&modulus));
    let out = poseidon2_hash::<4, BnScalar>(env, &inputs);
    // Convert to BytesN<32>
}
```

### Incremental Merkle Tree

Depth-20 frontier-based tree. Zero values: `zero[0] = 0; zero[i+1] = H(zero[i], zero[i])`.

On each deposit:
- Walk from leaf to root using the insertion index bits
- At each level: if bit=0, store current node as frontier, hash with zero sibling; if bit=1, hash with stored frontier sibling
- Update stored root

This avoids storing the full tree on-chain — only the frontier nodes and the root.

---

## Circuit Design

### Shielded Pool Circuit (tornado pattern)

```noir
use dep::poseidon::poseidon2::Poseidon2;

fn hash2(a: Field, b: Field) -> Field {
    Poseidon2::hash([a, b], 2)
}

pub fn main(
    // Public inputs
    root: pub Field,
    nullifier_hash: pub Field,
    // Private inputs
    nullifier: Field,
    secret: Field,
    path_siblings: [Field; 20],
    path_bits: [Field; 20],
) {
    // Compute commitment: leaf = H(nullifier, secret)
    let leaf = hash2(nullifier, secret);

    // Compute nullifier hash: nf = H(nullifier, 0)
    let nf = hash2(nullifier, 0);
    assert(nf == nullifier_hash);

    // Verify Merkle inclusion
    let computed_root = compute_root(leaf, path_siblings, path_bits);
    assert(computed_root == root);
}
```

**Public inputs** (revealed on-chain): `root`, `nullifier_hash`
**Private inputs** (never leave client): `nullifier`, `secret`, Merkle path

### DShield Extensions to Base Circuit

The base tornado circuit handles fixed-denomination deposits, where the amount
is a property of the pool and never enters the leaf. DShield binds the value
into the commitment instead, which is what lets a single pool hold notes of any
size and lets a spend pay out only part of one. See
`circuits/shielded_pool/src/main.nr` for the implementation.

```noir
pub fn main(
    // Public inputs
    root: pub Field,
    nullifier_hash: pub Field,
    recipient: pub Field,           // recipient address hash
    withdraw_amount: pub Field,     // paid out to `recipient`
    change_commitment: pub Field,   // the re-shielded remainder, a new leaf
    // Private inputs
    nullifier: Field,
    secret: Field,
    amount: Field,                  // what the spent note is worth
    change_nullifier: Field,
    change_secret: Field,
    path_siblings: [Field; 20],
    path_bits: [Field; 20],
) {
    // Value conservation. Both sides are pinned to 64 bits FIRST: a bare
    // `as u64` truncates without constraining, so an unconstrained `amount`
    // near the field modulus would wrap to a small u64 and mint value.
    let amount_u64 = constrain_u64(amount);
    let withdraw_u64 = constrain_u64(withdraw_amount);
    assert(withdraw_u64 <= amount_u64);
    let change = amount - withdraw_amount;

    // commitment = H(H(H(LEAF_DOMAIN, nullifier), secret), amount)
    //
    // A chain of two-input hashes rather than one wide hash, because the two
    // other implementations that must agree with this bit for bit can only
    // compute the two-input primitive: the frontend (which ships just the
    // `hasher` circuit) and the pool contract (`poseidon2_hash2`).
    let leaf = hash_leaf(nullifier, secret, amount);

    // nullifier_hash = H(H(NULLIFIER_DOMAIN, nullifier), 0)
    assert(hash_nullifier(nullifier) == nullifier_hash);

    // Merkle inclusion proof
    assert(compute_root(leaf, path_siblings, path_bits) == root);

    // The remainder is a well-formed note the spender can open later. Built on
    // EVERY spend, including a full withdrawal where `change` is zero, so that
    // "took part" and "took the lot" are the same shape on-chain.
    assert(hash_leaf(change_nullifier, change_secret, change) == change_commitment);
}
```

The contract completes the other half: it pays out `withdraw_amount`, appends
`change_commitment` as a new leaf through the same insertion path a deposit
uses, and emits the same event — so a re-shielded remainder is indistinguishable
from someone shielding fresh funds.

### Compliance Proof Circuit (Identity Pattern)

```noir
use dep::poseidon::poseidon2::Poseidon2;

fn main(
    // Private: the actual KYC data
    preimage: Field,
    // Public: hash that a verifier can check against a registry
    hash: pub Field,
) {
    let computed_hash = Poseidon2::hash([preimage], 1);
    assert(computed_hash == hash);
}
```

This proves knowledge of KYC data whose hash is registered on-chain, without revealing the data itself.

### Selective Disclosure Circuit

```noir
pub fn main(
    // Public: what the auditor sees
    total_amount: pub Field,
    auditor_key: pub Field,
    // Private: what stays hidden
    individual_amounts: [Field; N],
    secrets: [Field; N],
) {
    // Prove sum of individual amounts equals declared total
    let mut sum: Field = 0;
    for i in 0..N {
        sum = sum + individual_amounts[i];
    }
    assert(sum == total_amount);

    // Prove each amount corresponds to a valid commitment
    // (Merkle proofs omitted for brevity)
}
```

---

## Project Structure

Based on the rs-soroban-ultrahonk workspace pattern:

```
dshield/
├── circuits/                    # Noir ZK circuits
│   ├── shielded_pool/           # Core deposit/withdraw circuit
│   │   ├── Nargo.toml
│   │   ├── Prover.toml
│   │   └── src/main.nr
│   ├── compliance/              # KYC/compliance proof circuit
│   │   ├── Nargo.toml
│   │   ├── Prover.toml
│   │   └── src/main.nr
│   └── disclosure/              # Selective disclosure circuit
│       ├── Nargo.toml
│       ├── Prover.toml
│       └── src/main.nr
├── contracts/                   # Soroban smart contracts
│   ├── verifier/                # UltraHonk verifier (generic)
│   │   ├── Cargo.toml
│   │   └── src/lib.rs
│   ├── pool/                    # Shielded pool (deposits, withdrawals, Merkle tree)
│   │   ├── Cargo.toml
│   │   └── src/lib.rs
│   └── compliance/              # Compliance proof verifier
│       ├── Cargo.toml
│       └── src/lib.rs
├── crates/                      # Shared Rust libraries
│   └── dshield-common/          # Shared types, constants
│       └── Cargo.toml
├── frontend/                    # Next.js application
│   ├── src/
│   │   ├── app/                 # Next.js app router
│   │   ├── components/          # React components
│   │   ├── lib/                 # Client-side proof generation (WASM)
│   │   └── hooks/               # Wallet & contract hooks
│   ├── package.json
│   └── tsconfig.json
├── scripts/                     # Build & deployment helpers
│   ├── deploy.sh
│   └── invoke/                  # TypeScript invocation utilities
├── Cargo.toml                   # Workspace manifest
├── justfile                     # Task runner commands
├── README.md
├── DESIGN.md
└── LICENSE
```

### Workspace Cargo.toml

```toml
[workspace]
resolver = "2"
members = [
    "contracts/verifier",
    "contracts/pool",
    "contracts/compliance",
    "crates/dshield-common",
]

[workspace.dependencies]
soroban-sdk = { version = "26.0.1", default-features = false }

[profile.release]
opt-level = "z"
lto = true
codegen-units = 1
panic = "abort"
strip = "symbols"
overflow-checks = true
```

---

## Hackathon MVP Scope

The full shielded wallet vision is months of work. For the hackathon, scope is cut to five core features:

### Feature 1: Deposit USDC

User deposits USDC into the shielded pool. A cryptographic commitment is created and stored on-chain in the Merkle tree.

### Feature 2: Shielded Commitment

The deposit generates a Poseidon2 hash commitment representing ownership. The commitment is added to the on-chain incremental Merkle tree (depth 20, frontier-based).

### Feature 3: Private Withdrawal

User proves ownership of a commitment via ZK proof (Noir circuit → UltraHonk proof → Soroban verification). Nullifier is marked spent. USDC is released.

### Feature 4: Compliance Proof

User generates a proof demonstrating KYC completion without revealing identity information. Uses the identity circuit pattern with a separate verifier contract.

### Feature 5: Auditor Disclosure

User selectively reveals transaction history to an authorized viewer. This single feature differentiates DShield from every "Tornado clone" that will be submitted.

### Explicitly Out of Scope for MVP

- Private transfer (user-to-user shielded transfer)
- IPFS backup
- Payroll flows
- Merchant payment flows
- Cross-border remittance features
- Full consumer-grade UI polish
- ASP membership/non-membership contracts (post-MVP compliance layer)

---

## Build Order

Priority is correctness of the ZK system over frontend polish. Judges care about the proof actually working on-chain.

### Step 1: Noir Circuits

Build the core ZK circuits using Noir `1.0.0-beta.9`:

**Shielded Pool Circuit:**
- Commitment scheme: `commitment = Poseidon2([value, secret, nullifier])`
- Nullifier hash: `nullifier_hash = Poseidon2([nullifier, 0])`
- Merkle inclusion proof (depth 20)
- Public inputs: `root`, `nullifier_hash`

**Compliance Circuit:**
- Poseidon2 preimage proof
- Public input: `hash` (registered on-chain)

Compile and test locally:
```bash
cd circuits/shielded_pool && nargo compile && nargo execute
bb write_vk --scheme ultra_honk --oracle_hash keccak --bytecode_path target/shielded_pool.json --output_path target --output_format bytes_and_fields
bb prove --scheme ultra_honk --oracle_hash keccak --bytecode_path target/shielded_pool.json --witness_path target/shielded_pool.gz --output_path target --output_format bytes_and_fields
bb verify -s ultra_honk --oracle_hash keccak -k target/vk -p target/proof -i target/public_inputs
```

**Critical**: the `--oracle_hash keccak` flag is required. The `ultrahonk_soroban_verifier` crate uses a Keccak-256 transcript (not Poseidon2). Without this flag, the VK/proof format is incompatible.

### Step 2: Soroban Contracts

Deploy contracts using `stellar-cli ^3.2.0`:

1. **Verifier Contract**: Deploy with VK from Step 1. Uses `ultrahonk_soroban_verifier` crate.
2. **Pool Contract**: Initialize with verifier address. Implements deposit (Merkle insertion) and withdraw (proof verification + nullifier tracking).
3. **Compliance Contract**: Separate verifier for compliance proofs.

Test with localnet (requires Docker, uses Protocol 26 `future` image):
```bash
just start        # Launch Stellar localnet with Protocol 26 + unlimited limits
just fund         # Generate and fund deployer account
just deploy       # Build circuits + contracts, deploy all three contracts
```

### Step 3: Deposit / Withdraw Flow

Implement the end-to-end flow, even if CLI-only:

- User deposits USDC → pool contract creates commitment, inserts into Merkle tree, emits `DepositEvent`
- User stores note locally: `{ commitment, nullifier, secret, value, leaf_index }`
- User generates proof with Noir/Barretenberg
- User submits proof → pool contract verifies via cross-contract call to verifier, marks nullifier spent, emits `WithdrawEvent`

### Step 4: Selective Disclosure Proof

Build one compliance proof circuit:

- User proves a property about their transaction history (e.g., "I completed KYC")
- Deploy separate verifier contract with compliance circuit VK
- Verifier can check the proof without seeing the underlying data

### Step 5: Frontend

Build the Next.js frontend last:

- Connect to Freighter wallet (via Stellar Wallets Kit)
- Deposit UI: amount input → generate commitment client-side → call pool.deposit()
- Withdraw UI: select note → generate proof in browser (WASM/Barretenberg) → call pool.withdraw()
- Compliance proof generation UI
- Local encrypted note storage (localStorage or OPFS)

---

## Key Risks

### Soroban ZK Host Functions Are New

Protocol 25 and 26 are recent additions. Documentation is sparse. Expect rough edges and budget time for debugging the verifier contract. The `soroban_poseidon` crate and BN254 host function interfaces may have undocumented quirks.

### Gas Limits

ZK proof verification is computationally expensive. The circuit and proof system must be efficient enough to verify within Soroban's gas limits. The tornado_classic reference verifies depth-20 Merkle proofs successfully, which validates this is feasible. Adding value-based commitments may increase circuit size — validate early.

### Client-Side Proving Performance

Generating ZK proofs in the browser via WASM can be slow for complex circuits. The circuit must be kept small enough for reasonable proving times (under 10 seconds ideally). Barretenberg `0.87.0` provides the WASM prover.

### Noir / UltraHonk Maturity on Stellar

While the rs-soroban-ultrahonk reference works end-to-end, the integration path may have undocumented issues. Noir `1.0.0-beta.9` is a beta release — expect API changes.

### Merkle Tree Size & Event Retention

On-chain Merkle tree management has storage costs. The frontier-based approach minimizes this (only stores `TREE_DEPTH` frontier nodes + root + next_index). However, Stellar RPC nodes only retain events for ~7 days, which limits historical replay for reconstructing the tree state on new clients.

### Commitment Scheme: Fixed vs Variable Denomination

The tornado reference uses fixed denominations; DShield uses variable amounts.
The cost is circuit complexity — the leaf commits to the value, and the spend
has to carry balance-preservation constraints and range checks. The trade is
worth making twice over:

- **One anonymity set.** Tiered pools split users into three smaller crowds and
  force every amount to be rounded to a tier. A single pool puts everyone in the
  same crowd.
- **Sound compliance proofs.** With no amount in the leaf, the compliance and
  disclosure circuits could not prove anything about a note's value — the
  `amount` witness was unconstrained, so the contract had to recover the figure
  out-of-band from the pool's denomination. Binding the value into the leaf makes
  those proofs real statements and removes that workaround entirely.

The countervailing risk is that a variable amount is itself an identifier: a
deposit of 137.42 followed by a withdrawal of 137.42 links itself regardless of
the cryptography. Partial withdrawals are the mitigation — the payout need not
match any deposit — which is why the change-note path exists rather than being a
convenience.

---

## Resources

### Core Documentation
- [ZK Proofs on Stellar](https://developers.stellar.org/docs/build/apps/zk)
- [Privacy on Stellar](https://developers.stellar.org/docs/build/apps/privacy)
- [Soroban SDK BN254](https://docs.rs/soroban-sdk/latest/soroban_sdk/_migrating/v25_bn254/index.html)
- [Soroban SDK Poseidon](https://docs.rs/soroban-sdk/latest/soroban_sdk/_migrating/v25_poseidon/index.html)

### Reference Implementations
- [rs-soroban-ultrahonk](https://github.com/yugocabrio/rs-soroban-ultrahonk) — UltraHonk verifier + tornado mixer + identity contract
- [Stellar Private Payments](https://github.com/NethermindEth/stellar-private-payments) — Nethermind privacy pool PoC (Circom/Groth16)
- [UltraHonk Soroban (indextree)](https://github.com/indextree/ultrahonk_soroban_contract) — Alternative UltraHonk verifier
- [Soroban P25 Examples](https://github.com/jayz22/soroban-examples/tree/p25-preview/p25-preview) — BN254 and Poseidon host function examples

### ZK Circuit Tooling
- [Noir Language](https://noir-lang.org/docs/)
- [Barretenberg (Aztec)](https://github.com/AztecProtocol/aztec-packages)
- [RISC Zero](https://dev.risczero.com/)

### Stellar Dev Tools
- [Stellar CLI](https://developers.stellar.org/docs/tools/cli)
- [Scaffold Stellar](https://scaffoldstellar.org)
- [Stellar Wallets Kit](https://stellarwalletskit.dev/)
- [Stellar Skills](https://skills.stellar.org/)
- [Stellar Dev Skill (AI)](https://github.com/stellar/stellar-dev-skill)
- [OpenZeppelin on Stellar](https://www.openzeppelin.com/networks/stellar)

### Protocol Specs
- [CAP-0074 (BN254)](https://github.com/stellar/stellar-protocol/blob/master/core/cap-0074.md)
- [CAP-0075 (Poseidon/Poseidon2)](https://github.com/stellar/stellar-protocol/blob/master/core/cap-0075.md)
- [CAP-0059 (BLS12-381)](https://github.com/stellar/stellar-protocol/blob/master/core/cap-0059.md)
- [Privacy Pools Whitepaper](https://privacypools.com/whitepaper.pdf)
