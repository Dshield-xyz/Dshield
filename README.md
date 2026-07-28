> ⚠️ **Plaintext localStorage — Notes stored unencrypted.** The current implementation stores bearer-spendable notes and KYC preimages as plaintext JSON in your browser's localStorage. **Any XSS vulnerability, malicious browser extension, or brief physical access to your device can allow someone to read and spend your notes.** Only use DShield on a personal, secure device. Never use it on shared or public computers. For production use, export and securely back up your notes. See [SECURITY.md](SECURITY.md#plaintext-localstorage-for-notes-and-kyc) for full details and longer-term roadmap (passphrase-derived encryption).

> ⚠️ **Rate limiter — single-instance only.** The API rate limiter (`frontend/src/lib/rateLimit.ts`) is in-memory and per-process: each server instance has its own counters, and they reset on every redeploy. This is fine for the current single-instance testnet setup, but provides no real protection in a multi-instance deployment (e.g. behind a load balancer). If you scale horizontally, replace it with a distributed limiter backed by a shared store such as [Upstash Redis](https://upstash.com/) or Vercel KV. See [SECURITY.md](SECURITY.md#rate-limiter--single-instance-only) for the full upgrade path.

> **Private by Default. Compliant by Choice.**

DShield is a consumer-grade shielded stablecoin wallet built on Stellar that enables private USDC payments using Zero-Knowledge Proofs (ZKPs).

Users can send and receive funds without publicly exposing transaction amounts, balances, or payment history while retaining the ability to selectively disclose information when required for compliance, auditing, or regulatory reporting.

Built for **Stellar Hacks: Real-World ZK**, DShield demonstrates how privacy and compliance can coexist in modern financial systems.