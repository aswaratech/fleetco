// Slack outbound notifications via incoming webhook.
//
// Principle 8 from docs/runbook/orchestration-loop-design.md: notify from
// wherever the operator is. Outbound is the webhook (`SLACK_WEBHOOK_URL`).
// Inbound (slash commands, AI fallback) is in slack-bot.ts.
//
// Notifications are short summary messages, NOT full agent output. Per
// ADR-0013, no Tier 2/Tier 3 data should leak to Slack; full content stays
// in local logs.

import { env } from "./config.js";
import type { Milestone, MilestoneEvent } from "./types.js";

const EMOJI: Record<Milestone, string> = {
  iteration_start: ":arrow_forward:",
  agent_invocation_start: ":robot_face:",
  auto_answer: ":speech_balloon:",
  destructive_bash_denied: ":no_entry_sign:",
  rate_limit_wait: ":hourglass_flowing_sand:",
  rate_limit_resume: ":arrows_counterclockwise:",
  rate_limit_cap_hit: ":exclamation:",
  agent_session_end: ":checkered_flag:",
  pr_opened: ":pencil2:",
  no_pr_detected: ":warning:",
  ci_poll_start: ":eyes:",
  ci_green: ":white_check_mark:",
  ci_failed: ":x:",
  ci_no_workflows: ":construction:",
  ci_timeout: ":alarm_clock:",
  pr_merged: ":tada:",
  next_prompt_extracted: ":mag:",
  next_prompt_missing: ":mailbox_with_no_mail:",
  next_prompt_too_short: ":straight_ruler:",
  fabricated_preamble_stripped: ":warning:",
  stop_sentinel_detected: ":octagonal_sign:",
  program_complete: ":checkered_flag:",
  loop_halted: ":octagonal_sign:",
  loop_error: ":rotating_light:",
};

export async function notify(event: MilestoneEvent, message: string): Promise<void> {
  if (!env.SLACK_WEBHOOK_URL) {
    // Webhook not configured. Silently skip; the local logs still record.
    return;
  }
  const emoji = EMOJI[event.milestone] ?? ":information_source:";
  const headline = `${emoji} *iter ${event.iteration}* — ${event.milestone}${event.pr ? ` (PR #${event.pr})` : ""}`;
  const body = [headline, message].filter((l) => l.length > 0).join("\n");
  // Truncate aggressively to keep accidental Tier 2/3 spillage minimal.
  const safe = body.length > 2000 ? body.slice(0, 2000) + " …(truncated)" : body;
  try {
    // 5s timeout: notify() is best-effort, NOT load-bearing. A hung or slow
    // Slack endpoint must not block the main iteration loop. Surfaced by
    // iter 1 of the Phase 1 Vehicles slice (2026-05-22): the loop hung for
    // 34+ minutes between agent_session_end and CI polling because
    // fetch(SLACK_WEBHOOK_URL) had no timeout and Slack connectivity was
    // intermittent (Socket Mode pong timeouts in stderr corroborated this).
    const res = await fetch(env.SLACK_WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: safe }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      process.stderr.write(`[orchestration] slack webhook returned ${res.status}\n`);
    }
  } catch (err) {
    process.stderr.write(`[orchestration] slack webhook failed: ${String(err)}\n`);
  }
}
