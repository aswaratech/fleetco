# Iteration 3 — Add ESLint and Prettier

I opened PR #14 with the tooling setup. The eslint config extends @typescript-eslint/recommended-type-checked, and Prettier is wired through eslint-config-prettier so they don't fight each other.

Key files touched:
- .eslintrc.cjs (root config)
- .prettierrc (formatting rules)
- apps/api/.eslintrc.cjs (extends root, adds NestJS-specific rules)
- apps/web/.eslintrc.cjs (extends root, adds Next-specific rules)

CI now runs `pnpm lint` and `pnpm format:check` as required checks per ADR-0012.

## Next-session prompt

```markdown
## Program

Finish Phase 0 of FleetCo bootstrap and ship the Vehicles vertical slice.

## Discipline

Honor all rules in /CLAUDE.md and every ADR in /docs/architecture/decisions/.

## Ticket

Add Husky and lint-staged for pre-commit hooks. Wire `pnpm lint` and `pnpm format:check` to run on staged files only. Update docs/runbook/dev-setup.md to document the new pre-commit hook.

## Required output

Open a PR. Draft the next-session prompt in a fenced block under a `## Next-session prompt` heading.
```

That's all from this iteration. See you in the next one.
