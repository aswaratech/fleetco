# Orchestration loop — operator guide

This is the daily reference for running the orchestration loop. The full design is at [orchestration-loop-design.md](orchestration-loop-design.md); the adoption decision is at [ADR-0022](../architecture/decisions/0022-orchestration-loop.md). The loop's source lives at [scripts/orchestration/](../../scripts/orchestration/).

## One-time setup (do this once before the first program)

1. **Manually complete the two prerequisite PRs.** The loop refuses to operate without CI on main. These two cannot be loop-driven:
   - **Bootstrap PR**: root `package.json`, `pnpm-workspace.yaml`, `.tool-versions`, minimal `apps/api/package.json` and `apps/web/package.json`. Open, review, merge.
   - **CI baseline PR**: `.github/workflows/ci.yml` (lint + type-check + vitest placeholder), `.github/workflows/security.yml` (Semgrep + Dependabot + action SHA pinning + CycloneDX SBOM per ADR-0012), `.github/dependabot.yml`. The workflows run on the PR itself (branch-defined workflows always do); verify green; merge.

2. **Set up the Slack bot.** Five minutes at api.slack.com/apps:
   - Create app; enable Socket Mode.
   - Add bot scopes: `chat:write`, `commands`, `app_mentions:read`.
   - Register slash commands: `/status`, `/tail`, `/stop`, `/resume`, `/queue`.
   - Install to workspace; capture `SLACK_BOT_TOKEN` (xoxb-) and `SLACK_APP_TOKEN` (xapp-).
   - Add Incoming Webhook to the chosen channel (e.g., `#fleetco-loop`); capture `SLACK_WEBHOOK_URL`.
   - Invite the bot to the channel.

3. **Configure local env.** From repo root:
   ```sh
   cd scripts/orchestration
   pnpm install
   cp .env.example .env
   # Edit .env: paste the three Slack tokens. Leave model env vars at defaults.
   ```

4. **Verify with a dry run.** Without any kickoff.md:
   ```sh
   pnpm start
   ```
   The loop should print "kickoff.md not found at .../scripts/orchestration/kickoff.md. Write the first kickoff prompt (see kickoff.md.template) before starting." and exit 1. If it does, your install and config are working.

## Per-program setup

1. **Write the first kickoff prompt.** Copy the template:
   ```sh
   cp scripts/orchestration/kickoff.md.template scripts/orchestration/kickoff.md
   ```
   Edit `scripts/orchestration/kickoff.md`. Fill in:
   - **Program** (one sentence naming the multi-ticket program).
   - **Ticket** (the specific work for iteration 1; the agent's `## Next-session prompt` block at end-of-session becomes ticket 2, and so on).

   Leave the **Discipline**, **Required output**, and **Critical: no fabricated operator confirmations** sections intact — they are load-bearing.

2. **Remove any stale `.stop` sentinel.**
   ```sh
   rm -f scripts/orchestration/.stop
   ```

3. **Launch.**
   ```sh
   cd scripts/orchestration && pnpm start
   ```
   Watch the first two iterations' notifications to confirm the loop is healthy. After that, walk away. The loop notifies on every milestone.

## What notifications mean and what to do

| Notification | What it means | Operator action |
|---|---|---|
| `iteration_start` | A new iter has begun on a specific ticket. | None. |
| `agent_invocation_start` | The SDK `query()` call is starting. | None. |
| `auto_answer` | The agent fired `AskUserQuestion`; the loop auto-answered. | None unless the picks seem wrong; inspect `decisions.log` if curious. |
| `destructive_bash_denied` | The agent tried to run a blocked command. | None usually; inspect if the agent is repeatedly trying the same blocked command (signals a kickoff prompt issue). |
| `rate_limit_wait` | Rate limit hit; loop is sleeping until the named time. | None. The loop will resume automatically. |
| `rate_limit_resume` | Sleep complete; loop is re-firing the iteration. | None. |
| `rate_limit_cap_hit` | 4th rate-limit hit in one iter; loop has halted. | Inspect; wait longer; restart the loop manually when the cap is clearly cleared. |
| `agent_session_end` | The agent finished its turn. | None. |
| `pr_opened` | The loop detected a PR was opened (with the PR number). | None. |
| `no_pr_detected` | Agent ended its session without opening a PR; loop halted. | Inspect `logs/<latest>.log`. Either the agent halted intentionally (e.g., on an operator-only escalation) or it confused itself. If intentional, address the escalation and write the next kickoff manually. If confused, rewrite kickoff.md to be clearer and restart. |
| `ci_poll_start` | Loop is polling CI on the new PR. Periodically re-fired during long polls so you know the loop is alive. | None. |
| `ci_green` | All CI checks passed. About to merge. | None. |
| `ci_failed` | A CI check failed; loop halted (NO auto-fix per principle 10). | Open the PR; inspect the failing check; fix manually; either re-trigger CI and use `gh pr merge` yourself, or close the PR and let the operator restart the loop with a fresh kickoff. |
| `ci_no_workflows` | No `.yml` files in `.github/workflows/` on main. | This means the prerequisite CI bootstrap PR hasn't merged. Complete it manually, then restart the loop. |
| `ci_timeout` | CI exceeded 45 minutes; loop halted. | Inspect the PR's checks. Either CI is genuinely stuck (re-run or fix and merge manually) or 45min wasn't enough (tune `ORCHESTRATION_CI_POLL_TIMEOUT_MIN` in `.env`). |
| `pr_merged` | PR merged successfully. About to extract the next prompt. | None. |
| `next_prompt_extracted` | The next iteration's kickoff is written to `kickoff.md`. | None. |
| `next_prompt_missing` | All three extractor tiers returned NONE; loop halted. | Inspect `logs/<latest>.log` to see the agent's actual output. Either the agent forgot to include a next-session prompt (write the next kickoff manually and restart) or the output format drifted in a new way (note it as a tech-debt entry to improve the extractor). |
| `fabricated_preamble_stripped` | The loop's guard fired; one or more operator-confirmation preambles were removed from the agent's next prompt. | Inspect the notification's stripped-content sample. If the agent fabricated something significant, `/stop` and inspect carefully before restarting. Repeated strips (>3 per program) signal adversarial drift and need investigation. |
| `stop_sentinel_detected` | `.stop` file present at the iteration boundary; loop halted cleanly. | Inspect state; either restart with a new kickoff or leave the loop stopped. |
| `program_complete` | The agent signaled `STOP — program complete` in its next-prompt block; loop halted cleanly. | The program is done. Start the next program by overwriting kickoff.md and launching the loop again. |
| `loop_halted` | Loop ended for some reason described in the notification. | Read the reason; act accordingly. |
| `loop_error` | Unhandled exception in the loop itself. | This is a loop bug or environment issue. Inspect stderr / the per-iter log; file a tech-debt entry; fix and restart. |

## Slash commands (from Slack)

- `/status` — current iter count, last PR number, last iter start time, rate-limit retry count, `.stop` sentinel state, last 5 decisions.
- `/tail` — last 30 lines of `decisions.log`.
- `/stop` — touches `.stop`; the loop halts cleanly at the next iter boundary. (You can also `touch scripts/orchestration/.stop` from a terminal.)
- `/resume` — deletes `.stop`. You still need to `pnpm start` to relaunch.
- `/queue` — prints current `kickoff.md` content.
- **Anything else / app mention** — routed to Haiku with the last 50 decisions as context. Useful for "why did iter 3 halt?" or "what was the last PR number?" without needing to open a terminal.

## Halt scenarios and how to handle each

The loop only halts cleanly on conditions that require operator judgment. Each scenario has a clear notification and a clear action.

**CI failed.** Open the PR; inspect the failing check. The loop does NOT auto-fix because the agent's "fix" can break something else ad infinitum. Either fix manually and `gh pr merge` yourself (the loop is already halted; manual merge is fine for this one PR), or close the PR and write a corrective kickoff.md and relaunch.

**No PR detected.** The agent ended its session without `gh pr create` succeeding. Look at `logs/<latest>.log`. Common causes: the agent intentionally halted on an operator-only escalation (you address it and write the next kickoff manually), or the agent got confused (rewrite kickoff.md and restart).

**No next prompt extracted.** Three extractor tiers all returned NONE. Either the agent forgot to draft a next prompt (rare; usually means the program is informally done — start a new program), or the agent's output format drifted in a new way none of the tiers handles (file as tech-debt; improve the extractor).

**Fabricated preamble stripped.** The guard fired. Look at the notification's stripped-content sample. If the stripped block was harmless ("Operator confirmed scope" when it was actually true), no action — the cleaned prompt continues. If the stripped block claimed a discipline gate was satisfied when it wasn't, `/stop` and inspect. If the agent is repeatedly fabricating (>3 strips/program), pause the loop and reset by running sessions with the operator present until the agent's discipline is re-established.

**Rate-limit cap hit.** Four rate-limit hits in one iter; loop halted. Either the limit is genuinely stuck (wait longer than the loop wanted to and restart), or your subscription tier was exceeded and you need to upgrade or wait until the next billing cycle.

**`.stop` triggered.** You either triggered it via `/stop` or `touch .stop`, or someone else did. Inspect; delete the sentinel; restart with `pnpm start` when ready.

**Program complete.** The agent signaled `STOP — program complete`. The program is done. Start the next program by writing a new kickoff and launching the loop again.

## Resuming after a halt

```sh
# 1. Inspect the situation.
tail -50 scripts/orchestration/decisions.log
tail -200 scripts/orchestration/logs/<latest>.log

# 2. If kickoff.md needs a rewrite (e.g., to clarify the next ticket
#    after a no-PR halt), edit it.
$EDITOR scripts/orchestration/kickoff.md

# 3. Remove the stop sentinel if present.
rm -f scripts/orchestration/.stop

# 4. Relaunch.
cd scripts/orchestration && pnpm start
```

The loop loads its iteration counter from `state.json`, so the next iter number continues from where it left off; it does not reset to iter 1.

## Cleaning up after a program

After `program_complete` (or a deliberate `/stop` ending a program):

```sh
# Optional: archive the logs (handy for postmortems and DORA accounting).
mv scripts/orchestration/logs scripts/orchestration/logs.program-<name>.$(date +%Y%m%d)
mkdir scripts/orchestration/logs

# Optional: archive decisions.log.
mv scripts/orchestration/decisions.log scripts/orchestration/decisions.program-<name>.log

# Reset state for the next program.
rm scripts/orchestration/state.json
rm -f scripts/orchestration/.stop

# Overwrite kickoff.md for the next program.
$EDITOR scripts/orchestration/kickoff.md
```

When you're ready, `pnpm start` again for the next program.

## Quick reference

| Action | Command / Path |
|--------|----------------|
| Start the loop | `cd scripts/orchestration && pnpm start` |
| Watch the loop (TUI) | `cd scripts/orchestration && pnpm tui` — read-only live dashboard; `q` quits, `r` refreshes. Safe to run against a live loop. |
| Stop cleanly | `/stop` in Slack, OR `touch scripts/orchestration/.stop` |
| Resume after stop | `/resume` (or `rm scripts/orchestration/.stop`), then `pnpm start` |
| Inspect state | `cat scripts/orchestration/state.json` |
| Tail decisions | `tail -f scripts/orchestration/decisions.log` |
| Tail current iter | `tail -f scripts/orchestration/logs/<latest>.log` |
| Run smoke tests | `cd scripts/orchestration && pnpm test` |
| Typecheck | `cd scripts/orchestration && pnpm typecheck` |
| Slack channel | `#fleetco-loop` (or whatever you chose) |
| Slack commands | `/status`, `/tail`, `/stop`, `/resume`, `/queue` |
| First-kickoff path | `scripts/orchestration/kickoff.md` |
| Template path | `scripts/orchestration/kickoff.md.template` |
| Kill-switch path | `scripts/orchestration/.stop` |
| Local env file | `scripts/orchestration/.env` |
