import { Module } from "@nestjs/common";

import { env } from "../../config/env";
import { AuthModule } from "../auth/auth.module";
import { StorageModule } from "../storage/storage.module";
import { AgentController } from "./agent.controller";
import { AgentAttachmentsService } from "./agent-attachments.service";
import { AgentService } from "./agent.service";
import { AgentToolsModule } from "./agent-tools.module";
import { DeepSeekClient } from "./deepseek.client";
import { LlmClient } from "./llm-client";
import { MockLlmClient } from "./mock-llm.client";

// AgentModule — the AI chat agent concern (ADR-0043). A3 gave it the
// provider-agnostic LlmClient DI seam; A5 (this ticket) composes that seam
// with the A4 tool registry into the agent loop (AgentService), exposes the
// conversation/turn endpoints (AgentController, `agent:use`-gated), and wires
// AgentToolsModule into the app graph — the registration A4 deliberately left
// out so the two parallel branches would merge here, not in git. The chat UI
// (A6) consumes these endpoints.
//
// AuthModule is imported (the geofences precedent) so the AUTH provider,
// AuthGuard, AND RolesGuard are available to the controller's composed
// `@UseGuards(AuthGuard, RolesGuard)` chain at request time.
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
  // StorageModule (ADR-0044 V4): the attachment upload/download paths store
  // and fetch bytes through the shared ObjectStorage seam.
  imports: [AuthModule, AgentToolsModule, StorageModule],
  controllers: [AgentController],
  providers: [
    {
      provide: LlmClient,
      useFactory: (): LlmClient => llmClientFactory(env.DEEPSEEK_API_KEY),
    },
    AgentService,
    AgentAttachmentsService,
  ],
  exports: [LlmClient],
})
export class AgentModule {}
