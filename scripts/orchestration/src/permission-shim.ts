// Permission shim — the canUseTool callback for the Claude Agent SDK.
//
// Two responsibilities, both load-bearing:
//   1. Block destructive Bash commands per the FleetCo blocklist (principle 7).
//   2. Auto-answer AskUserQuestion via denial-as-answer (principle 3).
//
// Everything else is allowed by default. Every denial is logged for the
// operator to audit later.
//
// SDK-shape note: @anthropic-ai/claude-agent-sdk@0.1.77 rejects an `allow`
// response that omits `updatedInput`, even though its TypeScript types mark
// the field optional. Surfaced by iter 1 of the Phase 1 Vehicles slice
// (2026-05-21): every Write/Edit/state-changing-Bash returned a Zod
// `invalid_union` error and the agent halted with no PR. We pass `updatedInput:
// input` (the original input, unchanged) on every allow path to satisfy the
// runtime requirement. If a future SDK version changes the schema, revisit
// here.

import { checkBashCommand } from "./destructive-bash.js";
import { autoAnswer } from "./auto-answer.js";
import { appendDecision } from "./logging.js";
import type { AskUserQuestionInput, MilestoneEvent } from "./types.js";

export type PermissionResult =
  | { behavior: "allow"; updatedInput?: Record<string, unknown> }
  | { behavior: "deny"; message: string; interrupt?: boolean };

export interface ShimContext {
  iteration: number;
  recordBashCall?: (command: string) => void;
}

export function buildPermissionShim(ctx: ShimContext) {
  return async function canUseTool(
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<PermissionResult> {
    if (toolName === "Bash") {
      const command = String(input.command ?? "");
      ctx.recordBashCall?.(command);
      const check = checkBashCommand(command);
      if (!check.allowed) {
        const event: MilestoneEvent = {
          milestone: "destructive_bash_denied",
          iteration: ctx.iteration,
          details: `${check.category}: ${command.slice(0, 100)}`,
        };
        appendDecision(event);
        return {
          behavior: "deny",
          message: `Destructive Bash blocked by orchestration loop: ${check.reason}. If this is wrong, the operator can tune the blocklist in scripts/orchestration/src/destructive-bash.ts.`,
          interrupt: false,
        };
      }
      return { behavior: "allow", updatedInput: input };
    }

    if (toolName === "AskUserQuestion") {
      const parsed = input as unknown as AskUserQuestionInput;
      if (!parsed?.questions || !Array.isArray(parsed.questions)) {
        return {
          behavior: "deny",
          message:
            "Auto-answer received malformed AskUserQuestion input. Please continue without asking; pick the option you believe the operator would prefer based on the project's discipline.",
        };
      }
      const answer = await autoAnswer(parsed);
      const event: MilestoneEvent = {
        milestone: "auto_answer",
        iteration: ctx.iteration,
        details: `questions=${parsed.questions.length} haiku=${answer.haikuUsed} picks=${JSON.stringify(answer.picksByQuestion)}`,
      };
      appendDecision(event);
      return { behavior: "deny", message: answer.message };
    }

    // Everything else: allow.
    return { behavior: "allow", updatedInput: input };
  };
}
