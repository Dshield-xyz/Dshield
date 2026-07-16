# DShield Glossary

A short glossary of Zero-Knowledge and Stellar terms used in the DShield project to help newcomers understand the technology.

## Nullifier
A cryptographic derivative of a note that, when revealed on-chain, proves the note has been spent without revealing the note itself. Prevents double-spending in shielded pools.

## Commitment
A cryptographic hash that represents ownership of a note (e.g., Poseidon2 hash of value, secret, and nullifier). Commitments are inserted into a Merkle tree to prove inclusion without revealing the note's contents.

## Merkle Root
The hash at the top of a Merkle tree that succinctly represents all leaves (commitments) below. In DShield, the on-chain Merkle root allows proof of inclusion for a commitment while keeping other commitments private.

## Merkle Tree
A binary tree where each leaf is a hash of a note commitment and each internal node is the hash of its children. DShield uses an incremental frontier-based Merkle tree of depth 20 to track deposits efficiently on-chain.

## Recipient Binding
A security property that ties a withdrawal proof to a specific recipient address. The proof commits to a hash of the recipient address, and the contract verifies that hash matches the intended recipient, preventing front‑running attacks.

## UltraHonk
A proving system (based on PLONK) that enables efficient verification of zkSNARKs on Stellar Soroban via BN254 pairing checks. DShield uses UltraHonk for proof generation (client‑side) and verification (on‑chain verifier contract).

## Poseidon2
A cryptographic hash function designed for efficient computation inside zkSNARK circuits. DShield uses Poseidon2 for commitments, nullifier hashes, and Merkle tree hashing both in circuits and on Soroban via host functions.

## Selective Disclosure
The ability to prove a statement (e.g., “I received at least 1000 USDC”) without revealing the underlying data (e.g., individual transaction amounts). DShield implements this via separate Noir circuits and verifier contracts.

## Relayer
An off‑chain entity that submits withdrawal proofs on behalf of users, paying the transaction fee so the user’s Stellar address never appears on‑chain. The relayer cannot steal funds because it cannot produce a valid proof without the user’s secret data.

## Commitment Scheme
A cryptographic primitive that allows one to commit to a value while keeping it hidden, later revealing the value to prove the commitment was correct. In DShield, the commitment hides the note contents (value, secret, nullifier).

## Zero‑Knowledge Proof (ZKP)
A method by which one party (the prover) can prove to another (the verifier) that a statement is true without revealing any information beyond the validity of the statement itself. DShield uses zkSNARKs (via UltraHonk) for shielded transfers and selective disclosure.

## zkSNARK
Zero‑Knowledge Succinct Non‑Interactive Argument of Knowledge, a type of ZKP that is short and fast to verify. DShield’s proof system is an UltraHonk variant of PLONK, which falls under the zkSNARK family.

## Noir
A domain‑specific language for writing zkSNARK circuits. DShield writes its circuits (shielded pool, compliance, disclosure) in Noir and compiles them with Barretenberg.

## Soroban
Stellar’s smart contract platform. DShield’s contracts (pool, verifier, compliance) are written in Rust and deployed to Soroban.

## BN254
An elliptic curve and pairing‑friendly field used by Stellar’s ZK primitives (Protocol 25/26). DShield’s verification relies on BN254 pairing checks via the Soroban SDK.

## Poseidon Hash
The original Poseidon hash function (sometimes distinguished from Poseidon2). DShield’s documentation may refer to Poseidon when discussing the hash family; the concrete instantiation used is Poseidon2.

## Compliance Proof
A zero‑knowledge proof that proves regulatory compliance (e.g., KYC completed, jurisdiction approved) without revealing the underlying personal data. Implemented via a simple preimage‑hash circuit in Noir.