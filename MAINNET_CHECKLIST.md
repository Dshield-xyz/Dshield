# Mainnet Deployment Checklist

This checklist enumerates the steps that must be completed before deploying DShield to a mainnet network.

---

## Core Pre-Deployment Steps

- [ ] **Full security audit** — complete independent security audit of all contracts, circuits, and relayer code
- [ ] **Secret rotation** — generate and secure new keys for relayer, faucet, and admin accounts (do not reuse dev/testnet secrets)
- [ ] **Relayer fee model** — implement a fee mechanism for relayer operations to cover gas costs
- [ ] **Rate-limiter upgrade** — enhance rate limiting to prevent abuse on mainnet
- [ ] **Circuit audit** — independent audit of all Noir circuits (shielded pool, compliance, disclosure)
- [ ] **Contract audit** — independent audit of all Soroban smart contracts
- [ ] **Frontend security review** — security review of the frontend application
- [ ] **Multi-sig admin** — implement multi-signature for contract admin operations
- [ ] **Emergency pause** — implement emergency pause functionality for contracts
- [ ] **Monitoring & alerting** — set up monitoring and alerting for contract activity and relayer health
- [ ] **Disaster recovery plan** — document disaster recovery procedures
- [ ] **Legal review** — complete legal review of the system and terms of service
