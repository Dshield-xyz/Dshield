# Circuit Formal Specs

This directory contains executable specifications for the Noir circuits.

- `specs/*.json` declares the ABI and symbolic properties each compiled
  artifact must satisfy.
- `scripts/verify-circuits.mjs` loads those specs, verifies compiled Nargo
  artifacts, and runs the mutation self-test used by CI.

Add new properties by extending the relevant spec with a named check and adding
the corresponding checker implementation to the script. Keep each check tied to
one security invariant so failures remain easy to review.
