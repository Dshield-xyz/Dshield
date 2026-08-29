# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Added `contracts/governance`, a minimal timelock contract: privileged admin changes (pool `set_verifier`/admin rotation, compliance `propose_admin`/`set_disclosure_vk`) must now be queued, wait out a configured delay, and be executed — or be cancelled by the admin before executing (#142)
- Added `frontend/src/app/admin`, a Governance page showing queued/pending timelocked changes, their execution time, and execute/cancel actions (#142)
- Added `scripts/rotate-timelocked.sh` for queuing, waiting out the delay for, and executing a timelocked admin change via the Stellar CLI (#142)
- Added CSV/JSON export of visible activity on the History page, for compliance and regulatory reporting
- Added local development environment documentation template to README.md
- Added frontend/.env.local.example configuration template
- Added root .gitignore rules for environment files and project-specific artifacts
- Added setup instructions to README.md
- Added `get_commitments_page(start, limit)` to the pool contract, a paginated, on-chain-capped alternative to the unbounded `get_commitments()` (#57)

### Changed

- Pool `set_verifier` and compliance `set_disclosure_vk` now require the configured timelock contract as caller instead of the direct admin; both contracts' constructors take a new `timelock: Address` parameter (#142)
- Pool gained `propose_admin`/`accept_admin` (mirroring compliance's existing two-step rotation), gated behind the timelock the same way (#142)
- Updated README.md with detailed build, run, and verification instructions
- Frontend Merkle tree reconstruction (withdraw + compliance report) now pages through `get_commitments_page` instead of calling the unbounded `get_commitments()` (#57)
