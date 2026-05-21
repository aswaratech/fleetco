// Clean shutdown: notify Slack + close any open iter log + process.exit.

import { appendDecision, closeIterLog } from "./logging.js";
import { notify } from "./slack-notify.js";
import type { MilestoneEvent } from "./types.js";

export async function halt(
  reason: string,
  exitCode: number,
  state: { iteration: number; pr?: number | null } = { iteration: 0, pr: null },
): Promise<never> {
  const event: MilestoneEvent = {
    milestone: exitCode === 0 ? "loop_halted" : "loop_error",
    iteration: state.iteration,
    ...(state.pr ? { pr: state.pr } : {}),
    details: reason,
  };
  appendDecision(event);
  await notify(event, `Loop halted: ${reason}`);
  closeIterLog();
  process.exit(exitCode);
}
