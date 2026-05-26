// Shared type definitions for the FleetCo orchestration loop.

export type Milestone =
  | "iteration_start"
  | "agent_invocation_start"
  | "auto_answer"
  | "destructive_bash_denied"
  | "rate_limit_wait"
  | "rate_limit_resume"
  | "rate_limit_cap_hit"
  | "agent_session_end"
  | "pr_opened"
  | "no_pr_detected"
  | "ci_poll_start"
  | "ci_green"
  | "ci_failed"
  | "ci_no_workflows"
  | "ci_timeout"
  | "pr_merged"
  | "next_prompt_extracted"
  | "next_prompt_missing"
  | "fabricated_preamble_stripped"
  | "stop_sentinel_detected"
  | "program_complete"
  | "loop_halted"
  | "loop_error";

export interface MilestoneEvent {
  milestone: Milestone;
  iteration: number;
  pr?: number;
  details?: string;
  // Free-form structured payload for logging (NOT for Slack — Slack gets short summary).
  payload?: Record<string, unknown>;
}

export interface LoopState {
  iteration: number;
  lastPrNumber: number | null;
  lastMergedSha: string | null;
  startedAt: string; // ISO timestamp
  lastIterStartedAt: string | null;
  rateLimitRetries: number; // resets each iteration
  programDoneSentinelSeen: boolean;
}

export interface ExtractedPrompt {
  prompt: string;
  // 1 = transcript heading anchor; 2 = transcript last fenced block;
  // 3 = PR-body re-run of tier-1/tier-2; 4 = Haiku fallback over transcript tail;
  // null = NONE (no prompt found by any tier).
  tier: 1 | 2 | 3 | 4 | null;
}

export interface FabricatedStripResult {
  cleaned: string;
  strippedBlocks: string[]; // each block that was removed
}

export interface PrDetectionResult {
  prNumber: number | null;
  source: "gh_pr_create_output" | "branch_fallback" | "none";
  branch?: string;
}

export interface RateLimitWaitInfo {
  resumesAt: Date;
  reason: string;
  source: "first_class_event" | "thrown_exception";
}

// What the agent SDK message stream gives us, narrowed to fields we use.
// We do not import the SDK types directly to keep the orchestrator decoupled
// from minor SDK type churn; we only read the fields we need.
export interface SdkMessageLike {
  type: string;
  subtype?: string;
  message?: unknown;
  uuid?: string;
  session_id?: string;
  [key: string]: unknown;
}

export interface AskUserQuestionInput {
  questions: {
    question: string;
    header: string;
    multiSelect: boolean;
    options: { label: string; description?: string }[];
  }[];
}

export interface AutoAnswerResult {
  // The answer payload that goes back to the agent as the denial message.
  message: string;
  // Which option indexes were picked, by question.
  picksByQuestion: number[][];
  // Whether Haiku was invoked for any question.
  haikuUsed: boolean;
}
