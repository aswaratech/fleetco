import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { Site } from "@prisma/client";

import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { AuthGuard } from "../auth/auth.guard";
import { RequirePermission } from "../auth/decorators";
import { RolesGuard } from "../auth/roles.guard";
import type { AuthenticatedRequest } from "../auth/auth.types";

// SitesService is injected by NestJS via emitDecoratorMetadata; the class
// reference must remain a value import at runtime so the DI container can
// resolve it. Same pattern the Customers/Trips controllers use.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { SitesService, LIST_TAKE_DEFAULT } from "./sites.service";
import {
  CreateSiteSchema,
  ListSitesQuerySchema,
  UpdateSiteSchema,
  type CreateSiteInput,
  type ListSitesQuery,
  type SiteSortColumn,
  type SiteSortDir,
  type UpdateSiteInput,
} from "./sites.schemas";

export interface SitesListResponse {
  items: Site[];
  total: number;
  skip: number;
  take: number;
  // Echo the effective sort back so the web client can render the active-column
  // indicator without re-deriving from URL params. Same wire contract as
  // CustomersListResponse so the web client reuses its paginator and
  // sortable-header components across surfaces.
  sortBy: SiteSortColumn;
  sortDir: SiteSortDir;
}

// Route prefix: `api/v1/sites`. Same versioning convention as Customers /
// Geofences (controller-level prefix rather than a global one).
//
// RBAC (ADR-0047 c4/c10): the `sites:*` capability gates every route on the
// composed AuthGuard + RolesGuard chain (ADR-0028 c5). `sites:*` is a coarse
// operation-class token on the shared operational floor, so BOTH ADMIN and
// OFFICE_STAFF get full CRUD (dispatch is their day-to-day job); DRIVER (which
// does not hold it) → 403, anonymous → 401 from AuthGuard. The decorator is
// applied at the controller level so a future route added to this class
// inherits the gate by default.
@Controller("api/v1/sites")
@RequirePermission("sites:*")
@UseGuards(AuthGuard, RolesGuard)
export class SitesController {
  constructor(private readonly sites: SitesService) {}

  /**
   * List sites with filter / sort / pagination. ZodValidationPipe runs
   * ListSitesQuerySchema over the full query object, which:
   *   - rejects unknown query keys (`.strict()`) with HTTP 400
   *   - parses `kind` from a comma-separated string into a deduplicated enum
   *     array
   *   - parses `skip` / `take` from strings into integers and enforces the same
   *     1..200 ceiling as the service
   *   - validates `sortBy` against the sortable-column whitelist
   *     (`name` / `createdAt`)
   *
   * Defaults applied here (when the validated query omits the field) mirror the
   * service's defaults so the echoed `sortBy` / `sortDir` / `skip` / `take` are
   * always the values that actually ran the query.
   */
  @Get()
  async list(
    @Query(new ZodValidationPipe(ListSitesQuerySchema)) query: ListSitesQuery,
  ): Promise<SitesListResponse> {
    const skip = query.skip ?? 0;
    const take = query.take ?? LIST_TAKE_DEFAULT;
    const sortBy: SiteSortColumn = query.sortBy ?? "createdAt";
    const sortDir: SiteSortDir = query.sortDir ?? "desc";

    const { items, total } = await this.sites.list({
      skip,
      take,
      kind: query.kind,
      sortBy,
      sortDir,
    });
    return { items, total, skip, take, sortBy, sortDir };
  }

  /**
   * Fetch one site by id. 404 when the row does not exist, with the id named in
   * the message so an operator chasing a bad URL sees exactly which id missed.
   * Mirrors CustomersController.getById.
   */
  @Get(":id")
  async getById(@Param("id") id: string): Promise<Site> {
    const site = await this.sites.findById(id);
    if (!site) {
      throw new NotFoundException(`Site ${id} not found`);
    }
    return site;
  }

  /**
   * Create a Site. The body is validated by ZodValidationPipe against
   * CreateSiteSchema; malformed payloads return HTTP 400 with a clear per-field
   * message (including an out-of-range latitude/longitude). `createdById` comes
   * from the authenticated session (AuthGuard populates request.session per
   * ADR-0021 §6); it is never read from the body — the schema's `.strict()`
   * rejects it. Site has no unique columns, so there is no 409 conflict path on
   * create.
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body(new ZodValidationPipe(CreateSiteSchema)) body: CreateSiteInput,
    @Req() request: AuthenticatedRequest,
  ): Promise<Site> {
    return this.sites.create(body, request.session.user.id);
  }

  /**
   * Partial update. UpdateSiteSchema enforces "at least one field" and rejects
   * unknown keys (so a client cannot smuggle `id`, `createdById`, or `geometry`
   * through this endpoint). 404 on missing record. Site has no unique columns,
   * so there is no 409 conflict path on update.
   */
  @Patch(":id")
  async update(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(UpdateSiteSchema)) body: UpdateSiteInput,
  ): Promise<Site> {
    const updated = await this.sites.update(id, body);
    if (!updated) {
      throw new NotFoundException(`Site ${id} not found`);
    }
    return updated;
  }

  /**
   * Hard delete. Returns HTTP 204 (no body) on success; 404 when the site does
   * not exist (service returns false for P2025); 409 when a trip references the
   * site as pickup or drop-off (service maps P2003 → ConflictException). The
   * service's ConflictException bubbles up untouched — Nest's default exception
   * filter renders it as `{ statusCode: 409, message }`. There is no `field`
   * token because a delete-block is not a field-level error (mirror of the
   * Vehicle / Driver / Customer delete surfaces).
   *
   * Wire shape on the 409:
   *
   *   {
   *     "statusCode": 409,
   *     "message": "Cannot delete site: N trips reference this site."
   *   }
   */
  @Delete(":id")
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param("id") id: string): Promise<void> {
    const deleted = await this.sites.delete(id);
    if (!deleted) {
      throw new NotFoundException(`Site ${id} not found`);
    }
  }
}
