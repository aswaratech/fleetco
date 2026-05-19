// Auto-answer rules for AskUserQuestion tool calls.
//
// Principle 3 from docs/runbook/orchestration-loop-design.md: when the agent
// fires AskUserQuestion, the permission shim denies the call with a message
// formatted as the answer payload. The agent reads the denial reason as the
// answer and proceeds without a retry cycle.
//
// Default selection:
//   - If any option's label contains "(Recommended)", pick that option.
//   - Else pick option index 0.
//   - For multi-select, pick only the first option (conservative default).
//   - For genuinely ambiguous single-select questions with no Recommended
//     marker, route to Haiku with project context.

import Anthropic from "@anthropic-ai/sdk";
import { env } from "./config.js";
import type { AskUserQuestionInput, AutoAnswerResult } from "./types.js";

// Heuristic: a question is "genuinely ambiguous" if it is single-select, has no
// "(Recommended)" marker on any option, and at least 3 options exist (with 2
// options the first-option default is almost always fine — there's nothing
// meaningful to disambiguate).
function isGenuinelyAmbiguous(q: AskUserQuestionInput["questions"][number]): boolean {
  if (q.multiSelect) return false;
  if (q.options.some((opt) => /\(Recommended\)/i.test(opt.label))) return false;
  return q.options.length >= 3;
}

function pickByDefaultRule(q: AskUserQuestionInput["questions"][number]): number[] {
  const recommendedIdx = q.options.findIndex((opt) => /\(Recommended\)/i.test(opt.label));
  if (recommendedIdx >= 0) return [recommendedIdx];
  // Multi-select: only first option (conservative).
  // Single-select: option 0.
  return [0];
}

export interface HaikuPicker {
  (
    question: AskUserQuestionInput["questions"][number],
    projectContext: string,
  ): Promise<{ index: number; reason: string }>;
}

let cachedAnthropic: Anthropic | null = null;
function getAnthropic(): Anthropic {
  if (cachedAnthropic) return cachedAnthropic;
  // The SDK picks up ANTHROPIC_API_KEY automatically. For subscription OAuth,
  // the Claude Agent SDK handles auth at the query() level; the Anthropic SDK
  // for direct Haiku calls still needs an API key. If neither is present, the
  // Haiku fallback throws and we fall back to the default rule.
  cachedAnthropic = new Anthropic({});
  return cachedAnthropic;
}

export const defaultHaikuPicker: HaikuPicker = async (question, projectContext) => {
  const client = getAnthropic();
  const numbered = question.options
    .map((opt, i) => `[${i}] ${opt.label}${opt.description ? ` — ${opt.description}` : ""}`)
    .join("\n");
  const sys =
    "You are picking the safest answer to a question that the orchestration loop must auto-answer because the operator is not present. " +
    "Prefer halt over proceed. Prefer recommended over experimental. Prefer reversible over destructive. " +
    "Reply with EXACTLY a single line in the form: INDEX=<n> REASON=<one short sentence>";
  const user = `Project context: ${projectContext}\n\nQuestion: ${question.question}\n\nOptions:\n${numbered}\n\nReply with the safest pick.`;
  const resp = await client.messages.create({
    model: env.ORCHESTRATION_HAIKU_MODEL,
    max_tokens: 200,
    system: sys,
    messages: [{ role: "user", content: user }],
  });
  const text = resp.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
  const m = text.match(/INDEX\s*=\s*(\d+)\s+REASON\s*=\s*(.+)/i);
  if (!m) {
    return { index: 0, reason: `Haiku reply unparseable (${text.slice(0, 80)}); fell back to option 0` };
  }
  const idx = Number(m[1]);
  const safeIdx = Number.isInteger(idx) && idx >= 0 && idx < question.options.length ? idx : 0;
  return { index: safeIdx, reason: m[2]?.trim() ?? "no reason given" };
};

export interface AutoAnswerOptions {
  projectContext?: string;
  haikuPicker?: HaikuPicker;
}

export async function autoAnswer(
  input: AskUserQuestionInput,
  options: AutoAnswerOptions = {},
): Promise<AutoAnswerResult> {
  const projectContext =
    options.projectContext ??
    "FleetCo, modular-monolith fleet ERP for a Nepal construction company. Phase 0 / early Phase 1. The orchestration loop is running unattended. Prefer halt over proceed; prefer recommended over experimental.";
  const haikuPicker = options.haikuPicker ?? defaultHaikuPicker;

  const picksByQuestion: number[][] = [];
  const messageLines: string[] = ["Auto-answered: the operator is not present."];
  let haikuUsed = false;

  for (let qi = 0; qi < input.questions.length; qi++) {
    const q = input.questions[qi];
    if (!q) continue;
    if (isGenuinelyAmbiguous(q)) {
      try {
        const pick = await haikuPicker(q, projectContext);
        picksByQuestion.push([pick.index]);
        haikuUsed = true;
        const picked = q.options[pick.index];
        messageLines.push(
          `Q${qi + 1} (${q.header}): picked [${pick.index}] "${picked?.label ?? "?"}" via Haiku fallback. Reason: ${pick.reason}`,
        );
      } catch (err) {
        // Haiku call failed (no API key, network error, etc.); fall back to default rule.
        const indices = pickByDefaultRule(q);
        picksByQuestion.push(indices);
        const picked = indices[0] !== undefined ? q.options[indices[0]] : undefined;
        const errMsg = err instanceof Error ? err.message : String(err);
        messageLines.push(
          `Q${qi + 1} (${q.header}): Haiku unavailable (${errMsg.slice(0, 60)}); picked [${indices[0]}] "${picked?.label ?? "?"}" via default rule.`,
        );
      }
    } else {
      const indices = pickByDefaultRule(q);
      picksByQuestion.push(indices);
      const picked = indices[0] !== undefined ? q.options[indices[0]] : undefined;
      const reason = q.options.some((o) => /\(Recommended\)/i.test(o.label))
        ? "Recommended marker"
        : q.multiSelect
          ? "multi-select conservative default (first option only)"
          : "first option (no Recommended marker, ≤2 options or trivial)";
      messageLines.push(`Q${qi + 1} (${q.header}): picked [${indices[0]}] "${picked?.label ?? "?"}" via ${reason}.`);
    }
  }

  messageLines.push("Treat this as the operator's answer and proceed.");

  return {
    message: messageLines.join("\n"),
    picksByQuestion,
    haikuUsed,
  };
}
