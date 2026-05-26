import { Controller, Get, NotFoundException, Param, Query, UseGuards } from "@nestjs/common";
import type { Driver } from "@prisma/client";

import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { AuthGuard } from "../auth/auth.guard";

// DriversService is injected by NestJS via emitDecoratorMetadata; the
// class reference must remain a value import at runtime. Same pattern
// the Vehicles controller uses for VehiclesService.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { DriversService, LIST_TAKE_DEFAULT } from "./drivers.service";
import {
  ListDriversQuerySchema,
  type DriverSortColumn,
  type DriverSortDir,
  type ListDriversQuery,
} from "./drivers.schemas";

export interface DriversListResponse {
  items: Driver[];
  total: number;
  skip: number;
  take: number;
  // Echo the effective sort back so the web client can render the
  // active-column indicator without re-deriving from URL params. The
  // defaults match the service: createdAt desc. Same wire contract as
  // VehiclesListResponse so the web client can reuse its paginator and
  // sortable-header components across both surfaces.
  sortBy: DriverSortColumn;
  sortDir: DriverSortDir;
}

// Route prefix: `api/v1/drivers`. Same versioning convention as
// Vehicles (controller-level prefix rather than a global one — see the
// matching comment in vehicles.controller.ts).
//
// Per ADR-0021 §6 every route on this controller is auth-guarded. The
// guard is applied at the controller level so a future route added to
// this class inherits the gate by default — opt-out would require an
// explicit decorator, which is the right direction for an admin-only
// surface in Phase 1.
//
// Iter 6 ships only the read path. POST / PATCH / DELETE land in iter
// 7 alongside the Drivers write-path UI; their absence from this file
// is intentional.
@Controller("api/v1/drivers")
@UseGuards(AuthGuard)
export class DriversController {
  constructor(private readonly drivers: DriversService) {}

  /**
   * List drivers with filter / sort / pagination. ZodValidationPipe
   * runs `ListDriversQuerySchema` over the full query object, which:
   *   - rejects unknown query keys (`.strict()`) with HTTP 400
   *   - parses `status` / `licenseClass` from comma-separated strings
   *     into deduplicated enum arrays
   *   - parses `skip` / `take` from strings into integers and enforces
   *     the same 1..200 ceiling as the service
   *   - validates `sortBy` against the sortable-column whitelist
   *
   * Defaults applied here (when the validated query omits the field)
   * mirror the service's defaults so the response's echoed `sortBy` /
   * `sortDir` / `skip` / `take` are always the values that actually
   * ran the query. The same values become anchor points for the web
   * client's pagination and sort-indicator UI.
   */
  @Get()
  async list(
    @Query(new ZodValidationPipe(ListDriversQuerySchema)) query: ListDriversQuery,
  ): Promise<DriversListResponse> {
    const skip = query.skip ?? 0;
    const take = query.take ?? LIST_TAKE_DEFAULT;
    const sortBy: DriverSortColumn = query.sortBy ?? "createdAt";
    const sortDir: DriverSortDir = query.sortDir ?? "desc";

    const { items, total } = await this.drivers.list({
      skip,
      take,
      status: query.status,
      licenseClass: query.licenseClass,
      sortBy,
      sortDir,
    });
    return { items, total, skip, take, sortBy, sortDir };
  }

  @Get(":id")
  async getById(@Param("id") id: string): Promise<Driver> {
    const driver = await this.drivers.findById(id);
    if (!driver) {
      throw new NotFoundException(`Driver ${id} not found`);
    }
    return driver;
  }
}
