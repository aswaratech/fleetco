import { z } from "zod";

import { type Capability } from "../../auth/permissions";
import { type Actor } from "../../auth/driver-scope.service";

// The tool declaration contract for the AI agent's registry (ADR-0043
// commitments 1–3, ticket A4). Every tool file under tools/ exports a plain
// builder function returning ToolDefinition[]; the registry composes them,
// generates each JSON schema at boot, and enforces the pipeline
// (capability → validate → execute-as-actor → redact) on dispatch.

/**
 * The risk tier a tool declares (ADR-0043 c3). Stage one (A4) ships ONLY
 * `read` tools; `reversible-write` arrives with the A7/A8 create/update
 * tools. Deletes and invoice operations have no tier — they are structurally
 * absent from the registry (c3).
 */
export type ToolRiskTier = "read" | "reversible-write";

/**
 * DeepSeek's function-name constraint (OpenAI-compatible): 1–64 chars of
 * [a-zA-Z0-9_-]; FleetCo pins snake_case. Enforced at boot by the registry.
 */
export const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

/** DeepSeek's documented ceiling on the `tools` array (ADR-0043 c2). */
export const MAX_TOOL_COUNT = 128;

/**
 * One agent tool. `argsSchema` is the AGENT-OWNED, transform-free wrapper
 * schema (plain primitives, `z.iso.date()` strings, `.strict()`) — the
 * LLM-facing contract `z.toJSONSchema` can represent (ADR-0043 c2). It is
 * NOT the validation authority: `execute` re-validates through the owning
 * module's real `.strict()` schema before any service call, so the model can
 * never bypass the house validation layer.
 *
 * `execute` runs AS the requesting user (c1): the registry threads the real
 * `Actor`, and tools pass it to every service whose signature takes one
 * (trips / fuel-logs — the DRIVER row-scope inherited for free).
 */
export interface ToolDefinition {
  /** snake_case, unique, ≤64 chars (TOOL_NAME_PATTERN). */
  name: string;
  /**
   * LLM-facing description. States units explicitly — money is integer paisa
   * (1 NPR = 100 paisa), volume integer milliliters, engine hours integer
   * tenths-of-an-hour, dates ISO YYYY-MM-DD — so the model never guesses.
   */
  description: string;
  /**
   * The capability token(s) from auth/permissions.ts the requesting user's
   * role must hold — ALL of them (relevant for the composing fleet_snapshot
   * tool). Enforced by the registry BEFORE validation or dispatch, via the
   * same `roleHasCapability` the RolesGuard uses.
   */
  capabilities: readonly Capability[];
  riskTier: ToolRiskTier;
  /** The transform-free wrapper schema (see above). */
  argsSchema: z.ZodType;
  /**
   * Run the tool. `args` has already passed the wrapper schema at the
   * registry seam; implementations re-parse defensively (cheap, and keeps a
   * directly-invoked tool safe in tests) and then re-validate through the
   * owning module's schema where one exists.
   */
  execute(args: unknown, actor: Actor): Promise<unknown>;
}

/**
 * The OpenAI-compatible wire shape for one tool, as DeepSeek's `tools` array
 * expects it. `parameters` is the JSON Schema the registry generates at boot
 * via `z.toJSONSchema`. Kept structurally loose (a plain record) so A5 can
 * hand `listToolDefinitions()` output straight to the A3 LlmClient's
 * request without an adapter — the two branches deliberately do NOT share a
 * type file (they merge at A5).
 */
export interface LlmToolSpec {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/**
 * The shared get-by-id wrapper. There is no module schema for path params
 * (controllers take a raw `@Param("id")` string), so this wrapper matches the
 * HTTP surface exactly and the service's own null/NotFound handling is the
 * authority — the honest reading of c2's "re-validate where the module has a
 * schema", stated rather than faked.
 */
export const GetByIdArgs = z
  .object({
    id: z.string().trim().min(1, "id is required."),
  })
  .strict();
