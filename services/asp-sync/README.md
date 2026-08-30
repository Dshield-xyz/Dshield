# DShield ASP root synchronizer

This package rotates the compliance contract's ASP root from the official [OFAC Sanctions List Service](https://ofac.treasury.gov/sanctions-list-service). The scheduled workflow runs daily at 03:17 UTC. OFAC publishes the SDN list and provides its enhanced XML export through the [Sanctions List Service](https://sanctionslist.ofac.treas.gov/Home/SdnList).

## Transformation

The job reads `SDN_ENHANCED.XML`, selects every `ID` or `ID_Number` element whose `ID_Type` contains `digital`, `crypto`, or `virtual`, trims the text, case-folds it, rejects whitespace-containing or overlong values, removes duplicates, and sorts the resulting UTF-8 strings lexicographically. It hashes each canonical address with SHA-256. Each tree level hashes `SHA256(left_digest || right_digest)`; an odd final node is duplicated before pairing. The single remaining 32-byte digest is the root passed to `rotate_asp_root` as lowercase hexadecimal.

The transformation is deliberately independent of XML order, entity metadata, and non-address identifiers. It must be kept byte-for-byte compatible with the ASP membership verifier. An empty address set, malformed XML, oversized response, invalid address, network failure, or root mismatch aborts before any transaction is constructed or submitted.

## Configuration

| Variable | Required | Meaning |
| --- | --- | --- |
| `COMPLIANCE_CONTRACT_ID` | Yes | Deployed Soroban compliance contract ID. |
| `STELLAR_SOURCE` | No | CLI identity name; defaults to `asp-sync`. |
| `STELLAR_NETWORK` | No | Stellar CLI network; defaults to `testnet`. |
| `ASP_FEED_URL` | No | Override for fixture or mirror testing; defaults to the OFAC enhanced SDN XML endpoint. |
| `EXPECTED_ASP_ROOT` | No | Optional hex pin used to detect unexpected feed transformations. |
| `DRY_RUN` | No | Set to `true` to print the root without submitting. |

The workflow provisions `STELLAR_SOURCE` from the repository secret `STELLAR_ADMIN_SECRET`. The signer is the compliance contract administrator. Routine updates require no manual admin transaction, but changing the signer or contract ID remains an infrastructure change subject to review.

## Local usage

```sh
cd services/asp-sync
ASP_FEED_URL=/path/to/SDN_ENHANCED.XML DRY_RUN=true PYTHONPATH=. python3 -m asp_sync.sync
```

The contract emits `asp_root_rotated` with the committed root and signer. The workflow requires the CLI invocation to succeed; a failed submission causes the scheduled run to fail and does not represent a successful rotation.
