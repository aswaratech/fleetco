import {
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { Customer } from "@prisma/client";

import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { AuthGuard } from "../auth/auth.guard";
import { RequirePermission } from "../auth/decorators";
import { RolesGuard } from "../auth/roles.guard";
import type { AuthenticatedRequest } from "../auth/auth.types";

// CustomersService is injected by NestJS via emitDecoratorMetadata; the
// class reference must remain a value import at runtime so the DI
// container can resolve it. Same pattern the Drivers and Vehicles
// controllers use.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { CustomersService, LIST_TAKE_DEFAULT } from "./customers.service";
import {
  CreateCustomerSchema,
  ListCustomersQuerySchema,
  UpdateCustomerSchema,
  type CreateCustomerInput,
  type CustomerSortColumn,
  type CustomerSortDir,
  type ListCustomersQuery,
  type UpdateCustomerInput,
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
// RBAC (2026-07-02 hardening): the customers:* capability gates every route in this
// controller on the composed AuthGuard + RolesGuard chain (ADR-0028 c5). Before
// this, the controller was AuthGuard-only and open to any signed-in role.
@RequirePermission("customers:*")
@UseGuards(AuthGuard, RolesGuard)
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

  /**
   * Create a Customer. The body is validated by ZodValidationPipe
   * against CreateCustomerSchema (customers.schemas.ts); malformed
   * payloads return HTTP 400 with a clear per-field message.
   * createdById comes from the authenticated session (AuthGuard
   * populates request.session per ADR-0021 §6); it is never read from
   * the body — the schema's `.strict()` rejects it.
   *
   * Duplicate panNumber surfaces as HTTP 409 with a body shape that
   * names the offending field so the web action layer can surface it
   * as a field-level error on the create form:
   *
   *   {
   *     "statusCode": 409,
   *     "message": "A customer with PAN <value> already exists.",
   *     "field": "panNumber"
   *   }
   *
   * Same pattern Drivers (licenseNumber) and Vehicles
   * (registrationNumber) follow. The translation from the service's
   * ConflictException to this richer response body lives here rather
   * than in the service so the service stays usable from other
   * modules without the controller's response shape leaking in.
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body(new ZodValidationPipe(CreateCustomerSchema)) body: CreateCustomerInput,
    @Req() request: AuthenticatedRequest,
  ): Promise<Customer> {
    try {
      return await this.customers.create(body, request.session.user.id);
    } catch (error) {
      throw remapPanConflict(error);
    }
  }

  /**
   * Partial update. UpdateCustomerSchema enforces "at least one
   * field" and rejects unknown keys (so a client cannot smuggle `id`
   * or `createdById` through this endpoint). 404 on missing record;
   * 409 on panNumber conflict (service maps P2002), with the same
   * `field: "panNumber"` body shape as the create surface.
   */
  @Patch(":id")
  async update(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(UpdateCustomerSchema)) body: UpdateCustomerInput,
  ): Promise<Customer> {
    let updated: Customer | null;
    try {
      updated = await this.customers.update(id, body);
    } catch (error) {
      throw remapPanConflict(error);
    }
    if (!updated) {
      throw new NotFoundException(`Customer ${id} not found`);
    }
    return updated;
  }

  /**
   * Hard delete. Returns HTTP 204 (no body) on success; 404 when the
   * customer does not exist (service returns false for P2025); 409
   * when an inbound FK blocks the delete. Today no aggregate FKs into
   * Customer, so the 409 branch is dead in practice — but the iter-17
   * Jobs slice will FK Customer with onDelete: Restrict and exercise
   * this surface. The forward-compatible mapping ships here so the
   * Jobs migration only needs to add the FK declaration and the
   * matching web-side dialog parsing; no controller refactor needed.
   *
   * Wire shape on the 409:
   *
   *   {
   *     "statusCode": 409,
   *     "message": "Cannot delete customer: it is referenced by other records."
   *   }
   *
   * Mirror of the DriversController and VehiclesController delete
   * surfaces. The service's ConflictException is allowed to bubble up
   * untouched — Nest's default exception filter renders it correctly
   * (statusCode + message), and there is no `field` token to add
   * because a delete-block is not a field-level error.
   */
  @Delete(":id")
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param("id") id: string): Promise<void> {
    const deleted = await this.customers.delete(id);
    if (!deleted) {
      throw new NotFoundException(`Customer ${id} not found`);
    }
  }
}

// Translate the service's PAN-uniqueness ConflictException into a
// richer HTTP 409 body that names the offending field. Nest's default
// exception filter renders ConflictException as
// `{ statusCode: 409, message: "..." }`; the web action layer needs
// the field token to surface the error inline next to the PAN input.
//
// The function preserves the original message verbatim (the service
// builds it with the offending PAN value); only the response body
// shape is extended. Non-conflict errors pass through unchanged.
//
// We avoid throwing a fresh ConflictException with a custom response
// body because Nest's HttpException constructor accepts a response
// object directly — that path keeps the statusCode / message shape
// consistent with the rest of the API's 4xx responses (Drivers and
// Vehicles surface the same field-token convention via the same
// path; see drivers.controller.ts and vehicles.controller.ts).
function remapPanConflict(error: unknown): unknown {
  if (error instanceof ConflictException) {
    const message = error.message;
    return new HttpException(
      { statusCode: HttpStatus.CONFLICT, message, field: "panNumber" },
      HttpStatus.CONFLICT,
    );
  }
  return error;
}
