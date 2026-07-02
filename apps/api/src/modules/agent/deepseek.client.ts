import { env } from "../../config/env";
import {
  LlmCallError,
  LlmClient,
  LlmNotConfiguredError,
  type LlmCompletionRequest,
  type LlmCompletionResult,
  type LlmMessage,
  type LlmUsage,
} from "./llm-client";

// The DeepSeek implementation of the FleetCo {@link LlmClient} seam (ADR-0043
// commitment 2, ticket A3). This is the ONLY file in the API that names the
// provider or its endpoint. It is RAW `fetch` — zero new dependencies, per
// c2's explicit commitment: DeepSeek's API is OpenAI-compatible
// (`POST /chat/completions`, Bearer auth, `tools`/`tool_choice`), so an SDK
// would buy nothing and would blur the provider abstraction. A later swap to
// any OpenAI-compatible provider is a sibling file next to this one.
//
// Reliability contract (c2, all pinned by tests with an injected fetch):
//   • 60 s per-call AbortController timeout — nests strictly inside the A5
//     turn's 90 s wall-clock (c4d); a caller-supplied outer signal (the turn
//     budget) also aborts the in-flight call.
//   • Up to 2 jittered retries on 429/5xx ONLY. A timeout or outer abort is
//     NEVER retried (a retried 60 s timeout would blow the 90 s turn budget —
//     the budget-awareness the commitment names), and non-429 4xx are
//     deterministic failures where a retry only adds cost.
//   • Token usage captured per call (c8) — the A5 loop persists it on the
//     AgentMessage row.
//
// The API key is Tier 1 (ADR-0013): read once from the typed env (or an
// explicit test override), placed ONLY in the Authorization header, never
// logged, never embedded in any thrown error (LlmCallError carries a bare
// category; the response body is never attached either — it can echo prompt
// content, Tier 2 per c6).

/** DeepSeek's OpenAI-compatible API base (verified 2026-07-02, ADR-0043). */
export const DEEPSEEK_BASE_URL = "https://api.deepseek.com";

/** Per-call timeout (ADR-0043 c2/c4d — nests inside the 90 s turn budget). */
export const DEEPSEEK_CALL_TIMEOUT_MS = 60_000;

/** Max retries after the first attempt, on 429/5xx only (ADR-0043 c2). */
export const DEEPSEEK_MAX_RETRIES = 2;

/**
 * Jittered exponential backoff before retry `attempt` (0-based): 500–750 ms
 * before the first retry, 1000–1250 ms before the second. Small on purpose —
 * the whole call chain must fit the 90 s turn budget.
 */
export function retryDelayMs(attempt: number, random: () => number = Math.random): number {
  return 2 ** attempt * 500 + random() * 250;
}

// Abort-reason sentinels so the catch block can tell the per-call timeout
// apart from the caller's turn-budget abort without string matching.
const TIMEOUT_SENTINEL = Symbol("deepseek-call-timeout");
const OUTER_ABORT_SENTINEL = Symbol("deepseek-outer-abort");

/**
 * The provider's response shape, reduced to the slice this client reads.
 * Structural — extra fields are ignored; missing ones throw
 * `invalid_response`.
 */
interface DeepSeekCompletionResponse {
  choices?: {
    message?: LlmMessage;
    finish_reason?: string;
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_cache_hit_tokens?: number;
  };
}

export class DeepSeekClient extends LlmClient {
  private readonly apiKey: string | null;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  /**
   * @param opts.apiKey    Overrides `env.DEEPSEEK_API_KEY` (tests pass an
   *                       explicit value, or `undefined` to force the no-key
   *                       path regardless of ambient env — the ResendMailer
   *                       `"apiKey" in opts` pattern).
   * @param opts.model     Overrides `env.DEEPSEEK_MODEL`.
   * @param opts.baseUrl   Overrides {@link DEEPSEEK_BASE_URL} (tests only).
   * @param opts.fetchFn   Injects a fetch so the wire mapping, timeout, and
   *                       retry ladder are exercised with no network — the
   *                       `client` seam from resend.mailer.ts, one layer down.
   * @param opts.sleepFn   Injects the backoff sleep so retry tests never
   *                       wall-clock wait.
   * @param opts.timeoutMs Overrides the 60 s per-call abort (tests use ~10 ms).
   */
  constructor(opts?: {
    apiKey?: string;
    model?: string;
    baseUrl?: string;
    fetchFn?: typeof fetch;
    sleepFn?: (ms: number) => Promise<void>;
    timeoutMs?: number;
    maxRetries?: number;
  }) {
    super();
    const apiKey = opts !== undefined && "apiKey" in opts ? opts.apiKey : env.DEEPSEEK_API_KEY;
    this.apiKey = apiKey !== undefined && apiKey !== "" ? apiKey : null;
    this.model = opts?.model ?? env.DEEPSEEK_MODEL;
    this.baseUrl = opts?.baseUrl ?? DEEPSEEK_BASE_URL;
    // Wrap the global fetch in an arrow so it keeps its own `this` (calling an
    // unbound fetch reference throws "Illegal invocation" on some runtimes).
    this.fetchFn = opts?.fetchFn ?? ((input, init) => fetch(input, init));
    this.sleepFn = opts?.sleepFn ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.timeoutMs = opts?.timeoutMs ?? DEEPSEEK_CALL_TIMEOUT_MS;
    this.maxRetries = opts?.maxRetries ?? DEEPSEEK_MAX_RETRIES;
  }

  async complete(
    request: LlmCompletionRequest,
    opts?: { signal?: AbortSignal },
  ): Promise<LlmCompletionResult> {
    if (this.apiKey === null) {
      throw new LlmNotConfiguredError(
        "DEEPSEEK_API_KEY is not configured; the agent cannot call the hosted LLM. " +
          "Unset is the deliberate dev/test/CI state AND the production kill switch " +
          "(ADR-0043 c2) — the DI factory binds MockLlmClient in that case, so reaching " +
          "this error means a DeepSeekClient was constructed directly without a key.",
      );
    }

    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.attemptOnce(request, opts?.signal);
      } catch (error) {
        const retryable =
          error instanceof LlmCallError &&
          error.status !== undefined &&
          (error.status === 429 || error.status >= 500);
        const outerAborted = opts?.signal?.aborted === true;
        if (!retryable || attempt >= this.maxRetries || outerAborted) {
          throw error;
        }
        await this.sleepFn(retryDelayMs(attempt));
      }
    }
  }

  /** One wire attempt: build the abort chain, POST, map the response. */
  private async attemptOnce(
    request: LlmCompletionRequest,
    outerSignal: AbortSignal | undefined,
  ): Promise<LlmCompletionResult> {
    // Per-call timeout, combined with the caller's turn-budget signal: either
    // firing aborts the in-flight fetch. Listener + timer are cleaned up in
    // `finally` so a completed call leaks neither.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(TIMEOUT_SENTINEL), this.timeoutMs);
    const onOuterAbort = (): void => controller.abort(OUTER_ABORT_SENTINEL);
    outerSignal?.addEventListener("abort", onOuterAbort, { once: true });
    if (outerSignal?.aborted === true) {
      controller.abort(OUTER_ABORT_SENTINEL);
    }

    try {
      let response: Response;
      try {
        response = await this.fetchFn(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            // The Tier-1 key's ONLY appearance. Never logged, never thrown.
            authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({
            model: this.model,
            messages: request.messages,
            ...(request.tools !== undefined ? { tools: request.tools } : {}),
            ...(request.tool_choice !== undefined ? { tool_choice: request.tool_choice } : {}),
          }),
          signal: controller.signal,
        });
      } catch (error) {
        // Distinguish OUR aborts (timeout / turn budget — carried via the
        // abort reason sentinels) from genuine transport failures. None of
        // these are retryable except via the 429/5xx path, which they are not.
        if (controller.signal.aborted) {
          const category = controller.signal.reason === TIMEOUT_SENTINEL ? "timeout" : "aborted";
          throw new LlmCallError(category, { cause: error });
        }
        throw new LlmCallError("network", { cause: error });
      }

      if (!response.ok) {
        // Carry the status (drives the retry ladder) and the bare category —
        // NEVER the response body, which can echo prompt content (Tier 2).
        throw new LlmCallError(`http_${response.status}`, { status: response.status });
      }

      let parsed: DeepSeekCompletionResponse;
      try {
        parsed = (await response.json()) as DeepSeekCompletionResponse;
      } catch (error) {
        throw new LlmCallError("invalid_response", { cause: error });
      }

      const choice = parsed.choices?.[0];
      if (choice?.message === undefined || typeof choice.finish_reason !== "string") {
        throw new LlmCallError("invalid_response");
      }

      return {
        message: choice.message,
        finishReason: choice.finish_reason,
        usage: mapUsage(parsed.usage),
      };
    } finally {
      clearTimeout(timer);
      outerSignal?.removeEventListener("abort", onOuterAbort);
    }
  }
}

/** Map the provider's snake_case usage block to {@link LlmUsage}. */
function mapUsage(usage: DeepSeekCompletionResponse["usage"]): LlmUsage | undefined {
  if (
    usage === undefined ||
    typeof usage.prompt_tokens !== "number" ||
    typeof usage.completion_tokens !== "number" ||
    typeof usage.total_tokens !== "number"
  ) {
    return undefined;
  }
  return {
    promptTokens: usage.prompt_tokens,
    completionTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens,
    ...(typeof usage.prompt_cache_hit_tokens === "number"
      ? { cachedPromptTokens: usage.prompt_cache_hit_tokens }
      : {}),
  };
}
