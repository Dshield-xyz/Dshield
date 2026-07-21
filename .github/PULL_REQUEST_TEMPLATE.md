<!-- Open this PR against the `dev` branch, not `main`. All active development merges into `dev`. -->

## Summary

<!-- What does this change do? Keep it concise — one or two sentences. -->

## Why

<!-- Why is this change needed? Link the motivation, design decision, or user-facing problem being solved.
     CONTRIBUTING.md asks: "describe *why* the change is needed, not just what changed." -->

## Testing done

<!-- What did you run to verify this change? -->

- [ ] `just test` passes (contracts + frontend)
- [ ] `just test-e2e` passes, if this touches deposit/withdraw/compliance flows
- [ ] If a circuit changed: recompiled and regenerated the checked-in `frontend/**/circuits/*.json` artifacts
- [ ] `pnpm lint` / `pnpm build` pass, if this touches `frontend/`

## Screenshot / recording (required)

<!-- Attach a screenshot or short screen recording showing the change working.
     This is **required** before this PR can be merged. -->

## Related issue

<!-- Link the issue this PR closes, e.g. "Closes #41" -->

Closes #
