import { Module } from "@nestjs/common";

import { env } from "../../config/env";
import { DeepSeekClient } from "./deepseek.client";
import { LlmClient } from "./llm-client";
import { MockLlmClient } from "./mock-llm.client";

// AgentModule — the AI chat agent concern (ADR-0043; module scaffold lands
// with ticket A3). As of A3 it owns exactly one thing: the provider-agnostic
// LlmClient DI seam. The tool registry (A4, a sibling module file), the agent
// loop + endpoints + `agent:use` gate (A5), and the chat UI (A6) grow from
// here.
//
// THE LLM DI (ADR-0043 c2), mirroring NotificationModule's Mailer factory:
// the abstract `LlmClient` token resolves to DeepSeekClient only when the
// operator has supplied DEEPSEEK_API_KEY, and to the no-network MockLlmClient
// everywhere the key is absent (dev / test / CI) — so the API never reaches
// the hosted provider outside production, and UNSETTING the key in production
// is the agent's kill switch. The selection lives in the exported
// `llmClientFactory` (explicit-argument, deterministic) so the choice is
// unit-testable regardless of ambient env; the module wires it to the typed
// env exactly as the Mailer factory reads RESEND_API_KEY.

/**
 * Choose the LlmClient implementation for a given key value. Exported for the
 * deterministic factory-selection test; the module applies it to
 * `env.DEEPSEEK_API_KEY`.
 */
export function llmClientFactory(apiKey: string | undefined): LlmClient {
  return apiKey !== undefined && apiKey !== ""
    ? new DeepSeekClient({ apiKey })
    : new MockLlmClient();
}

@Module({
  providers: [
    {
      provide: LlmClient,
      useFactory: (): LlmClient => llmClientFactory(env.DEEPSEEK_API_KEY),
    },
  ],
  exports: [LlmClient],
})
export class AgentModule {}
