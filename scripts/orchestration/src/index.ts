// FleetCo orchestration loop — entry point.
//
// Run: `cd scripts/orchestration && pnpm start`
// See docs/runbook/orchestration-loop-design.md for the full design.
// See docs/runbook/orchestration-loop-operator-guide.md for daily operation.

import fs from "node:fs";
import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { env, paths, limits, debugMode } from "./config.js";
import { appendDecision, closeIterLog, openIterLog, writeIterLine } from "./logging.js";
import { halt } from "./halt.js";
import { notify } from "./slack-notify.js";
import { startSlackBot } from "./slack-bot.js";
import { initialState, loadState, saveState } from "./state.js";
import { buildPermissionShim } from "./permission-shim.js";
import { createDetectorState, detectPr, recordBash } from "./pr-detection.js";
import { computeWaitFromEvent, parseWaitFromException, sleepUntil } from "./rate-limit-recovery.js";
import { hasCiWorkflows, pollCi } from "./ci-poll.js";
import { autoMerge } from "./auto-merge.js";
import {
  extractNextPrompt,
  defaultPrBodyFetcher,
  isNextPromptTooShort,
  MIN_NEXT_PROMPT_LENGTH,
} from "./extract-next-prompt.js";
import { stripFabricatedPreambles } from "./strip-fabricated.js";
import type { LoopState, RateLimitWaitInfo } from "./types.js";

const PROGRAM_DONE_SENTINEL = /^\s*STOP\s*[—-]\s*program\s+complete\s*$/im;

async function main(): Promise<void> {
  // ---------- Startup ----------
  if (fs.existsSync(paths.stopSentinel)) {
    process.stderr.write(
      `[orchestration] .stop sentinel present at ${paths.stopSentinel}; refusing to start. Remove the file or run /resume from Slack.\n`,
    );
    process.exit(0);
  }
  if (!fs.existsSync(paths.kickoffFile)) {
    process.stderr.write(
      `[orchestration] kickoff.md not found at ${paths.kickoffFile}. Write the first kickoff prompt (see kickoff.md.template) before starting.\n`,
    );
    process.exit(1);
  }

  let state = loadState();
  if (state.iteration === 0) {
    state = { ...initialState(), startedAt: new Date().toISOString() };
    saveState(state);
  }

  const bot = await startSlackBot();
  process.on("SIGINT", async () => {
    process.stderr.write(`[orchestration] SIGINT; shutting down.\n`);
    if (bot) await bot.stop().catch(() => undefined);
    closeIterLog();
    process.exit(130);
  });

  await notify(
    { milestone: "iteration_start", iteration: state.iteration, details: "loop process started" },
    `Loop started. Slack ${bot ? "bot active" : "webhook-only"}. Watching kickoff.md.`,
  );

  // ---------- Main iteration loop ----------
  while (true) {
    // Per-iter state reset.
    state = { ...state, rateLimitRetries: 0 };
    saveState(state);

    // Check stop sentinel before doing anything else.
    if (fs.existsSync(paths.stopSentinel)) {
      await notify(
        { milestone: "stop_sentinel_detected", iteration: state.iteration },
        ".stop sentinel detected at iteration boundary; halting cleanly.",
      );
      appendDecision({ milestone: "stop_sentinel_detected", iteration: state.iteration });
      break;
    }

    // Read current kickoff.
    const kickoff = fs.readFileSync(paths.kickoffFile, "utf8");
    if (!kickoff.trim()) {
      await halt("kickoff.md is empty", 1, state);
    }

    // Program-done sentinel: the agent outputs "STOP — program complete" inside the next-prompt block
    // when the program is exhausted. The previous iter's extractor wrote that to kickoff.md.
    if (PROGRAM_DONE_SENTINEL.test(kickoff)) {
      await notify(
        { milestone: "program_complete", iteration: state.iteration },
        ":checkered_flag: Program complete. The agent signaled STOP. Operator can start a new program by overwriting kickoff.md.",
      );
      appendDecision({ milestone: "program_complete", iteration: state.iteration });
      state = { ...state, programDoneSentinelSeen: true };
      saveState(state);
      break;
    }

    // ---------- Iteration start ----------
    state = {
      ...state,
      iteration: state.iteration + 1,
      lastIterStartedAt: new Date().toISOString(),
    };
    saveState(state);
    const slug = makeSlug(kickoff);
    openIterLog(state.iteration, slug);
    writeIterLine(`Kickoff:\n${kickoff}\n\n---\n`);
    appendDecision({ milestone: "iteration_start", iteration: state.iteration, details: slug });
    await notify(
      { milestone: "iteration_start", iteration: state.iteration, details: slug },
      `Starting iteration ${state.iteration} on: ${slug}`,
    );

    // ---------- Agent invocation with rate-limit retry ----------
    const transcript = await invokeAgentWithRetry(state, kickoff);
    if (transcript === null) {
      // Halted inside (rate-limit cap hit, etc.) — loop body called halt() which exits.
      break;
    }

    // ---------- PR detection ----------
    appendDecision({ milestone: "agent_session_end", iteration: state.iteration });
    const prDetect = await detectPr(transcript.detectorState, { cwd: paths.repoRoot });
    if (prDetect.prNumber === null) {
      await halt(
        `Iter ${state.iteration} produced no PR. The agent ended its session without calling gh pr create successfully. Operator must inspect logs/.`,
        2,
        state,
      );
    }
    // TS doesn't always narrow through `await halt(...)` (Promise<never>); extract to a const for clarity.
    const prNumber: number = prDetect.prNumber as number;
    state = { ...state, lastPrNumber: prNumber };
    saveState(state);
    await notify(
      { milestone: "pr_opened", iteration: state.iteration, pr: prNumber },
      `PR #${prNumber} detected via ${prDetect.source}${prDetect.branch ? ` (branch ${prDetect.branch})` : ""}.`,
    );

    // ---------- CI poll ----------
    if (!hasCiWorkflows()) {
      await halt(
        "No CI workflows on main. Per principle 1, the loop refuses to merge without CI. Operator must complete the CI bootstrap PR before launching the loop.",
        3,
        state,
      );
    }
    await notify(
      { milestone: "ci_poll_start", iteration: state.iteration, pr: prNumber },
      `Polling CI on PR #${prNumber} every ${Math.round(limits.ciPollIntervalMs / 1000)}s (timeout ${Math.round(limits.ciPollTimeoutMs / 60_000)}min).`,
    );
    const ci = await pollCi(prNumber, {
      onPoll: (elapsed) => {
        if (elapsed > 0 && elapsed % (5 * 60 * 1000) < limits.ciPollIntervalMs) {
          // Notify every ~5 min of waiting so operator knows we're alive.
          void notify(
            { milestone: "ci_poll_start", iteration: state.iteration, pr: prNumber },
            `Still polling CI on PR #${prNumber} (${Math.round(elapsed / 60_000)}min elapsed).`,
          );
        }
      },
    });

    if (ci.status === "red") {
      appendDecision({
        milestone: "ci_failed",
        iteration: state.iteration,
        pr: prNumber,
        details: ci.details + (ci.failedCheck ? ` (${ci.failedCheck})` : ""),
      });
      await halt(
        `CI failed on PR #${prNumber}: ${ci.failedCheck ?? "unknown check"}. ${ci.details}`,
        4,
        state,
      );
    }
    if (ci.status === "timeout") {
      appendDecision({
        milestone: "ci_timeout",
        iteration: state.iteration,
        pr: prNumber,
        details: ci.details,
      });
      await halt(ci.details, 5, state);
    }
    if (ci.status === "no_workflows") {
      appendDecision({
        milestone: "ci_no_workflows",
        iteration: state.iteration,
        details: ci.details,
      });
      await halt(ci.details, 3, state);
    }
    // green
    appendDecision({ milestone: "ci_green", iteration: state.iteration, pr: prNumber });
    await notify(
      { milestone: "ci_green", iteration: state.iteration, pr: prNumber },
      `CI green on PR #${prNumber}. Merging.`,
    );

    // ---------- Merge ----------
    const merge = await autoMerge(prNumber);
    if (!merge.ok) {
      await halt(
        `Auto-merge failed on PR #${prNumber}: ${merge.error}. Operator must inspect.`,
        6,
        state,
      );
    }
    state = { ...state, lastMergedSha: merge.mergedSha ?? null };
    saveState(state);
    appendDecision({
      milestone: "pr_merged",
      iteration: state.iteration,
      pr: prNumber,
      details: merge.mergedSha ?? "",
    });
    await notify(
      { milestone: "pr_merged", iteration: state.iteration, pr: prNumber },
      `PR #${prNumber} merged${merge.mergedSha ? ` at ${merge.mergedSha.slice(0, 7)}` : ""}.`,
    );

    // ---------- Extract next prompt ----------
    // Tier 3 fetches the just-merged PR's body as a safety net when the agent
    // placed the next-session prompt only in the PR description rather than
    // the assistant transcript. The closure binds the prNumber + repoRoot.
    const extracted = await extractNextPrompt(transcript.text, {
      prBodyFetcher: () => defaultPrBodyFetcher(prNumber, paths.repoRoot),
    });
    if (!extracted.prompt) {
      appendDecision({ milestone: "next_prompt_missing", iteration: state.iteration });
      await halt(
        `Iter ${state.iteration} produced no next-session prompt (all 4 extractor tiers returned NONE, including PR #${prNumber}'s body). Operator must inspect logs/ and write the next iteration's kickoff manually before relaunching.`,
        7,
        state,
      );
    }
    // Length floor: a prompt that extracted cleanly but is too short is
    // almost always an agent-compressed kickoff that dropped the
    // structural + hardening sections. Writing it to kickoff.md would
    // doom the next iter (the thinned prompt loses the discipline rules
    // that prevent plan-mode waits / defensive refusals). Halt here
    // instead — distinct from next_prompt_missing so decisions.log
    // tells the operator "something was written, but it was too thin"
    // rather than "nothing was written."
    if (isNextPromptTooShort(extracted.prompt)) {
      appendDecision({
        milestone: "next_prompt_too_short",
        iteration: state.iteration,
        details: `tier=${extracted.tier} length=${extracted.prompt.length} floor=${MIN_NEXT_PROMPT_LENGTH}`,
      });
      await halt(
        `Iter ${state.iteration}'s next-session prompt is only ${extracted.prompt.length} chars (floor ${MIN_NEXT_PROMPT_LENGTH}); the agent likely compressed away the structural / hardening sections. Operator must write a complete kickoff manually before relaunching.`,
        7,
        state,
      );
    }
    appendDecision({
      milestone: "next_prompt_extracted",
      iteration: state.iteration,
      details: `tier=${extracted.tier} length=${extracted.prompt.length}`,
    });

    // ---------- Strip fabricated preambles ----------
    const stripped = stripFabricatedPreambles(extracted.prompt);
    if (stripped.strippedBlocks.length > 0) {
      appendDecision({
        milestone: "fabricated_preamble_stripped",
        iteration: state.iteration,
        details: `blocks=${stripped.strippedBlocks.length}`,
      });
      const sample = stripped.strippedBlocks
        .map((b, i) => `[${i + 1}] ${b.slice(0, 300)}`)
        .join("\n---\n");
      await notify(
        { milestone: "fabricated_preamble_stripped", iteration: state.iteration },
        [
          `:warning: Stripped ${stripped.strippedBlocks.length} fabricated operator-confirmation preamble(s) from iter ${state.iteration}'s next prompt.`,
          "The cleaned prompt continues into the next iteration. Inspect if this is unexpected.",
          "Stripped content:",
          "```",
          sample,
          "```",
        ].join("\n"),
      );
    }

    // ---------- Write next kickoff & loop ----------
    fs.writeFileSync(paths.kickoffFile, stripped.cleaned + "\n", "utf8");
    await notify(
      { milestone: "next_prompt_extracted", iteration: state.iteration },
      `Next prompt extracted (tier ${extracted.tier}); kickoff.md overwritten for iteration ${state.iteration + 1}.`,
    );
    closeIterLog();
    // Loop continues at the next iteration.
  }

  // Loop exited.
  if (bot) await bot.stop().catch(() => undefined);
  closeIterLog();
  appendDecision({ milestone: "loop_halted", iteration: state.iteration, details: "clean exit" });
  process.exit(0);
}

// ---------- Agent invocation with rate-limit retry ----------

interface AgentRunResult {
  text: string;
  detectorState: ReturnType<typeof createDetectorState>;
}

async function invokeAgentWithRetry(
  state: LoopState,
  kickoff: string,
): Promise<AgentRunResult | null> {
  for (let attempt = 0; attempt <= limits.rateLimitMaxRetries; attempt++) {
    const detectorState = createDetectorState();
    let lastBashCommand: string | null = null;

    const shim = buildPermissionShim({
      iteration: state.iteration,
      recordBashCall: (cmd) => {
        lastBashCommand = cmd;
      },
    });

    appendDecision({
      milestone: "agent_invocation_start",
      iteration: state.iteration,
      details: `attempt=${attempt + 1}/${limits.rateLimitMaxRetries + 1}`,
    });

    let transcript = "";
    let waitInfo: RateLimitWaitInfo | null = null;

    try {
      const stream = query({
        prompt: kickoff,
        options: {
          model: env.ORCHESTRATION_PRIMARY_MODEL,
          fallbackModel: env.ORCHESTRATION_FALLBACK_MODEL,
          cwd: paths.repoRoot,
          maxTurns: limits.agentMaxTurns,
          canUseTool: shim,
        },
      } as Parameters<typeof query>[0]);

      for await (const msg of stream as AsyncIterable<SDKMessage>) {
        const m = msg as SdkMessageLoose;
        if (debugMode) writeIterLine(`[${m.type}${m.subtype ? "/" + m.subtype : ""}]`);

        if (m.type === "rate_limit_event") {
          waitInfo = computeWaitFromEvent(m as unknown as { resetsAt?: string | Date | number });
          if (waitInfo) break;
        }

        if (m.type === "assistant") {
          const content = extractTextFromAssistantMessage(m);
          if (content) {
            transcript += content + "\n";
            writeIterLine(content);
          }
        }

        if (m.type === "user" && m.tool_use_result) {
          // A tool result came back. Pair with the most recent Bash command.
          const output = stringifyToolResult(m.tool_use_result);
          if (lastBashCommand !== null) {
            recordBash(detectorState, lastBashCommand, output);
            lastBashCommand = null;
          }
          if (debugMode) writeIterLine(`[tool_result] ${output.slice(0, 200)}`);
        }

        if (m.type === "result") {
          // Final result message; the session has ended.
          if (m.result && typeof m.result === "string") {
            transcript += "\n" + m.result;
            writeIterLine("[final result]\n" + m.result);
          }
        }
      }
    } catch (err) {
      waitInfo = parseWaitFromException(err);
      // The SDK sometimes terminates with a generic "Claude Code process
      // exited with code N" error after the agent's final streamed message
      // contained the rate-limit phrasing ("You've hit your limit · resets
      // H:MM..."). In that case the exception itself has no parseable
      // signal, but the transcript tail does. Try the tail as a fallback
      // so a rate-limit recovery still engages instead of a hard halt.
      if (!waitInfo && transcript.length > 0) {
        waitInfo = parseWaitFromException(transcript.slice(-2000));
      }
      if (!waitInfo) {
        // Non-rate-limit error: halt.
        await halt(
          `Agent invocation failed (iter ${state.iteration}, attempt ${attempt + 1}): ${(err as Error)?.message ?? String(err)}`,
          8,
          state,
        );
      }
    }

    if (waitInfo) {
      state = { ...state, rateLimitRetries: state.rateLimitRetries + 1 };
      saveState(state);
      if (attempt >= limits.rateLimitMaxRetries) {
        appendDecision({
          milestone: "rate_limit_cap_hit",
          iteration: state.iteration,
          details: `${attempt + 1} attempts; resumesAt=${waitInfo.resumesAt.toISOString()}`,
        });
        await halt(
          `Rate-limit cap hit at iter ${state.iteration} (${attempt + 1} attempts). Last wait would have resumed at ${waitInfo.resumesAt.toISOString()}. Operator must inspect.`,
          9,
          state,
        );
      }
      appendDecision({
        milestone: "rate_limit_wait",
        iteration: state.iteration,
        details: `${waitInfo.source}: until ${waitInfo.resumesAt.toISOString()}`,
      });
      await notify(
        { milestone: "rate_limit_wait", iteration: state.iteration },
        `:hourglass_flowing_sand: Rate limit hit (${waitInfo.source}). Sleeping until ${waitInfo.resumesAt.toLocaleString()} (~${Math.round((waitInfo.resumesAt.getTime() - Date.now()) / 60_000)}min). Attempt ${attempt + 1}/${limits.rateLimitMaxRetries + 1}.`,
      );
      await sleepUntil(waitInfo.resumesAt);
      appendDecision({ milestone: "rate_limit_resume", iteration: state.iteration });
      await notify(
        { milestone: "rate_limit_resume", iteration: state.iteration },
        `:arrows_counterclockwise: Resuming iter ${state.iteration} after rate-limit wait.`,
      );
      continue;
    }

    return { text: transcript, detectorState };
  }

  // Shouldn't reach here.
  return null;
}

// ---------- Helpers ----------

interface SdkMessageLoose {
  type: string;
  subtype?: string;
  result?: unknown;
  tool_use_result?: unknown;
  message?: unknown;
  [key: string]: unknown;
}

function extractTextFromAssistantMessage(m: SdkMessageLoose): string {
  const inner = m.message as { content?: { type: string; text?: string }[] } | undefined;
  if (!inner?.content || !Array.isArray(inner.content)) return "";
  return inner.content
    .filter(
      (c): c is { type: "text"; text: string } => c.type === "text" && typeof c.text === "string",
    )
    .map((c) => c.text)
    .join("\n");
}

function stringifyToolResult(result: unknown): string {
  if (typeof result === "string") return result;
  if (result && typeof result === "object") {
    try {
      return JSON.stringify(result);
    } catch {
      return String(result);
    }
  }
  return String(result);
}

function makeSlug(kickoff: string): string {
  // Extract the first line of the ## Ticket section (or the first sentence) as a slug.
  const ticketMatch = /^##\s+Ticket\s*\n+(.+?)(?:\n|$)/im.exec(kickoff);
  const raw = ticketMatch?.[1] ?? kickoff.split("\n").find((l) => l.trim().length > 0) ?? "iter";
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, "")
    .split(/\s+/)
    .slice(0, 6)
    .join("-")
    .slice(0, 50);
}

// ---------- Entry ----------

main().catch(async (err) => {
  process.stderr.write(
    `[orchestration] fatal: ${err instanceof Error ? err.stack : String(err)}\n`,
  );
  await halt(`Unhandled fatal error: ${err instanceof Error ? err.message : String(err)}`, 99);
});
