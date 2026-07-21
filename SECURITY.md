# Security Policy

DShield is currently **unaudited testnet software**. It handles a shielded
pool of funds (currently testnet USDC), so security issues are taken
seriously even at this stage — please report them responsibly rather than
opening a public issue.

## Scope

Anything that could let someone:

- Forge a valid deposit/withdrawal/compliance/disclosure proof for a false
  statement
- Break Poseidon2 / Merkle root consistency between the frontend, circuits,
  and the on-chain contract (see [Security Model](README.md#security-model)
  in the README)
- Bypass recipient binding and redirect a withdrawal
- Replay a nullifier / double-spend
- Steal or freeze funds via the relayer, pool, verifier, or compliance
  contracts
- Leak information a proof is supposed to keep private (sender, receiver,
  amount, KYC status) beyond what's intentionally disclosed

is in scope, across `contracts/`, `circuits/`, and the parts of `frontend/`
that build proofs, notes, or transactions.

Out of scope: issues that only affect local dev tooling, the demo scripts,
or purely cosmetic frontend bugs with no security impact — file those as
normal GitHub issues instead.

## Reporting a Vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Instead, email **a.emmanuelcaxton@gmail.com** with:

- A description of the issue and its potential impact
- Steps to reproduce (a failing test or PoC script is ideal, given this is a
  testnet project — see `just demo` / `tests/e2e.sh` for the kind of
  end-to-end repro that's most useful)
- Any suggested fix, if you have one

You should get an acknowledgment within a few days. Once a fix is ready and
released, we'll credit reporters (unless you'd prefer to stay anonymous) in
the fix's changelog or commit message.

## Disclosure

Given the project is a hackathon-stage, unaudited testnet demo, we don't yet
have a bug bounty program. Please still give us a reasonable window to land
a fix before any public disclosure.
