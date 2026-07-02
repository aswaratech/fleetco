import { LlmClient, type LlmCompletionRequest, type LlmCompletionResult } from "./llm-client";

/**
 * An in-memory, no-network {@link LlmClient} — the MockMailer of the agent
 * seam (ADR-0043 commitment 2, ticket A3). It never opens a socket, so it has
 * two roles:
 *
 *   1. The dev / test / CI default the module factory binds whenever
 *      `DEEPSEEK_API_KEY` is unset — which is also the PRODUCTION KILL
 *      SWITCH: unset the key, restart, and the agent answers from this mock
 *      instead of reaching the provider (c2).
 *   2. A test double for the A5 loop: it RECORDS every request in
 *      {@link requests} (assert against it), and can be configured with a
 *      QUEUE of results (a multi-round tool loop in one test), a single
 *      repeating result, or a thrown error.
 */
export class MockLlmClient extends LlmClient {
  /** Every request passed to {@link complete}, in call order. */
  readonly requests: LlmCompletionRequest[] = [];

  private readonly queue: LlmCompletionResult[];

  /**
   * @param behavior.results    A queue consumed one per call (multi-round
   *                            loops); when exhausted, falls back to `result`
   *                            / the default.
   * @param behavior.result     The result every call resolves with once the
   *                            queue is empty.
   * @param behavior.throwError If set, {@link complete} records the call and
   *                            then rejects with it — the failure path with
   *                            no network.
   */
  constructor(
    private readonly behavior: {
      results?: LlmCompletionResult[];
      result?: LlmCompletionResult;
      throwError?: Error;
    } = {},
  ) {
    super();
    this.queue = [...(behavior.results ?? [])];
  }

  complete(request: LlmCompletionRequest): Promise<LlmCompletionResult> {
    this.requests.push(request);
    if (this.behavior.throwError !== undefined) {
      return Promise.reject(this.behavior.throwError);
    }
    const queued = this.queue.shift();
    if (queued !== undefined) {
      return Promise.resolve(queued);
    }
    return Promise.resolve(
      this.behavior.result ?? {
        message: {
          role: "assistant",
          content:
            "MockLlmClient reply (no DEEPSEEK_API_KEY configured — the agent is " +
            "running without a hosted LLM; see ADR-0043 c2).",
        },
        finishReason: "stop",
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      },
    );
  }
}
