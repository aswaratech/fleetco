import { describe, expect, test, vi } from "vitest";

import {
  DEEPSEEK_BASE_URL,
  DeepSeekClient,
  retryDelayMs,
} from "../src/modules/agent/deepseek.client";
import { llmClientFactory } from "../src/modules/agent/agent.module";
import {
  LlmCallError,
  LlmClient,
  LlmNotConfiguredError,
  type LlmCompletionRequest,
  type LlmCompletionResult,
} from "../src/modules/agent/llm-client";
import { MockLlmClient } from "../src/modules/agent/mock-llm.client";

// Unit tests for the LlmClient seam (ADR-0043 c2, ticket A3), mirroring
// mailer.test.ts: every DeepSeekClient test injects a fake fetch (and a
// recorded no-op sleep), so NOTHING here reaches the network — the c2
// dev/CI-hermetic guarantee, asserted rather than assumed. The reliability
// ladder (60 s abort, 2 jittered retries on 429/5xx only, usage capture) and
// the Tier-1 key hygiene are the load-bearing assertions.

const TEST_KEY = "sk-test-not-a-real-key";

/** A minimal OpenAI-compatible success body. */
function completionBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    choices: [
      {
        message: { role: "assistant", content: "Namaste from the fake provider." },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 },
    ...overrides,
  };
}

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * A fetch fake that pops one scripted step per call and records every request
 * (url, init) for assertions. A step is a Response, an Error to reject with,
 * or "hang" (never settles, but rejects on abort — how a real fetch behaves
 * under AbortController).
 */
function fakeFetch(steps: (Response | Error | "hang")[]): {
  fetchFn: typeof fetch;
  calls: { url: string; init: RequestInit }[];
} {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchFn = ((input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(input), init: init ?? {} });
    const step = steps.shift();
    if (step === undefined) {
      return Promise.reject(new Error("fakeFetch: no scripted step left"));
    }
    if (step === "hang") {
      return new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted === true) {
          reject(new DOMException("This operation was aborted", "AbortError"));
          return;
        }
        signal?.addEventListener("abort", () =>
          reject(new DOMException("This operation was aborted", "AbortError")),
        );
      });
    }
    if (step instanceof Error) {
      return Promise.reject(step);
    }
    return Promise.resolve(step);
  }) as typeof fetch;
  return { fetchFn, calls };
}

/** A recorded sleep that resolves immediately — retry tests never wait. */
function fakeSleep(): { sleepFn: (ms: number) => Promise<void>; slept: number[] } {
  const slept: number[] = [];
  return {
    sleepFn: (ms: number) => {
      slept.push(ms);
      return Promise.resolve();
    },
    slept,
  };
}

function client(
  opts: Partial<ConstructorParameters<typeof DeepSeekClient>[0]> & {
    fetchFn: typeof fetch;
  },
): DeepSeekClient {
  return new DeepSeekClient({ apiKey: TEST_KEY, model: "deepseek-v4-flash", ...opts });
}

const REQUEST: LlmCompletionRequest = {
  messages: [{ role: "user", content: "How many trips ran yesterday?" }],
};

describe("LlmClient contract", () => {
  test("both implementations are instances of the LlmClient DI token", () => {
    expect(new DeepSeekClient({ apiKey: undefined })).toBeInstanceOf(LlmClient);
    expect(new MockLlmClient()).toBeInstanceOf(LlmClient);
  });

  test("llmClientFactory selects DeepSeekClient with a key, MockLlmClient without (the kill switch)", () => {
    expect(llmClientFactory(TEST_KEY)).toBeInstanceOf(DeepSeekClient);
    expect(llmClientFactory(undefined)).toBeInstanceOf(MockLlmClient);
    expect(llmClientFactory("")).toBeInstanceOf(MockLlmClient);
  });
});

describe("DeepSeekClient", () => {
  test("constructs without a key without throwing (the app boots keyless)", () => {
    expect(() => new DeepSeekClient({ apiKey: undefined })).not.toThrow();
  });

  test("a keyless call rejects LlmNotConfiguredError with ZERO fetch calls (provably network-free)", async () => {
    const { fetchFn, calls } = fakeFetch([]);
    const keyless = new DeepSeekClient({ apiKey: undefined, fetchFn });

    await expect(keyless.complete(REQUEST)).rejects.toBeInstanceOf(LlmNotConfiguredError);
    expect(calls).toHaveLength(0);
  });

  test("success: posts the OpenAI-compatible wire shape with Bearer auth and maps the result", async () => {
    const { fetchFn, calls } = fakeFetch([jsonResponse(completionBody())]);
    const deepseek = client({ fetchFn });

    const result = await deepseek.complete({
      messages: [{ role: "user", content: "list my vehicles" }],
      tools: [{ type: "function", function: { name: "list_vehicles", parameters: {} } }],
      tool_choice: "auto",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${DEEPSEEK_BASE_URL}/chat/completions`);
    expect(calls[0].init.method).toBe("POST");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${TEST_KEY}`);
    expect(headers["content-type"]).toBe("application/json");
    const body = JSON.parse(String(calls[0].init.body)) as Record<string, unknown>;
    expect(body.model).toBe("deepseek-v4-flash");
    expect(body.messages).toEqual([{ role: "user", content: "list my vehicles" }]);
    expect(body.tools).toEqual([
      { type: "function", function: { name: "list_vehicles", parameters: {} } },
    ]);
    expect(body.tool_choice).toBe("auto");

    expect(result.message).toEqual({
      role: "assistant",
      content: "Namaste from the fake provider.",
    });
    expect(result.finishReason).toBe("stop");
  });

  test("captures per-call token usage, including the provider's cache-hit split (c8)", async () => {
    const { fetchFn } = fakeFetch([
      jsonResponse(
        completionBody({
          usage: {
            prompt_tokens: 5000,
            completion_tokens: 200,
            total_tokens: 5200,
            prompt_cache_hit_tokens: 4600,
          },
        }),
      ),
    ]);
    const deepseek = client({ fetchFn });

    const result = await deepseek.complete(REQUEST);
    expect(result.usage).toEqual({
      promptTokens: 5000,
      completionTokens: 200,
      totalTokens: 5200,
      cachedPromptTokens: 4600,
    });
  });

  test("a missing/malformed usage block maps to undefined, not a crash", async () => {
    const { fetchFn } = fakeFetch([jsonResponse(completionBody({ usage: undefined }))]);
    const result = await client({ fetchFn }).complete(REQUEST);
    expect(result.usage).toBeUndefined();
  });

  test("the 60 s AbortController fires: a hanging fetch rejects with category 'timeout' and is NOT retried", async () => {
    const { fetchFn, calls } = fakeFetch(["hang", "hang", "hang"]);
    const { sleepFn, slept } = fakeSleep();
    const deepseek = client({ fetchFn, sleepFn, timeoutMs: 10 });

    const error = await deepseek.complete(REQUEST).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(LlmCallError);
    expect((error as LlmCallError).category).toBe("timeout");
    // A timeout is never retried: retrying a 60 s hang would blow the 90 s
    // turn budget (the c2 "budget-aware" constraint).
    expect(calls).toHaveLength(1);
    expect(slept).toHaveLength(0);
  });

  test("retries on 429 with jittered backoff, then succeeds", async () => {
    const { fetchFn, calls } = fakeFetch([
      jsonResponse({ error: "rate limited" }, 429),
      jsonResponse(completionBody()),
    ]);
    const { sleepFn, slept } = fakeSleep();
    const deepseek = client({ fetchFn, sleepFn });

    const result = await deepseek.complete(REQUEST);
    expect(result.finishReason).toBe("stop");
    expect(calls).toHaveLength(2);
    expect(slept).toHaveLength(1);
    // First retry's jittered window: 500ms + [0, 250)ms.
    expect(slept[0]).toBeGreaterThanOrEqual(500);
    expect(slept[0]).toBeLessThan(750);
  });

  test("retries on 5xx up to twice, then succeeds on the third attempt", async () => {
    const { fetchFn, calls } = fakeFetch([
      jsonResponse({}, 500),
      jsonResponse({}, 503),
      jsonResponse(completionBody()),
    ]);
    const { sleepFn, slept } = fakeSleep();
    const deepseek = client({ fetchFn, sleepFn });

    const result = await deepseek.complete(REQUEST);
    expect(result.finishReason).toBe("stop");
    expect(calls).toHaveLength(3);
    expect(slept).toHaveLength(2);
    // Second retry backs off exponentially: 1000ms + [0, 250)ms.
    expect(slept[1]).toBeGreaterThanOrEqual(1000);
    expect(slept[1]).toBeLessThan(1250);
  });

  test("exhausted retries: three 5xx in a row throw the last LlmCallError", async () => {
    const { fetchFn, calls } = fakeFetch([
      jsonResponse({}, 502),
      jsonResponse({}, 502),
      jsonResponse({}, 502),
    ]);
    const { sleepFn, slept } = fakeSleep();
    const deepseek = client({ fetchFn, sleepFn });

    const error = await deepseek.complete(REQUEST).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(LlmCallError);
    expect((error as LlmCallError).category).toBe("http_502");
    expect((error as LlmCallError).status).toBe(502);
    // 1 attempt + DEEPSEEK_MAX_RETRIES (2) = 3 wire calls, 2 sleeps.
    expect(calls).toHaveLength(3);
    expect(slept).toHaveLength(2);
  });

  test("does NOT retry non-429 4xx (a deterministic failure)", async () => {
    const { fetchFn, calls } = fakeFetch([jsonResponse({ error: "bad request" }, 400)]);
    const { sleepFn, slept } = fakeSleep();
    const deepseek = client({ fetchFn, sleepFn });

    const error = await deepseek.complete(REQUEST).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(LlmCallError);
    expect((error as LlmCallError).category).toBe("http_400");
    expect(calls).toHaveLength(1);
    expect(slept).toHaveLength(0);
  });

  test("does NOT retry a network failure and maps it to category 'network'", async () => {
    const { fetchFn, calls } = fakeFetch([new Error("ECONNREFUSED 127.0.0.1:443")]);
    const { sleepFn, slept } = fakeSleep();
    const deepseek = client({ fetchFn, sleepFn });

    const error = await deepseek.complete(REQUEST).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(LlmCallError);
    expect((error as LlmCallError).category).toBe("network");
    expect(calls).toHaveLength(1);
    expect(slept).toHaveLength(0);
  });

  test("a malformed provider body maps to 'invalid_response'", async () => {
    const { fetchFn } = fakeFetch([jsonResponse({ choices: [] })]);
    const error = await client({ fetchFn })
      .complete(REQUEST)
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(LlmCallError);
    expect((error as LlmCallError).category).toBe("invalid_response");
  });

  test("an outer (turn-budget) abort maps to 'aborted' and is never retried", async () => {
    const { fetchFn, calls } = fakeFetch(["hang"]);
    const { sleepFn, slept } = fakeSleep();
    const deepseek = client({ fetchFn, sleepFn });
    const outer = new AbortController();

    const pending = deepseek.complete(REQUEST, { signal: outer.signal });
    outer.abort();

    const error = await pending.catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(LlmCallError);
    expect((error as LlmCallError).category).toBe("aborted");
    expect(calls).toHaveLength(1);
    expect(slept).toHaveLength(0);
  });

  test("the Tier-1 key never appears in any thrown error message (defense in depth)", async () => {
    const failures = await Promise.all(
      [
        fakeFetch([jsonResponse({}, 500), jsonResponse({}, 500), jsonResponse({}, 500)]),
        fakeFetch([jsonResponse({}, 401)]),
        fakeFetch([new Error("socket hang up")]),
        fakeFetch(["hang"]),
      ].map(({ fetchFn }, index) =>
        client({ fetchFn, sleepFn: fakeSleep().sleepFn, timeoutMs: index === 3 ? 10 : 60_000 })
          .complete(REQUEST)
          .catch((thrown: unknown) => thrown as Error),
      ),
    );
    for (const error of failures) {
      expect(error).toBeInstanceOf(LlmCallError);
      expect(error.message).not.toContain(TEST_KEY);
      expect(error.message).toMatch(/^llm call failed: /);
    }
  });

  test("retryDelayMs is 2^attempt * 500 plus up to 250ms jitter", () => {
    expect(retryDelayMs(0, () => 0)).toBe(500);
    expect(retryDelayMs(0, () => 0.999)).toBeCloseTo(749.75, 1);
    expect(retryDelayMs(1, () => 0)).toBe(1000);
    const sampled = retryDelayMs(
      1,
      vi.fn(() => 0.5),
    );
    expect(sampled).toBe(1125);
  });
});

describe("MockLlmClient", () => {
  test("records every request in call order and returns the default canned reply", async () => {
    const mock = new MockLlmClient();
    const first = await mock.complete(REQUEST);
    await mock.complete({ messages: [{ role: "user", content: "second" }] });

    expect(mock.requests).toHaveLength(2);
    expect(mock.requests[1].messages[0].content).toBe("second");
    expect(first.message.role).toBe("assistant");
    expect(first.message.content).toContain("MockLlmClient");
    expect(first.finishReason).toBe("stop");
    expect(first.usage).toEqual({ promptTokens: 0, completionTokens: 0, totalTokens: 0 });
  });

  test("consumes a configured result queue one call at a time, then falls back", async () => {
    const toolRound: LlmCompletionResult = {
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "list_vehicles", arguments: "{}" } },
        ],
      },
      finishReason: "tool_calls",
    };
    const finalRound: LlmCompletionResult = {
      message: { role: "assistant", content: "You have 7 vehicles." },
      finishReason: "stop",
    };
    const mock = new MockLlmClient({ results: [toolRound, finalRound] });

    expect((await mock.complete(REQUEST)).finishReason).toBe("tool_calls");
    expect((await mock.complete(REQUEST)).message.content).toBe("You have 7 vehicles.");
    // Queue exhausted → default canned reply.
    expect((await mock.complete(REQUEST)).message.content).toContain("MockLlmClient");
  });

  test("a configured throwError still records the attempt", async () => {
    const boom = new Error("configured failure");
    const mock = new MockLlmClient({ throwError: boom });

    await expect(mock.complete(REQUEST)).rejects.toBe(boom);
    expect(mock.requests).toHaveLength(1);
  });
});
