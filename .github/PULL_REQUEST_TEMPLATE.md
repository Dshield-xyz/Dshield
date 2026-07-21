<!-- This PR should target the `dev` branch, not `main`. -->

## Summary

<!-- What does this change do, and why? -->

## Area

<!-- circuits / contracts / frontend / demo scripts / CI -->

## Testing

<!-- What did you run? e.g. `just test`, `just test-e2e`, `nargo execute` + proof round-trip for circuit changes -->

- [ ] `just test` passes (contracts + frontend)
- [ ] `just test-e2e` passes, if this touches deposit/withdraw/compliance flows
- [ ] If a circuit changed: recompiled and regenerated the checked-in `frontend/**/circuits/*.json` artifacts
- [ ] `pnpm lint` / `pnpm build` pass, if this touches `frontend/`

## Breaking changes

<!-- None / describe -->
