import { Controller, Get, NotFoundException, Param, Query, UseGuards } from "@nestjs/common";
import type { Customer } from "@prisma/client";

import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { AuthGuard } from "../auth/auth.guard";

// CustomersService is injected by NestJS via emitDecoratorMetadata; the
// class reference must remain a value import at runtime so the DI
// container can resolve it. Same pattern the Drivers and Vehicles
// controllers use.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { CustomersService, LIST_TAKE_DEFAULT } from "./customers.service";
import {
  ListCustomersQuerySchema,
  type CustomerSortColumn,
  type CustomerSortDir,
  type ListCustomersQuery,
} from "./customers.schemas";

export interface CustomersListResponse {
  items: Customer[];
  total: number;
  skip: number;
  take: number;
  // Echo the effective sort back so the web client can render the
  // active-column indicator without re-deriving from URL params. The
  // defaults match the service: createdAt desc. Same wire contract as
  // DriversListResponse and VehiclesListResponse so the web client can
  // reuse its paginator and sortable-header components across surfaces.
  sortBy: CustomerSortColumn;
  sortDir: CustomerSortDir;
}

// Route prefix: `api/v1/customers`. Same versioning convention as
// Vehicles and Drivers (controller-level prefix rather than a global
// one — see the matching comments on those controllers).
//
// Per ADR-0021 §6 every route on this controller is auth-guarded. The
// guard is applied at the controller level so a future route added to
// this class inherits the gate by default — opt-out would require an
// explicit decorator, which is the right direction for an admin-only
// surface in Phase 1.
//
// Iter 15 ships the read path (GET list + GET :id); iter 16 will
// layer the write path (POST / PATCH / DELETE) on top. The two routes
// below match the Drivers iter-6 surface in shape and validation
// conventions so the web client's API helpers and form patterns
// transfer across both modules without surprises.
@Controller("api/v1/customers")
@UseGuards(AuthGuard)
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  /**
   * List customers with filter / sort / pagination. ZodValidationPipe
   * runs `ListCustomersQuerySchema` over the full query object, which:
   *   - rejects unknown query keys (`.strict()`) with HTTP 400
   *   - parses `status` from comma-separated strings into a
   *     deduplicated enum array
   *   - parses `skip` / `take` from strings into integers and enforces
   *     the same 1..200 ceiling as the service
   *   - validates `sortBy` against the sortable-column whitelist
   *     (`name` / `createdAt`)
   *
   * Defaults applied here (when the validated query omits the field)
   * mirror the service's defaults so the response's echoed `sortBy` /
   * `sortDir` / `skip` / `take` are always the values that actually
   * ran the query. The same values become anchor points for the web
   * client's pagination and sort-indicator UI.
   */
  @Get()
  async list(
    @Query(new ZodValidationPipe(ListCustomersQuerySchema)) query: ListCustomersQuery,
  ): Promise<CustomersListResponse> {
    const skip = query.skip ?? 0;
    const take = query.take ?? LIST_TAKE_DEFAULT;
    const sortBy: CustomerSortColumn = query.sortBy ?? "createdAt";
    const sortDir: CustomerSortDir = query.sortDir ?? "desc";

    const { items, total } = await this.customers.list({
      skip,
      take,
      status: query.status,
      sortBy,
      sortDir,
    });
    return { items, total, skip, take, sortBy, sortDir };
  }

  /**
   * Fetch one customer by id. 404 when the row does not exist, with
   * the id named in the message so an operator chasing a bad URL sees
   * exactly which id missed. Mirrors DriversController.getById.
   */
  @Get(":id")
  async getById(@Param("id") id: string): Promise<Customer> {
    const customer = await this.customers.findById(id);
    if (!customer) {
      throw new NotFoundException(`Customer ${id} not found`);
    }
    return customer;
  }
}
