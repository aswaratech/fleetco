// Loop state file IO.
//
// state.json holds iteration counter, last PR, last merge SHA, retry counters.
// Persisted between iterations so a fresh `pnpm start` resumes mid-program if
// the loop process restarts.

import fs from "node:fs";
import { z } from "zod";
import { paths } from "./config.js";
import type { LoopState } from "./types.js";

const StateSchema = z.object({
  iteration: z.number().int().nonnegative(),
  lastPrNumber: z.number().int().positive().nullable(),
  lastMergedSha: z.string().nullable(),
  startedAt: z.string(),
  lastIterStartedAt: z.string().nullable(),
  rateLimitRetries: z.number().int().nonnegative(),
  programDoneSentinelSeen: z.boolean(),
});

export function loadState(): LoopState {
  if (!fs.existsSync(paths.stateFile)) {
    return initialState();
  }
  try {
    const raw = fs.readFileSync(paths.stateFile, "utf8");
    return StateSchema.parse(JSON.parse(raw));
  } catch {
    return initialState();
  }
}

export function saveState(state: LoopState): void {
  fs.writeFileSync(paths.stateFile, JSON.stringify(state, null, 2), "utf8");
}

export function initialState(): LoopState {
  return {
    iteration: 0,
    lastPrNumber: null,
    lastMergedSha: null,
    startedAt: new Date().toISOString(),
    lastIterStartedAt: null,
    rateLimitRetries: 0,
    programDoneSentinelSeen: false,
  };
}
