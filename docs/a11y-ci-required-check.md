# Accessibility CI Required Check

The `frontend-a11y` job in `.github/workflows/ci.yml` runs axe-core accessibility tests
against every top-level page (deposit, withdraw, history, compliance) and the shared
`ui/` component library.

## Making it a required status check

To prevent accessibility regressions from reaching `main`, the `frontend-a11y` job
must be marked as a **required status check** in GitHub branch protection:

1. Go to **Settings → Branches** → **Branch protection rules** → edit the rule for `main`.
2. Under **Require status checks to pass before merging**, search for **"Frontend A11y"**
   (this is the job's `name:` value in `ci.yml`).
3. Select it so it appears in the required checks list.
4. Save.

Once enabled, PRs whose `frontend-a11y` job fails (or is skipped) cannot be merged
into `main`.

## What the job covers

| Page / Component      | Test exists |
|-----------------------|:-----------:|
| Deposit page          | ✅          |
| Withdraw page         | ✅          |
| History page          | ✅          |
| Compliance page       | ✅          |
| Button (all variants) | ✅          |
| Badge (all tones)     | ✅          |
| Card (all variants)   | ✅          |
| Input (label + hint)  | ✅          |
| Spinner               | ✅          |
| StatusMessage (3 tones) | ✅        |

## Adding new pages/components

When adding a new page or UI component, add a corresponding axe-core test in
`frontend/src/app/a11y.spec.tsx` so the `frontend-a11y` CI job catches regressions
automatically.