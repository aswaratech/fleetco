# scripts/orchestration

Autonomous multi-ticket orchestration loop for FleetCo. Operator tooling, not application code.

This is the entry point for the loop. The canonical design lives at [docs/runbook/orchestration-loop-design.md](../../docs/runbook/orchestration-loop-design.md). The daily-operator reference lives at [docs/runbook/orchestration-loop-operator-guide.md](../../docs/runbook/orchestration-loop-operator-guide.md). The adoption decision lives at [docs/architecture/decisions/0018-orchestration-loop.md](../../docs/architecture/decisions/0018-orchestration-loop.md).

## Quick reference

```sh
cd scripts/orchestration
pnpm install                # one-time
cp .env.example .env        # one-time; fill in Slack tokens
# Write your first kickoff prompt to kickoff.md
pnpm start                  # launch the loop
```

| Action | Command / Path |
|--------|----------------|
| Stop cleanly | `/stop` in Slack OR `touch .stop` |
| Resume after stop | Delete `.stop` (or `/resume` in Slack), `pnpm start` |
| Inspect state | `cat state.json` |
| Tail decisions | `tail -f decisions.log` |
| Tail current iter | `tail -f logs/<latest>.log` |

## Why this exists

See ADR-0018 and the design document above. Short version: the operator wants hands-off multi-ticket execution between PR merges, with the loop honoring all discipline gates from CLAUDE.md and the ADRs and notifying via Slack on every milestone.

## What this does NOT do

Per ADR-0018 and the design's principle 10: no CI auto-fix retry, no discipline-gate waiver, no auto-resume after wall-clock windows, no GUI, no multi-program orchestration, no cost monitoring, no automated rollback. Logs + Slack are the entire interface.
