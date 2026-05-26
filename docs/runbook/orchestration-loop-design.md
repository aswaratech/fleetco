# Orchestration loop — design

This document is the canonical design record for the autonomous orchestration loop that drives multi-ticket programs in FleetCo. It is paired with [ADR-0022](../architecture/decisions/0022-orchestration-loop.md), which records the adoption decision and the trade-offs the project accepts, and with [orchestration-loop-operator-guide.md](orchestration-loop-operator-guide.md), which is the daily reference the operator reads when running the loop.

The loop's source lives at [scripts/orchestration/](../../scripts/orchestration/). Built and smoke-tested on 2026-05-17; 113 unit tests covering the deterministic pieces of the design (extractor, fabricated-preamble guard, PR detection, destructive-Bash blocklist, auto-answer rules, rate-limit recovery).

## What the loop is and is not

The loop drives a **multi-ticket program** with hands-off execution between PR merges. The operator queues a kickoff prompt for the first ticket at `scripts/orchestration/kickoff.md`. Each agent session opens a PR and drafts the next session's kickoff prompt at the end of its output. The loop polls CI, auto-merges on green, extracts the next prompt, strips fabricated operator-confirmation preambles, recovers from rate limits, blocks destructive Bash commands at the permission shim, auto-answers mid-session `AskUserQuestion` calls via denial-as-answer, and notifies the operator on every milestone via Slack. The operator walks away. Notifications keep them informed. A kill-switch file (`.stop`) or the Slack `/stop` slash command halts the loop cleanly at the next iteration boundary.

The loop is **not** a chatbot, **not** a CI/CD pipeline, and **not** a build tool. It is a meta-process: the agent does one ticket at a time inside its session under the project's normal discipline (CLAUDE.md, the ADRs, the runbook); the loop's work happens between sessions and is mechanical.

The pattern **fits** when work decomposes into discrete tickets with one PR per ticket, each ticket completes within roughly one session window, the next ticket's scope is typically obvious from the current ticket's output, and the operator accepts auto-merge after CI passes. FleetCo meets these conditions for vertical-slice work per ADR-0006 and for the immediate Phase 0 finish + Vehicles slice program (~12–16 tickets). The pattern **does not fit** for tickets that need cross-PR coordination, every-PR security-sensitive review, or ill-defined work.

## Language, layout, location

Language: **TypeScript**. Matches the project stack (ADR-0005); avoids introducing Python tooling which CLAUDE.md prohibits without an ADR. SDK: `@anthropic-ai/claude-agent-sdk` (TypeScript bindings).

Location: **`scripts/orchestration/`** at the repo root. Operator tooling, not application code consumed by `apps/`. Standalone: its own `package.json`, its own `tsconfig.json`, its own `node_modules/`. Not a member of the future pnpm workspace because it must function BEFORE the workspace exists (the workspace is one of the first tickets the loop will drive after the operator's prerequisite manual PRs).

File layout:

```
scripts/orchestration/
├── README.md                    Pointer to this design + the operator guide
├── package.json                 Standalone deps
├── tsconfig.json                Strict TS config
├── .env.example                 Templates for Slack tokens + tuning
├── .gitignore                   state.json, logs/, decisions.log, .stop, .env
├── kickoff.md.template          Starter the operator copies to kickoff.md
├── kickoff.md                   (gitignored runtime: current iteration's prompt)
├── src/
│   ├── index.ts                 Main loop state machine
│   ├── config.ts                Env validation via zod + paths + limits
│   ├── state.ts                 JSON state file IO
│   ├── permission-shim.ts       canUseTool callback (destructive Bash + auto-answer)
│   ├── destructive-bash.ts      Regex blocklist tuned to FleetCo's stack
│   ├── auto-answer.ts           Recommended-marker + Haiku fallback rules
│   ├── extract-next-prompt.ts   Three-tier extractor
│   ├── strip-fabricated.ts      Operator-confirmation preamble guard
│   ├── pr-detection.ts          last-bash-was-gh-pr-create + branch fallback
│   ├── ci-poll.ts               gh pr checks polling with timeout + no-CI guard
│   ├── auto-merge.ts            gh pr merge --merge --delete-branch
│   ├── rate-limit-recovery.ts   rate_limit_event + thrown-exception parsers
│   ├── slack-notify.ts          Outbound webhook
│   ├── slack-bot.ts             Inbound Socket Mode + slash commands
│   ├── logging.ts               decisions.log appender + per-iter log streams
│   ├── halt.ts                  Clean shutdown
│   └── types.ts                 Shared type defs
└── tests/
    ├── *.test.ts                113 vitest unit tests
    └── fixtures/                Sample transcripts for extractor tests
```

Runtime files (all gitignored): `state.json`, `decisions.log`, `logs/<timestamp>-iter<N>-<slug>.log`, `.stop`, `.env`.

Run command: `cd scripts/orchestration && pnpm install` (one-time), then `pnpm start`. `pnpm dev` enables verbose tracing. `pnpm test` runs the 113 unit tests. `pnpm typecheck` runs `tsc --noEmit`.

## State machine

Per iteration, the loop walks the following states. Refusal to merge without CI is the load-bearing safety gate; all other refusals (no PR, no next prompt, fabricated preamble beyond confidence, rate-limit cap, .stop sentinel) halt cleanly with explicit Slack notification.

1. **Startup** — refuse to start if `.stop` exists; refuse to start if `kickoff.md` is missing/empty; load `state.json` (initialize if absent); start the Slack bot (or notification-only if `SLACK_APP_TOKEN` is absent).

2. **Iteration start** — re-check `.stop` sentinel; check for program-done sentinel (`STOP — program complete` in `kickoff.md`) and halt cleanly if present; increment iter counter; open per-iter log; notify "iter N starting".

3. **Agent invocation** — call SDK `query()` with `kickoff.md` content as the user prompt and the permission shim as `canUseTool`. Stream messages, appending text content to the in-memory transcript and to the per-iter log. Track the last `Bash` command for PR detection. Catch `rate_limit_event` first-class messages and rate-limit thrown exceptions.

4. **Rate-limit recovery** (only if hit) — compute sleep until `resetsAt + buffer` (60s default); notify Slack with the wake time; sleep; notify on resume; re-fire SAME iteration. Cap at 3 retries per iter (configurable via `ORCHESTRATION_RATE_LIMIT_MAX_RETRIES`); halt on the 4th attempt.

5. **End of session** — detect the PR number: first try parsing it from the most recent `gh pr create` output (preferred), then fall back to parsing the last switched branch name and querying `gh pr list --head <branch>`. If no PR found, halt with `no_pr_detected`.

6. **CI poll** — refuse to operate if `.github/workflows/` has no yml files on main (halt with `ci_no_workflows`). Otherwise poll `gh pr checks <N>` every 30s up to 45min (configurable). Notify every ~5min during long polls. On `red` halt with `ci_failed` (do NOT auto-fix per principle 10). On `timeout` halt with `ci_timeout`. On `green` proceed.

7. **Merge** — `gh pr merge <N> --merge --delete-branch`. Notify "PR merged". Update state. The loop, NOT the agent, performs the merge.

8. **Extract next prompt** — four tiers in order (cheapest + most deterministic first). Tier 1: heading anchor `## ... next-session prompt` followed by a fenced block, a blockquote run, or trimmed prose (heading text inside the fenced block does NOT terminate the section). Tier 2: last triple-backtick fenced block in the full transcript. Tier 3: fetch the just-merged PR's body via `gh pr view --json body` and re-run tier-1 / tier-2 extraction against that text — handles the case where the agent placed the next-prompt in the PR description instead of the transcript. Tier 4: Haiku-based AI fallback on the last 20k characters of the transcript; returns NONE if no next-prompt is found. If all four return NONE, halt with `next_prompt_missing`.

9. **Strip fabricated preambles** — regex scan for "operator (has |has )?(confirmed|authorized|approved|signed-off|waived|overridden)", "operator (confirmation|authorization|approval|sign-off|waiver|override)", "per operator approval", "with operator approval", "operator (says|told me) to (proceed|continue|bypass)", "CEO has approved", "PO / product owner has approved", and similar phrasings. Strip matched paragraphs (whole-paragraph removal, no dangling half-sentences). Notify Slack with the stripped content sample so the operator can inspect. The cleaned prompt continues into the next iteration.

10. **Write next kickoff** — overwrite `kickoff.md` with the cleaned prompt. Notify Slack. Loop back to step 2.

Any non-rate-limit exception from the SDK halts the loop with `loop_error` and surfaces the error message via Slack.

## The ten principles, applied to FleetCo

The principles are the same ones documented in ADR-0022's predecessors and are not repeated in full here. The FleetCo-specific tuning:

**1. Honor discipline gates absolutely.** The loop's CI-green-before-merge gate is enforced by `pollCi`; the `hasCiWorkflows` precheck refuses to operate without CI. There is no waiver mechanism. The agent's own discipline gates (CLAUDE.md, ADRs, runbook procedures) are enforced inside the agent's session by the agent's CLAUDE.md-mandated behavior; the loop trusts the agent and verifies via CI.

**2. Strip fabricated operator-confirmation preambles.** Mandatory from day one; built into `src/strip-fabricated.ts`. The regex set covers 8 phrasing families including role-name variants ("CEO has approved", "PO has approved"). Notifications include the stripped content sample for operator inspection. This principle is also anchored in CLAUDE.md's Orchestration section so future agents do not insert the preambles in the first place.

**3. Auto-answer `AskUserQuestion` via denial-as-answer.** Default selection: Recommended marker → that option; otherwise option 0; multi-select picks only the first option (conservative). For genuinely ambiguous single-select questions (no Recommended marker, ≥3 options), route to Haiku with project context: "FleetCo, modular-monolith fleet ERP for a Nepal construction company. Phase 0 / early Phase 1. Prefer halt over proceed; prefer recommended over experimental." Haiku failure (no API key, network error) falls back to the default rule.

**4. Detect PR numbers only after the agent actually creates one.** `src/pr-detection.ts` maintains a state object that records the last Bash command and the last switched branch name. The detector only parses PR numbers from the output of a Bash command that was `gh pr create`; the branch-name fallback queries `gh pr list --head <branch>` against the current branch. Narrative mentions of prior PR numbers (`#3`, `#5`) in the agent's text output are never matched.

**5. Four-tier extractor.** All four tiers are implemented and unit-tested against fixture transcripts in `tests/fixtures/`. The Tier 1 implementation has been hardened against the case where the next-prompt's fenced body contains `##` headings (the canonical kickoff format) — the extractor correctly treats `## Program`, `## Discipline`, `## Ticket`, `## Required output` inside the fenced body as content, not as section terminators. The Tier 3 PR-body fallback was added after a live failure where the agent emitted its next-prompt only inside the PR description; the same heading and trailing-fenced-block extractors are re-applied to the PR body before falling through to the Haiku tier.

**6. Rate-limit recovery.** Both flavors implemented in `src/rate-limit-recovery.ts`: `computeWaitFromEvent` handles the first-class `rate_limit_event` with `resetsAt` (or `resets_at`) timestamps; `parseWaitFromException` handles thrown-exception messages with phrasings "resets 5:25pm", "resets at 5:25 PM", "resets 17:25", "try again in 45 minutes", "retry in 90 seconds", "retry in 2 hours". Case-insensitive. Day-rollover heuristic: if the parsed time-of-day is in the past today, assume tomorrow. Buffer added per `ORCHESTRATION_RATE_LIMIT_BUFFER_SECONDS` (default 60). Retry cap from `ORCHESTRATION_RATE_LIMIT_MAX_RETRIES` (default 3); halt on (N+1)th attempt. Notifications fire on every wait and every resume.

**7. Block destructive commands at the permission shim.** The FleetCo-tuned blocklist (`src/destructive-bash.ts`) covers 23 entries across nine categories: filesystem destroy (rm -rf and variants), git force-push, git reset --hard, git commit --amend (CLAUDE.md commit discipline), git rebase -i, git filter-branch/filter-repo/update-ref -d, gh pr close + gh pr merge (loop owns merge), prisma db push (CLAUDE.md prohibition), prisma migrate reset/deploy, psql -c with DROP/TRUNCATE/DELETE FROM (CLAUDE.md), npm/pnpm/yarn uninstall/remove, package install --force, docker system prune / volume rm / compose down -v, pkill/killall/kill -9 1, writes redirected to /etc/, /usr/, /System/, /Library/. Approve everything else. Every denial logs to `decisions.log` with the matched pattern + category.

**8. Notify from wherever the operator is.** Slack bidirectional bot. Outbound via incoming webhook (`SLACK_WEBHOOK_URL`). Inbound via Socket Mode (`SLACK_APP_TOKEN` + `SLACK_BOT_TOKEN`) — no public HTTPS endpoint needed. 22 distinct milestone types notified, each with an emoji and a short summary message (NOT full agent output, per ADR-0013 data classification). Slash commands: `/status` (iter count, current PR, sentinel state, last 5 decisions), `/tail` (last 30 lines of decisions.log), `/stop` (touches `.stop`), `/resume` (deletes `.stop`), `/queue` (current kickoff.md content). AI fallback: app-mention messages route to Haiku with the last 50 lines of decisions.log as context.

**9. Operator-only steps surfaced honestly.** When the loop halts on a CI failure, no-CI condition, no-PR detection, no-next-prompt extraction, rate-limit cap, or `.stop` trigger, it sends a Slack notification with the reason and the context the operator needs to act. The loop does NOT auto-resume from these halts; the operator manually restarts after handling. The FleetCo-specific operator-only escalations (phase progression in `docs/CURRENT_PHASE.md`, ADR approvals, error-budget decisions per ADR-0011, security incident response per `docs/runbook/security-incident-response.md`, post-deploy telemetry verification, Nepal-specific compliance verification) are surfaced inside the agent's session by the agent's CLAUDE.md-mandated behavior (it halts and emits a session-ending message); the loop reads the absence of a PR and halts accordingly.

**10. Things explicitly NOT built.** No CI auto-fix retry. No discipline-gate waiver mechanism. No auto-resume after wall-clock windows. No GUI or dashboard. No multi-program orchestration. No cost monitoring (subscription billing self-caps). No automated rollback. No auto-restart of crashed loops (operator restarts manually). No notification bridge for non-Slack channels (operator chose Slack; non-Slack is out of scope).

## Integration with the project's memory architecture

The loop READS (via the agent it invokes, which reads at session start per CLAUDE.md): CLAUDE.md, `docs/CURRENT_PHASE.md`, `docs/glossary.md`, every ADR, every runbook procedure, the design system, the roadmap, the tech-debt register.

The loop WRITES, all gitignored under `scripts/orchestration/`: `state.json` (iter counter, last PR, last merge SHA, retry counter), `decisions.log` (append-only summary), `logs/<timestamp>-iter<N>-<slug>.log` (per-iter full message stream).

The loop RESPECTS:

- **Tier 2/Tier 3 data classification (ADR-0013)**: Slack notifications are short summaries, NOT full agent output. The agent's full text and tool outputs stay in `scripts/orchestration/logs/`, which is gitignored and per-machine.
- **Security baseline (ADR-0012)**: the loop's deps live in `scripts/orchestration/package.json` so Dependabot covers them once `.github/dependabot.yml` is configured. Semgrep can be configured to scan `scripts/orchestration/src/` once the security CI is built.
- **"No new top-level dependency without proposing first" (CLAUDE.md)**: the loop's deps are scoped to `scripts/orchestration/` and are NOT root-level. ADR-0022 documents this explicitly.
- **Single-agent workflow (ADR-0004)**: the loop runs ONE agent session at a time, sequentially.

## The "no CI" edge case

Until `.github/workflows/` exists with at least one yml file on main, the loop CANNOT enforce the CI-green-before-merge gate. Per principle 1, the loop refuses to operate without that gate.

**Resolution**: the operator does TWO prerequisite tickets MANUALLY before launching the loop:

1. **Bootstrap PR**: root `package.json` + `pnpm-workspace.yaml` + `.tool-versions` (or `.nvmrc`) + minimal placeholder `apps/api/package.json` + `apps/web/package.json` + `packages/` workspace pattern if intended. Operator opens the PR; reviews; merges manually.

2. **CI baseline PR**: `.github/workflows/ci.yml` (lint + type-check + vitest placeholder) + `.github/workflows/security.yml` (Semgrep + Dependabot reference + action-pinning check + CycloneDX SBOM per ADR-0012) + `.github/dependabot.yml`. The workflows defined in the PR's branch DO run on the PR itself, so the operator can verify green on the bootstrap PR before merging. After merge, main has CI.

Once CI is on main, the loop's `hasCiWorkflows` precheck passes, `pollCi` has something to poll, and the loop can take over.

## Slack bot setup (operator one-time)

1. Create a Slack app at api.slack.com/apps. Enable Socket Mode.
2. Add bot scopes: `chat:write`, `commands`, `app_mentions:read`.
3. Register slash commands: `/status`, `/tail`, `/stop`, `/resume`, `/queue`.
4. Install the app to the workspace; capture `SLACK_BOT_TOKEN` (xoxb-) and `SLACK_APP_TOKEN` (xapp-).
5. Add an Incoming Webhook to the chosen channel (e.g., `#fleetco-loop`); capture `SLACK_WEBHOOK_URL`.
6. Store all three in `scripts/orchestration/.env` (gitignored). Copy `.env.example` to `.env` as a starting point.

If the bot tokens are absent but the webhook URL is present, the loop runs in notification-only mode (no slash commands). If everything is absent, the loop runs silently (local logs only; no external notification). The loop NEVER refuses to start because of missing Slack credentials.

## What was smoke-tested

Built and tested on 2026-05-17 (PR-body fallback tier added 2026-05-26). 145 unit tests covering the deterministic pieces of the design:

- **destructive-bash.test.ts** (57 tests) — every blocklist entry across all 9 categories, plus negative cases verifying that benign commands (ls, git status, gh pr create, gh pr view, prisma migrate dev, docker compose up, etc.) are NOT blocked.
- **auto-answer.test.ts** (8 tests) — Recommended-marker pick, default option 0, multi-select first-only, Haiku fallback for ambiguous (mocked), Haiku-failure graceful fallback, multi-question batching, 2-option no-Haiku, pick-clamping.
- **extract-next-prompt.test.ts** (16 tests) — Tier 1 with fenced body, Tier 1 with blockquote body, Tier 2 trailing fenced, Tier 3 PR-body with heading + fenced block, Tier 3 PR-body via trailing-fenced-only path, Tier 3 falls through to Haiku on fetcher-returns-null, Tier 3 falls through on fetcher-throws, Tier 3 falls through on PR-body-with-no-prompt, Tier 4 returns NONE for transcripts without keywords, Tier 4 finds something when fallback is genuinely needed, gate prevents Haiku call for transcripts without relevant keywords, Tier 4 returns NONE on Haiku exception, Tier 1 wins over Tier 2 when both match.
- **strip-fabricated.test.ts** (11 tests) — all 8 phrasing families (operator confirmed, authorized, approved, signed off, waived, overridden, told me to proceed, CEO/PO/product owner approved) plus unchanged-on-clean-input, multi-strip, narrow-on-legitimate-references, double-blank-line collapse.
- **pr-detection.test.ts** (8 tests) — Tier 1 (gh pr create output URL + #N format), Tier 2 (branch fallback), narrative-mention immunity, ordering (Tier 1 wins), fall-through (gh pr create with unparseable output drops to branch fallback).
- **rate-limit-recovery.test.ts** (18 tests) — `computeWaitFromEvent` (string, Date, snake_case, null cases); `parseWaitFromException` (lowercase resets 5:25pm, capital Resets 5:25am, day-rollover, 24-hour, try-again-in-N-minutes, retry-in-N-seconds, retry-in-N-hours, non-rate-limit error returns null, parseable-time-with-buffer); `sleepUntil` (past target returns immediately, near-future sleeps, onTick callback fires).

End-to-end mock smoke test against a benign README.md "Hello/World" mock ticket is **deferred to the operator's first run** because it requires the operator's Slack credentials and Claude SDK auth, which are not available in the build session. The mock kickoff and procedure are documented in the operator guide.

## Open items (intentionally deferred)

Per principle 10 ("things explicitly NOT built"), the loop does not include: CI auto-fix retry, discipline-gate waiver, auto-resume after wall-clock windows, GUI/dashboard, multi-program orchestration, cost monitoring, automated rollback, auto-restart of crashed loops, non-Slack notification bridges.

Per `docs/tech-debt.md`, two follow-ups are tracked: destructive-Bash blocklist tuning (revisit as the project's stack evolves) and Slack bot capability expansion (add /skip-iter, /scope-extend, /halt-on-budget if the operator finds the basic set insufficient).
