# DShield Glossary

Plain-English definitions of the cryptographic and blockchain terms used throughout this codebase.  
New to ZK? Start here. New to Stellar? The Soroban and Stellar entries below will orient you.

---

## Zero-Knowledge Cryptography Terms

### Commitment
A cryptographic "locked box" for a value. You commit to a value by hashing it with a secret; the hash is public, but the original value stays hidden. Anyone can later verify the committed value by recomputing the hash. In DShield, a deposit creates a commitment `H(nullifier, secret)` that proves you own funds without revealing who you are or how much you deposited.

### Nullifier
A one-way token derived from a note's secret that marks it as "spent." When you withdraw, you reveal the nullifier publicly; the contract checks it has not been seen before and records it. This prevents double-spending without ever revealing which deposit you are withdrawing. Think of it as a single-use ticket stub.

### Nullifier Hash
The on-chain public value derived from a nullifier: `H(nullifier, 0)`. Publishing only the hash (not the nullifier itself) ensures the spending event cannot be linked back to the original deposit.

### Merkle Tree
A binary hash tree where every leaf is a commitment and every parent node is the hash of its two children. The single value at the top — the **Merkle root** — summarises the entire set of leaves. Changing any leaf changes the root, making tampering immediately detectable.

### Merkle Root
The single 32-byte hash at the top of the Merkle tree. It is the "fingerprint" of all commitments in the pool at a given point in time. The pool contract stores recent roots on-chain; a withdrawal proof must reference a valid root to be accepted.

### Merkle Inclusion Proof (Merkle Path)
A compact proof that a specific leaf exists in a Merkle tree, consisting of the sibling hashes along the path from that leaf to the root. In DShield's circuits, this is the `path_siblings` and `path_bits` private inputs. Verifying it requires only O(depth) hashes rather than reading the whole tree.

### Zero-Knowledge Proof (ZKP)
A method that lets one party (the *prover*) convince another (the *verifier*) that a statement is true without revealing *why* it is true. DShield uses ZKPs to prove "I own a valid deposit" without exposing the depositor, amount, or receiving address.

### zkSNARK
Short for *Zero-Knowledge Succinct Non-interactive ARgument of Knowledge*. A family of ZK proof systems where proofs are small (succinct) and require no back-and-forth between prover and verifier (non-interactive). DShield uses the UltraHonk variant.

### UltraHonk
The specific zkSNARK proof system used by DShield. It is implemented by the [Barretenberg](https://github.com/AztecProtocol/aztec-packages) library and is the proof system compiled into the Soroban verifier contract. "Honk" refers to the underlying polynomial commitment scheme; "Ultra" refers to an optimised arithmetisation.

### Noir
A Rust-like domain-specific language for writing ZK circuits. DShield's proving logic (Merkle path verification, nullifier checks, recipient binding) is written in Noir and compiled to a format that Barretenberg can prove. Files live in `circuits/`.

### Barretenberg (`bb`)
Aztec's C++ proving library that compiles Noir circuits into proofs. The `bb` CLI tool generates verification keys (`bb write_vk`) and proofs (`bb prove`) used in tests and deployed contracts. In the browser, Barretenberg runs via WebAssembly.

### Verification Key (VK)
A public key, derived once from a circuit at compile time, that allows anyone to verify proofs for that circuit without knowing the secret inputs. DShield embeds VKs into the Soroban verifier contracts at deployment time.

### Poseidon2
A ZK-friendly hash function designed to be efficient inside arithmetic circuits. DShield uses Poseidon2 for all on-chain hashing (commitments, nullifier hashes, Merkle tree nodes) because it is orders of magnitude cheaper than SHA-256 in circuit constraints. Provided by the `soroban_poseidon` crate on-chain and `dep::poseidon::poseidon2` in Noir circuits.

### Keccak Transform (`--oracle_hash keccak`)
The hash function used inside the UltraHonk *transcript* (not the circuit's data hashing). When generating VKs and proofs with `bb`, the flag `--oracle_hash keccak` must be set to match the Soroban verifier crate's expectations. Mixing transcript hash functions produces incompatible proof/VK pairs.

### BN254 (alt-bn128)
An elliptic curve that is efficient for pairing-based ZK proofs. Stellar Protocol 25 (CAP-0074) added native BN254 operations as Soroban host functions; DShield's verifier uses these to check UltraHonk proofs on-chain affordably.

### Selective Disclosure
The ability for a user to prove a specific property (e.g. "my balance is ≥ $1,000", "I completed KYC") to a chosen party without revealing any other transaction data. DShield implements this with separate Noir circuits (`circuits/compliance/`, `circuits/disclosure/`) that produce proofs tied to an auditor key.

### Recipient Binding
A mechanism that binds a withdrawal proof to a specific recipient address. The circuit includes the recipient's address hash as a public input; the pool contract recomputes the hash from the actual payout address and rejects any mismatch. This prevents front-running attacks: a malicious relayer can delay or drop a withdrawal, but cannot redirect the funds.

### Note
The client-side record of a deposit, stored locally (encrypted): `{ commitment, nullifier, secret, value, leaf_index }`. Notes are never sent to the blockchain. Losing your note means losing the ability to withdraw your funds.

### Prover (Client-Side)
The code running in the user's browser (via WebAssembly) that generates a ZK proof from a note's private inputs. Sensitive data — nullifier, secret, Merkle path — never leaves the user's device. The proof is the only thing sent to the blockchain.

---

## Stellar / Soroban Terms

### Stellar
A public blockchain network optimised for payments and asset issuance. DShield's smart contracts are deployed to Stellar. Stellar's native currency is XLM, but DShield uses USDC via the Stellar Asset Contract (SAC) interface.

### Soroban
Stellar's smart-contract platform, written in Rust and compiled to WebAssembly. Soroban contracts run inside Stellar transactions. DShield's pool, verifier, and compliance contracts are all Soroban contracts.

### Relayer
A trusted-but-not-custodial third-party account that submits withdrawal transactions on a user's behalf. The user generates the ZK proof locally; the relayer pays the transaction fee and submits the proof. Because recipient binding is enforced by the contract, the relayer can never steal funds — it can only censor (refuse to relay). This keeps the withdrawer's account off-chain.

### Shielded Pool
A smart contract that holds deposited funds collectively. Deposits go in (creating commitments) and withdrawals come out (consuming nullifiers) with no on-chain link between the two. The "shield" is the ZK proof that proves membership without revealing identity.

### SAC (Stellar Asset Contract)
A Soroban contract that wraps a classic Stellar asset (like USDC) and exposes it with the standard token interface. DShield interacts with USDC through its SAC address.

### Freighter
A browser extension wallet for Stellar, similar to MetaMask on Ethereum. DShield's frontend uses Freighter (via the Stellar Wallets Kit) to sign deposit transactions.

---

## Further Reading

- [ZK Proofs on Stellar](https://developers.stellar.org/docs/build/apps/zk)
- [Noir Language Docs](https://noir-lang.org/docs/)
- [DESIGN.md](DESIGN.md) — full technical architecture of DShield
- [CAP-0074 (BN254)](https://github.com/stellar/stellar-protocol/blob/master/core/cap-0074.md)
- [CAP-0075 (Poseidon / Poseidon2)](https://github.com/stellar/stellar-protocol/blob/master/core/cap-0075.md)
