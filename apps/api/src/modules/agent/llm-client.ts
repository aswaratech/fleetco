// The FleetCo-owned LLM seam (ADR-0043 commitment 2, ticket A3). This is the
// ONE place the rest of the API talks to "a chat completion": the A5 agent
// loop depends only on this `LlmClient` contract and the OpenAI-compatible
// message/tool shapes below — never on a vendor. The concrete provider
// (DeepSeek today, per ADR-0043 c2) is named in exactly one implementation
// file, `deepseek.client.ts`, so a later swap to any OpenAI-compatible
// provider is a ~200-line adapter and nothing that calls `complete` changes.
// This mirrors the Mailer seam (apps/api/src/modules/notifications/mailer.ts)
// file-for-file: own the seam, isolate the vendor.
//
// WHY AN ABSTRACT CLASS, NOT A BARE `interface`: NestJS resolves providers by
// a runtime token, and a TypeScript `interface` does not exist at runtime. An
// abstract class is BOTH the compile-time contract AND a runtime DI token, so
// the module wires `{ provide: LlmClient, useFactory: ... }` and consumers
// inject `constructor(private readonly llm: LlmClient)` — the exact Mailer
// pattern, not a new architectural one.
//
// The wire shapes are the OpenAI-compatible `/chat/completions` contract
// (verified against DeepSeek's docs at ADR-0043 acceptance, 2026-07-02):
// snake_case field names (`tool_calls`, `tool_call_id`) are kept VERBATIM so
// messages round-trip through the provider without a mapping layer, and the
// A4 tool registry's generated `{ type: "function", function: {...} }` specs
// slot into `tools` unchanged.

/** A chat role in the OpenAI-compatible message array. */
export type LlmRole = "system" | "user" | "assistant" | "tool";

/**
 * A tool invocation the model requested (rides an assistant message).
 * `function.arguments` is the model's RAW JSON string — the A4/A5 layers parse
 * and Zod-validate it server-side before anything executes (ADR-0043 c2).
 */
export interface LlmToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/**
 * One message in the conversation, in the provider wire shape. Transcript
 * content is Tier 2 per ADR-0043 c6 — never logged (the `*.content` pino
 * redact path is the backstop), never placed on a span.
 */
export interface LlmMessage {
  role: LlmRole;
  /** Null happens on assistant messages that carry only tool_calls. */
  content: string | null;
  /** Present on assistant messages that request tool executions. */
  tool_calls?: LlmToolCall[];
  /** Present on tool-role messages: which call this result answers. */
  tool_call_id?: string;
}

/**
 * A tool the model may call, in the OpenAI-compatible `tools` array shape.
 * `parameters` is a JSON Schema object — produced by the A4 registry via
 * zod 4's `z.toJSONSchema` from the agent-owned wrapper schemas.
 */
export interface LlmToolSpec {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

/** One completion request. The A5 loop builds these; budgets live there too. */
export interface LlmCompletionRequest {
  messages: LlmMessage[];
  tools?: LlmToolSpec[];
  tool_choice?: "auto" | "none" | "required";
}

/**
 * Per-call token usage (ADR-0043 c8: usage is recorded per message — the cost
 * envelope reads from the persisted numbers). `cachedPromptTokens` maps the
 * provider's prompt-cache-hit count when reported (DeepSeek's cache-hit
 * pricing is ~50x cheaper, so the split is worth keeping).
 */
export interface LlmUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedPromptTokens?: number;
}

/** The result of one completion call. */
export interface LlmCompletionResult {
  /** The assistant message the model produced (text and/or tool_calls). */
  message: LlmMessage;
  /** The provider's finish reason ("stop", "tool_calls", "length", …). */
  finishReason: string;
  /** Token usage for THIS call, when the provider reports it. */
  usage?: LlmUsage;
}

/**
 * The LLM port. One method. The agent loop depends on this — not on any
 * vendor. See the file header for why this is an abstract class.
 */
export abstract class LlmClient {
  /**
   * Run one chat completion. Resolves with the assistant's message on
   * success; REJECTS (never swallows) on failure so the A5 loop can persist
   * the failed `AgentAction`/turn state truthfully. Implementations throw
   * {@link LlmNotConfiguredError} when no provider credential is configured
   * and {@link LlmCallError} on provider/transport failures.
   *
   * `opts.signal` is the caller's outer abort (the A5 turn budget, ADR-0043
   * c4d: the 60 s per-call abort nests strictly inside the 90 s turn
   * wall-clock) — when it fires, the in-flight call aborts and NO retry is
   * attempted.
   */
  abstract complete(
    request: LlmCompletionRequest,
    opts?: { signal?: AbortSignal },
  ): Promise<LlmCompletionResult>;
}

/**
 * Thrown when a real completion is attempted but no provider credential is
 * configured (`DEEPSEEK_API_KEY` unset). The DI factory binds MockLlmClient
 * in that case, so in practice this fires only when a DeepSeekClient is
 * constructed directly without a key — the same loud-not-silent guard as
 * MailerNotConfiguredError, and the reason the no-key path is provably
 * network-free.
 */
export class LlmNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmNotConfiguredError";
  }
}

/**
 * Thrown when the provider call fails. The message carries only a transport
 * CATEGORY ("timeout", "aborted", "network", "http_429", "http_500",
 * "invalid_response") — NEVER the provider's response body (which can echo
 * prompt content, Tier 2 per ADR-0043 c6) and NEVER any header (the API key
 * is Tier 1). The original error is attached as `cause` for a local stack
 * trace and is never logged.
 */
export class LlmCallError extends Error {
  constructor(
    /** The PII-free failure category. */
    readonly category: string,
    options?: { cause?: unknown; status?: number },
  ) {
    super(`llm call failed: ${category}`, { cause: options?.cause });
    this.name = "LlmCallError";
    this.status = options?.status;
  }

  /** The HTTP status when the failure was an HTTP error response. */
  readonly status?: number;
}
