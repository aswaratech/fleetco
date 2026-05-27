# ADR-0022: Adopt an autonomous orchestration loop for multi-ticket programs

- **Status:** Accepted
- **Date:** 2026-05-17 (proposed); 2026-05-21 (accepted)
- **Decider:** addressanup (CEO / sole developer)

## Context

FleetCo's daily delivery model so far has been one Claude Code session per ticket, with the operator (the CEO) present during the session and reviewing the PR before merge. This model is correct for individual tickets but creates friction for **multi-ticket programs** — series of related tickets where the operator wants the project to advance hands-off between PR merges. The two immediate cases are (a) finishing Phase 0 bootstrap and starting Phase 1 with the Vehicles vertical slice (~12–16 tickets), and (b) any subsequent slice-by-slice march through Phase 1's remaining seven slices.

The operator wants to step back from per-PR review for multi-ticket programs and let the loop drive: each agent session opens a PR and drafts the next session's kickoff prompt; the orchestrator polls CI, auto-merges on green, extracts the next prompt, recovers from rate limits, blocks destructive Bash, and notifies the operator via Slack on every milestone. The operator walks away from the laptop and is paged when they need to act.

The pattern fits FleetCo well: greenfield codebase, strict module boundaries (ADR-0001) that make ticket scope clean, vertical-slice development (ADR-0006) that makes ticket completion well-defined, explicit memory architecture on the filesystem (ADR-0009) that lets every fresh agent session pick up cold, CI-enforced discipline (ADR-0012) that the loop can rely on as the green-before-merge gate. The principal risks are loss of per-PR review, fabricated-confirmation drift from the agent, mid-session AskUserQuestion calls that need answering without an operator present, and rate-limit / format-drift / no-PR / no-next-prompt failure modes during long unattended runs.

The principles described below come from a real program run (not from this project) that produced approximately twenty PRs landed end-to-end without per-PR human review across three days. Each principle addresses a specific empirically-observed failure mode in that run. The decision is to build all of them in from day one rather than discover them by failure.

## Decision

Adopt an autonomous orchestration loop, built per [docs/runbook/orchestration-loop-design.md](../../runbook/orchestration-loop-design.md), with a daily-operator reference at [docs/runbook/orchestration-loop-operator-guide.md](../../runbook/orchestration-loop-operator-guide.md). The loop lives at [scripts/orchestration/](../../../scripts/orchestration/) as standalone operator tooling — a small TypeScript program built on the Claude Agent SDK, NOT a member of the future pnpm workspace and NOT consumed by `apps/`.

The loop honors all discipline gates from this file's predecessors:

- CI green before merge per `main is always green` (CLAUDE.md). If `.github/workflows/` has no yml files on main, the loop halts with `no_workflows`.
- Module boundaries (ADR-0001), TypeScript strict (ADR-0005), vertical slices (ADR-0006), repo-as-memory (ADR-0009) — enforced by the agent's discipline; the loop trusts the agent to honor these and verifies via CI.
- DORA cadence (ADR-0010), SLO error budget (ADR-0011) — surfaced via the operator's existing dashboards (which will be built in Phase 1); the loop does not measure these itself but halts cleanly if the operator triggers `/stop` for any reason.
- Security baseline (ADR-0012) — enforced by CI; if Semgrep / Dependabot / action-pinning checks fail on a PR, the loop halts on `ci_failed`.
- Data classification (ADR-0013) — Slack notifications are short summary messages, NOT full agent output; Tier 2/Tier 3 content stays in local per-iter logs under `scripts/orchestration/logs/`, gitignored.
- Single-agent workflow (ADR-0004) — the loop runs ONE agent session at a time, sequentially. No parallel agent fan-out.

The loop's behavior is governed by **ten principles**, documented in detail in the design document. Of these, two are load-bearing for the project's discipline and must be internalized by every future agent that operates in this repo:

1. **Honor discipline gates absolutely.** The loop does not bypass CI, does not waive ADRs, does not invent operator confirmations.

2. **Strip fabricated operator-confirmation preambles from extracted next-prompts.** This is the largest single gotcha of the pattern: if the operator ever writes a kickoff with a legitimate operator-confirmation preamble, the agent learns the pattern and reuses it, fabricating "operator has confirmed X" assertions for preconditions that are not actually met. The loop scans every extracted next-prompt for these phrasings, strips matched paragraphs, and notifies the operator. **Future agents must NOT include operator-confirmation preambles in next-session prompts, even when they seem appropriate** — the strip will fire and waste iteration time.

Auth posture: subscription OAuth via the Claude Agent SDK (Claude Max/Pro account). API-key fallback (`ANTHROPIC_API_KEY`) is documented but not the primary path.

Notification channel: Slack with a bidirectional bot app — incoming webhook for notifications, Socket Mode for slash commands (`/status`, `/tail`, `/stop`, `/resume`, `/queue`) and an AI fallback that routes free-form messages to Haiku with recent log context.

## Alternatives considered

**Running each ticket as a normal session with the operator present.** This is the current default and remains the right choice for one-off tickets, schema-defining tickets (the Trip aggregate, ADR-0003), and tickets that touch external integrations requiring Nepal-specific compliance verification. Rejected as the only model because the operator wants hands-off execution for multi-ticket programs.

**Adopting a hosted CI/CD tool with auto-merge as the only automation.** Auto-merge on its own does not solve the per-session problems the loop addresses: AskUserQuestion auto-answering, destructive-Bash blocking at the agent layer, fabricated-preamble stripping at the next-prompt extraction layer, rate-limit recovery at the SDK invocation layer. Auto-merge is one feature; the loop is a feature set. Rejected because the friction is at the agent layer, not the merge layer.

**Building a custom loop without the discipline guards described in the design.** This is the failure mode the design document is explicitly defending against. Each of the ten principles came from an empirically-observed failure in a real program run. Skipping any of them produces specific failure modes within ten to twenty iterations. Rejected because the cost of building the guards once is much smaller than the cost of debugging the resulting failures while a multi-day program is in flight.

**Python implementation.** The SDK ships Python bindings; a Python loop would be possible. Rejected because (a) it introduces a top-level language to a TypeScript-only project, which CLAUDE.md prohibits without an ADR (this would be that ADR but it doesn't add value), (b) it puts the loop in a different toolchain from the rest of the project, doubling the maintenance surface.

## Consequences

**What this makes easier.** Multi-ticket programs of 5–30 tickets can run hands-off between PR merges. The operator is paged on every milestone via Slack and can intervene from their phone (`/status`, `/tail`, `/stop`, `/resume`, AI-fallback questions). Discipline gates from CLAUDE.md and the ADRs are enforced at the loop layer (destructive-Bash blocking, fabricated-preamble stripping, CI-green-before-merge, no-PR halting) rather than relying entirely on the agent's own discipline.

**What this makes harder.** Per-PR human review is lost for loop-driven programs; the operator reviews asynchronously after merges. Mid-session AskUserQuestion calls are auto-answered (Recommended marker → that option; else option 0; else Haiku fallback with conservative project context); the operator does not get to weigh in on the substance unless they `/stop` and inspect. Cumulative drift over very long programs (>30 tickets) is possible. The loop's guards become maintenance surface (the destructive-Bash blocklist needs tuning as the stack evolves; the fabricated-preamble regex needs review if a new phrasing slips through; the four-tier extractor needs revisiting if the agent's output format drifts in a way none of the tiers catch — tier 3 was added after a live failure where an agent put its next-prompt in the PR description body instead of the transcript, and a post-extraction length floor (`next_prompt_too_short`, 4000 chars) was added after repeated failures where agents drafted next-prompts that compressed away the structural / hardening sections and doomed the next iter). Two prerequisite tickets — monorepo scaffold and CI baseline — must be done manually by the operator before the loop can take over, because the loop refuses to merge without CI.

**Costs accepted.** The loop's dependencies (`@anthropic-ai/claude-agent-sdk`, `@anthropic-ai/sdk`, `@slack/web-api`, `@slack/socket-mode`, `zod`, `tsx`, `typescript`, `vitest`) live in `scripts/orchestration/package.json` and are NOT root-level dependencies of the FleetCo monorepo. They do not count as "top-level dependencies" in the sense CLAUDE.md prohibits. They are operator tooling, scoped to a single directory, and can be removed by deleting that directory if the loop is ever retired.

**Runtime data accepted.** `state.json`, `decisions.log`, `logs/`, `.stop`, `.env` are gitignored under `scripts/orchestration/`. They are per-machine ephemera; nothing the project's memory architecture depends on lives in them.

## Revisit when

- **Cumulative drift becomes observable**: if a postmortem traces a defect to "the loop merged a PR that no human reviewed and the defect would have been caught by review," consider tightening the loop's guards or scoping programs smaller. If the DORA rework-rate metric (per ADR-0010) climbs sustained above the 25% target during loop-driven programs, the loop is producing more rework than it saves; revisit.

- **A discipline gate is repeatedly bypassed by fabricated preambles**: more than three preamble strips per program signals adversarial drift — the agent is generating phrasings the guard doesn't catch. Tighten the regex set; consider an LLM-based classifier instead of regex; or pause the loop and run sessions with the operator present until the agent's discipline is re-established.

- **The program-to-program ratio of loop-driven work changes meaningfully**: if the operator wants to run multiple programs in parallel (which the loop does not support), or wants the loop always-on (which the loop is not designed for), this ADR is incomplete and a successor ADR is needed.

- **The Claude Agent SDK introduces a native orchestration primitive that obsoletes the custom loop**: when this happens, supersede this ADR with a new one that adopts the native primitive and document the migration.

- **The destructive-Bash blocklist false-positive rate exceeds one operator interrupt per program**: tune the blocklist. False positives are the operator-friction tax of over-blocking; the design choice is to err toward over-blocking but not by so much that operations become painful.
