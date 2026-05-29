import { Controller, Get, Query, UseGuards } from "@nestjs/common";

import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { AuthGuard } from "../auth/auth.guard";

import { ReportsQuerySchema, type ReportsQuery } from "./reports.schemas";

// ReportsService is injected by NestJS via emitDecoratorMetadata; the
// class reference must remain a value import at runtime so the DI
// container can resolve it. Same convention every other vertical-
// slice controller uses for its service.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { ReportsService, type PerVehicleCostReport } from "./reports.service";

// ReportsController — read-only aggregation routes. Iter 23 ships one
// route (per-vehicle cost report); future report slices add siblings
// here rather than spawning a parallel controller.
//
// Route prefix `api/v1/reports`. Same versioning convention as every
// other Phase-1 controller (controller-level prefix rather than a
// global one).
//
// AuthGuard at the class level. Every Phase-1 admin surface is
// auth-gated per ADR-0021 §6; the cost report is no exception. A
// future Phase-2 surface (e.g., a public ledger summary) would
// override per-route.
@Controller("api/v1/reports")
@UseGuards(AuthGuard)
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  /**
   * GET /api/v1/reports/per-vehicle-cost?from=YYYY-MM-DD&to=YYYY-MM-DD&vehicleId=...
   *
   * Returns the per-vehicle cost report over the supplied date range,
   * optionally narrowed to a single vehicle's row. ZodValidationPipe
   * runs `ReportsQuerySchema` over the full query object, which:
   *
   *   - rejects unknown query keys (`.strict()`) with HTTP 400
   *   - rejects `from` / `to` that aren't strict YYYY-MM-DD strings
   *     with HTTP 400 (ISO 8601 timestamps are deliberately not
   *     accepted on this surface — see the schema docblock)
   *   - rejects `from > to` with HTTP 400 (cross-field refine; the
   *     error path names `to` so the web form can highlight it)
   *   - parses optional `vehicleId` from a cuid-shaped string;
   *     empty string is normalised to undefined (no filter)
   *
   * The pipe's BadRequestException translation surfaces the field-
   * named messages directly to the web client, which renders them
   * inline. Same pattern as every other vertical-slice list / detail
   * surface in Phase 1.
   *
   * Response shape: `{ from, to, rows, totals, companyLevel }` —
   * see ReportsService.PerVehicleCostReport for the per-field
   * documentation. `from` / `to` are echoed back as YYYY-MM-DD
   * strings (not Date objects) so the web page can re-render its
   * date inputs from the response without re-parsing the URL.
   */
  @Get("per-vehicle-cost")
  async getPerVehicleCost(
    @Query(new ZodValidationPipe(ReportsQuerySchema)) query: ReportsQuery,
  ): Promise<PerVehicleCostReport> {
    return this.reports.getPerVehicleCost({
      from: query.from,
      to: query.to,
      vehicleId: query.vehicleId,
    });
  }
}
