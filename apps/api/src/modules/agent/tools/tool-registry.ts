import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { type UserRole } from "@prisma/client";
import { z, ZodError } from "zod";

import { formatZodError, ZodValidationPipe } from "../../../common/zod-validation.pipe";
import { roleHasCapability } from "../../auth/permissions";
import { type Actor } from "../../auth/driver-scope.service";
import { redactForModel } from "../redact-for-model";
import { buildCustomersTools } from "./customers.tools";
import { buildDriversTools } from "./drivers.tools";
import { buildExpenseLogsTools } from "./expense-logs.tools";
import { buildFleetSnapshotTool } from "./fleet-snapshot.tool";
import { buildFuelLogsTools } from "./fuel-logs.tools";
import { buildGeofencesTools } from "./geofences.tools";
import { buildJobsTools } from "./jobs.tools";
import { buildMaintenanceTools } from "./maintenance.tools";
import { buildReportsTools } from "./reports.tools";
import { buildTripsTools } from "./trips.tools";
import { buildVehiclesTools } from "./vehicles.tools";
import {
  MAX_TOOL_COUNT,
  TOOL_NAME_PATTERN,
  type LlmToolSpec,
  type ToolDefinition,
  type ToolDispatchEntity,
  type ToolDispatchOutcome,
} from "./tool.types";

// Every service below is injected by NestJS via emitDecoratorMetadata; the
// class references must remain value imports at runtime so the DI container
// can resolve them — the same eslint override every cross-module consumer
// carries (the vehicles.controller.ts ↔ TripsService precedent; CLAUDE.md
// sanctions cross-module calls through these exported public interfaces).
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { CustomersService } from "../../customers/customers.service";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { DriversService } from "../../drivers/drivers.service";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { ExpenseLogsService } from "../../expense-logs/expense-logs.service";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { FuelLogsService } from "../../fuel-logs/fuel-logs.service";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { GeofencesService } from "../../geofences/geofences.service";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { JobsService } from "../../jobs/jobs.service";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { ReportsService } from "../../reports/reports.service";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { ServiceRecordsService } from "../../maintenance/service-records.service";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { ServiceSchedulesService } from "../../maintenance/service-schedules.service";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { TripsService } from "../../trips/trips.service";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { VehiclesService } from "../../vehicles/vehicles.service";

// The AI agent's tool registry (ADR-0043 commitments 1–3, tickets A4/A7): the
// curated, typed surface the LLM operates through — NOT the whole API.
// Structurally absent (c3): everything on InvoicesService, raw GPS/telematics
// traces, user/role management, and every delete. Stage one (A4) shipped the
// reads + reports; stage two (A7) adds the 8 creates on the same builders
// (A8 adds the 3 updates).
//
// Boot-time guarantees (constructor): every wrapper schema converts through
// z.toJSONSchema — a wrapper that drifts into .transform()/z.coerce (which
// JSON Schema cannot represent) FAILS THE BOOT loudly, c2's
// drift-becomes-loud-errors promise — plus unique snake_case names and the
// provider's 128-tool ceiling.
//
// Dispatch pipeline (execute; order is load-bearing, authz before validation,
// mirroring Nest's guard-before-pipe):
//   1. lookup            → unknown tool: NotFoundException
//   2. capability check  → every declared token via roleHasCapability (the
//                          same primitive RolesGuard uses) against the REAL
//                          requesting user's role (c1): ForbiddenException
//   3. wrapper validate  → the house ZodValidationPipe, so tool-arg failures
//                          carry the exact "field: message" 400 convention
//   4. execute as actor  → the owning module's real .strict() schema
//                          re-validates inside (c2); services that take an
//                          Actor get the real one (DRIVER row-scope free)
//   5. redactForModel    → the single choke point on results (c6); a tool
//                          cannot forget redaction.

@Injectable()
export class AgentToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();
  private readonly jsonSchemas = new Map<string, Record<string, unknown>>();

  constructor(
    vehicles: VehiclesService,
    drivers: DriversService,
    customers: CustomersService,
    jobs: JobsService,
    trips: TripsService,
    fuelLogs: FuelLogsService,
    expenseLogs: ExpenseLogsService,
    geofences: GeofencesService,
    serviceSchedules: ServiceSchedulesService,
    serviceRecords: ServiceRecordsService,
    reports: ReportsService,
  ) {
    const definitions: ToolDefinition[] = [
      ...buildVehiclesTools(vehicles),
      ...buildDriversTools(drivers),
      ...buildCustomersTools(customers),
      ...buildJobsTools(jobs),
      ...buildTripsTools(trips),
      ...buildFuelLogsTools(fuelLogs),
      ...buildExpenseLogsTools(expenseLogs),
      ...buildGeofencesTools(geofences),
      ...buildMaintenanceTools(serviceSchedules, serviceRecords),
      ...buildReportsTools(reports),
      buildFleetSnapshotTool({
        vehicles,
        drivers,
        trips,
        fuelLogs,
        expenseLogs,
        reports,
        serviceSchedules,
      }),
    ];

    for (const tool of definitions) {
      if (!TOOL_NAME_PATTERN.test(tool.name)) {
        throw new Error(`Agent tool name "${tool.name}" violates ${String(TOOL_NAME_PATTERN)}`);
      }
      if (this.tools.has(tool.name)) {
        throw new Error(`Duplicate agent tool name "${tool.name}"`);
      }
      // Name ↔ tier coherence: a `create_`/`update_` name IS the write tier
      // and vice versa. A misdeclared tool (a write masquerading as `read`,
      // or a read named like a write) fails the boot loudly rather than
      // shipping a mislabeled risk surface.
      const isWriteName = /^(create|update)_/.test(tool.name);
      if (isWriteName !== (tool.riskTier === "reversible-write")) {
        throw new Error(
          `Agent tool "${tool.name}" name/tier mismatch: ${tool.riskTier} (write names are ` +
            `create_*/update_* and exactly those carry the reversible-write tier)`,
        );
      }
      // Every write must declare its affected entity type — the AgentAction
      // audit row's deep-link (c4c) derives from it; a write the ledger
      // cannot link to its record is a compensations regression.
      if (tool.riskTier === "reversible-write" && tool.resultEntityType === undefined) {
        throw new Error(`Agent write tool "${tool.name}" declares no resultEntityType`);
      }
      // The boot-time JSON-schema generation — throws on any wrapper that a
      // JSON schema cannot represent (transforms, coercions).
      this.jsonSchemas.set(tool.name, z.toJSONSchema(tool.argsSchema) as Record<string, unknown>);
      this.tools.set(tool.name, tool);
    }

    if (this.tools.size > MAX_TOOL_COUNT) {
      throw new Error(
        `Agent tool registry exceeds the provider's ${MAX_TOOL_COUNT}-function ceiling ` +
          `(${this.tools.size} registered)`,
      );
    }
  }

  /**
   * The OpenAI-compatible `tools` array for a given role — CAPABILITY-
   * FILTERED, so the model is never shown a tool the requesting human cannot
   * run BY CAPABILITY (c1: the capability ceiling is the human's role). A5
   * passes this straight into the LlmClient request. One deliberate gap in
   * the filter's promise: capability tokens are coarse (ADR-0028), so a
   * DRIVER role — holding `trips:*` — is shown create_trip even though
   * TripsService.create rejects DRIVER actors at the service layer (403 →
   * a `denied` action row). Moot while agent:use is ADMIN-only; recorded
   * here because the filter alone is not the whole authorization story.
   */
  listToolDefinitions(role: UserRole): LlmToolSpec[] {
    const specs: LlmToolSpec[] = [];
    for (const tool of this.tools.values()) {
      if (!tool.capabilities.every((capability) => roleHasCapability(role, capability))) {
        continue;
      }
      const parameters = this.jsonSchemas.get(tool.name);
      if (parameters === undefined) continue; // unreachable; set in lockstep above
      specs.push({
        type: "function",
        function: { name: tool.name, description: tool.description, parameters },
      });
    }
    return specs;
  }

  /** Look up one tool (A5's action cards; tests). */
  getTool(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  /** All registered names, for tests/diagnostics. */
  listToolNames(): string[] {
    return [...this.tools.keys()];
  }

  /**
   * Dispatch one tool call as the requesting user, returning the full
   * outcome envelope (ticket A7): the REDACTED result (the only member that
   * may cross to the provider) plus the affected entity for the AgentAction
   * audit row, derived from the PRE-redaction result when the tool declares
   * `resultEntityType` — so the audit spine never depends on which keys
   * redaction preserves. See the pipeline note in the file header. Failures
   * are ordinary Nest HttpExceptions so A5 renders them as tool-error
   * messages with the familiar shapes.
   */
  async dispatch(name: string, rawArgs: unknown, actor: Actor): Promise<ToolDispatchOutcome> {
    const tool = this.tools.get(name);
    if (tool === undefined) {
      throw new NotFoundException(`Unknown agent tool: ${name}`);
    }

    for (const capability of tool.capabilities) {
      if (!roleHasCapability(actor.role, capability)) {
        throw new ForbiddenException(
          `Tool ${name} requires the ${capability} capability, which the ${actor.role} role does not hold.`,
        );
      }
    }

    const args = new ZodValidationPipe(tool.argsSchema).transform(rawArgs);

    // The A8 pre-image: captured AFTER wrapper validation, BEFORE execute —
    // the raw prior row an update is about to overwrite (c4b). The window
    // between capture and execute is an accepted TOCTOU (single-operator
    // system; a concurrent manual edit in that window would leave a slightly
    // stale pre-image, not a broken one). Rides the envelope UNREDACTED and
    // never touches the redaction → model pipe.
    const preImage =
      tool.capturePreImage !== undefined ? await tool.capturePreImage(args, actor) : undefined;

    let raw: unknown;
    try {
      raw = await tool.execute(args, actor);
    } catch (error) {
      // The owning module's re-validation runs INSIDE execute (c2). A
      // ZodError escaping here is that second layer rejecting what the
      // wrapper could not check (e.g. the reports from ≤ to cross-field
      // refine) — surface it with the exact house 400 shape the pipe
      // produces, so every validation failure looks the same to A5.
      if (error instanceof ZodError) {
        throw new BadRequestException({
          statusCode: 400,
          error: "Bad Request",
          message: formatZodError(error),
        });
      }
      throw error;
    }

    let entity: ToolDispatchEntity | null = null;
    if (tool.resultEntityType !== undefined && typeof raw === "object" && raw !== null) {
      const id = (raw as { id?: unknown }).id;
      if (typeof id === "string") {
        entity = { type: tool.resultEntityType, id };
      }
    }

    return { result: redactForModel(raw), entity, ...(preImage !== undefined ? { preImage } : {}) };
  }

  /**
   * Result-only dispatch — the A4 surface, kept as a thin delegate so every
   * pre-envelope caller and test is untouched. New callers that need the
   * audit envelope use {@link dispatch}.
   */
  async execute(name: string, rawArgs: unknown, actor: Actor): Promise<unknown> {
    return (await this.dispatch(name, rawArgs, actor)).result;
  }
}
