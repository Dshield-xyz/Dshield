# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Added CSV/JSON export of visible activity on the History page, for compliance and regulatory reporting
- Added local development environment documentation template to README.md
- Added frontend/.env.local.example configuration template
- Added root .gitignore rules for environment files and project-specific artifacts
- Added setup instructions to README.md
- Added `get_commitments_page(start, limit)` to the pool contract, a paginated, on-chain-capped alternative to the unbounded `get_commitments()` (#57)

### Changed

- Updated README.md with detailed build, run, and verification instructions
- Frontend Merkle tree reconstruction (withdraw + compliance report) now pages through `get_commitments_page` instead of calling the unbounded `get_commitments()` (#57)
