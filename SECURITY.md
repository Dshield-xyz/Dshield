# Security Policy

DShield is currently **unaudited testnet software**. It handles a shielded
pool of funds (currently testnet USDC), so security issues are taken
seriously even at this stage — please report them responsibly rather than
opening a public issue.

## Known Limitations

### Plaintext localStorage for Notes and KYC

**⚠️ CRITICAL: Notes and KYC data are stored unencrypted in browser localStorage**

The current implementation stores bearer-spendable notes and KYC preimages
as plaintext JSON in your browser's localStorage. This means:

- **Any XSS vulnerability** in the DShield app or a compromised dependency
  can read your notes and spend them
- **Malicious browser extensions** with localStorage access can steal your
  notes
- **Physical device access** — anyone with brief access to your device (even
  locked but with the browser still running, depending on OS security) can
  open DevTools and read your notes
- **Shared/public computers** — never use DShield on a library computer,
  internet café, or any shared device

**Each note is equivalent to cash.** If someone obtains your note string,
they can withdraw those funds to their own address. There is no way to
revoke or recover a stolen note.

**Mitigation:**

- Only use DShield on a **personal, secure device** with full-disk encryption
- Keep your browser and OS up to date
- Be cautious about which browser extensions you install
- For production use, export your notes (copy the note string from the UI)
  and store them in a password manager or encrypted backup
- Consider the **Longer-term roadmap** below for passphrase-based encryption

**Longer-term roadmap:** A future version may add optional
passphrase-derived encryption for the note store (similar to MetaMask's
approach), where notes are encrypted with a key derived from a user
passphrase and only decrypted in memory when needed. This would protect
against casual device access and malicious extensions (though not against
XSS while the wallet is unlocked). Until then, treat your device's security
as the only protection for your notes.

**Cross-tab write protection:** As of this update, concurrent writes
from multiple tabs/windows no longer silently clobber each other — an
advisory lock serializes updates. However, this does not address the
plaintext storage issue.

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
