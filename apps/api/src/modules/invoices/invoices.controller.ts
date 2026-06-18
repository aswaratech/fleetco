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

import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { AuthGuard } from "../auth/auth.guard";
import type { AuthenticatedRequest } from "../auth/auth.types";

// InvoicesService is injected by NestJS via emitDecoratorMetadata; the class
// reference must remain a value import at runtime so the DI container can resolve
// it. Same pattern the Customers / Jobs / Reports controllers use.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import {
  InvoicesService,
  LIST_TAKE_DEFAULT,
  type InvoiceDetail,
  type InvoiceListItem,
} from "./invoices.service";
import {
  BuildFromJobSchema,
  CreateInvoiceLineSchema,
  CreateInvoiceSchema,
  ListInvoicesQuerySchema,
  UpdateInvoiceLineSchema,
  UpdateInvoiceSchema,
  type BuildFromJobInput,
  type CreateInvoiceInput,
  type CreateInvoiceLineInput,
  type InvoiceSortColumn,
  type InvoiceSortDir,
  type ListInvoicesQuery,
  type UpdateInvoiceInput,
  type UpdateInvoiceLineInput,
} from "./invoices.schemas";

export interface InvoicesListResponse {
  items: InvoiceListItem[];
  total: number;
  skip: number;
  take: number;
  // Echo the effective sort back so the web client can render the active-column
  // indicator without re-deriving from URL params. Defaults match the service:
  // createdAt desc. Same wire contract as JobsListResponse / CustomersListResponse
  // so the web client can reuse its paginator and sortable-header components.
  sortBy: InvoiceSortColumn;
  sortDir: InvoiceSortDir;
}

// Route prefix: `api/v1/invoices`. Same versioning convention as Customers / Jobs
// (controller-level prefix). Per ADR-0021 §6 every route on this controller is
// auth-guarded at the controller level so a future route inherits the gate by
// default — opt-out would require an explicit decorator, the right direction for
// an admin-only surface.
//
// D1 ships the READ path ONLY (GET list + GET :id). The write path — create,
// issue (D3), update, cancel — and the PDF download (D5) layer on in later
// tickets. These two routes match the Jobs / Customers read surface in shape and
// validation conventions so the web client's API helpers and form patterns
// transfer without surprises.
//
// NOTE on RBAC: like the Phase-1 aggregates, this controller is AuthGuard-only
// (not RolesGuard-gated) — invoicing is an admin/office surface in v1; any role
// gating is a later decision (ADR-0039 does not scope invoice RBAC, and the web
// surface is admin-facing in Phase 4).
@Controller("api/v1/invoices")
@UseGuards(AuthGuard)
export class InvoicesController {
  constructor(private readonly invoices: InvoicesService) {}

  /**
   * List invoices with filter / sort / pagination. ZodValidationPipe runs
   * `ListInvoicesQuerySchema` over the full query object, which:
   *   - rejects unknown query keys (`.strict()`) with HTTP 400
   *   - parses `status` / `documentType` from comma-separated strings into
   *     deduplicated enum arrays
   *   - normalizes `customerId` (empty string -> undefined = no filter)
   *   - parses `skip` / `take` from strings and enforces the 1..200 ceiling
   *   - validates `sortBy` against the whitelist (`createdAt` / `number`)
   *
   * Defaults applied here (when the validated query omits a field) mirror the
   * service's defaults so the echoed `sortBy` / `sortDir` / `skip` / `take` are
   * always the values that actually ran the query — the anchors the web client's
   * pagination and sort-indicator UI read.
   */
  @Get()
  async list(
    @Query(new ZodValidationPipe(ListInvoicesQuerySchema)) query: ListInvoicesQuery,
  ): Promise<InvoicesListResponse> {
    const skip = query.skip ?? 0;
    const take = query.take ?? LIST_TAKE_DEFAULT;
    const sortBy: InvoiceSortColumn = query.sortBy ?? "createdAt";
    const sortDir: InvoiceSortDir = query.sortDir ?? "desc";

    const { items, total } = await this.invoices.list({
      skip,
      take,
      status: query.status,
      documentType: query.documentType,
      customerId: query.customerId,
      sortBy,
      sortDir,
    });
    return { items, total, skip, take, sortBy, sortDir };
  }

  /**
   * Fetch one invoice by id, with the nested Customer, optional Job, and the
   * owned lines. 404 when the row does not exist, with the id named in the
   * message so an operator chasing a bad URL sees exactly which id missed.
   * Mirrors JobsController.getById / CustomersController.getById.
   */
  @Get(":id")
  async getById(@Param("id") id: string): Promise<InvoiceDetail> {
    const invoice = await this.invoices.findById(id);
    if (!invoice) {
      throw new NotFoundException(`Invoice ${id} not found`);
    }
    return invoice;
  }

  /**
   * Create a DRAFT invoice header (ADR-0039 c5). The body is validated against
   * CreateInvoiceSchema; `createdById` comes from the authenticated session
   * (AuthGuard populates `request.session` per ADR-0021 §6), never the body. A
   * stale `customerId` / `jobId` surfaces as HTTP 400 (service P2003 mapping).
   * The lines are added in D4; the number + tax snapshot at issue (D3 issue()).
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body(new ZodValidationPipe(CreateInvoiceSchema)) body: CreateInvoiceInput,
    @Req() request: AuthenticatedRequest,
  ): Promise<InvoiceDetail> {
    return this.invoices.create(body, request.session.user.id);
  }

  /**
   * Partial update of a DRAFT header. UpdateInvoiceSchema enforces "at least one
   * field" and `.strict()` rejects unknown keys (so a client cannot smuggle
   * `number`, an amount, `status`, or `createdById` through this endpoint). 404
   * on a missing row; 409 when the row is not a DRAFT (an issued invoice is
   * immutable — corrected only by a credit note, the service enforces this).
   */
  @Patch(":id")
  async update(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(UpdateInvoiceSchema)) body: UpdateInvoiceInput,
  ): Promise<InvoiceDetail> {
    const updated = await this.invoices.update(id, body);
    if (!updated) {
      throw new NotFoundException(`Invoice ${id} not found`);
    }
    return updated;
  }

  /**
   * Cancel a DRAFT invoice (DRAFT → CANCELLED). 404 on a missing row; 409 when
   * the row is not a DRAFT — an ISSUED invoice's number is permanent and is never
   * cancelled in place (ADR-0039 c5). A POST action (a state transition), not a
   * DELETE: the row is retained as CANCELLED, not removed.
   */
  @Post(":id/cancel")
  async cancel(@Param("id") id: string): Promise<InvoiceDetail> {
    const cancelled = await this.invoices.cancel(id);
    if (!cancelled) {
      throw new NotFoundException(`Invoice ${id} not found`);
    }
    return cancelled;
  }

  /**
   * Issue an invoice (DRAFT → ISSUED) — assign the gapless fiscal-year number,
   * freeze the tax snapshot, and lock the financial body (ADR-0039 c4–5). The
   * service throws the right status itself: 404 (missing), 409 (not a DRAFT), 422
   * (no lines / no serviceType / supplier PAN not configured / discount >
   * subtotal). The PDF render + R2 store (also at issue per ADR-0039 c5) are D5.
   * A POST action (a one-way state transition with side effects), not a PATCH.
   */
  @Post(":id/issue")
  async issue(@Param("id") id: string): Promise<InvoiceDetail> {
    // No issuedAt argument from the HTTP path — issue() defaults it to now.
    return this.invoices.issue(id);
  }

  /**
   * Create a credit note correcting an ISSUED invoice (ADR-0039 c5) — the only
   * correction path for an issued invoice. Returns a CREDIT_NOTE DRAFT (201)
   * referencing the original, with its own gapless series assigned when issued.
   * The service throws 404 (original missing) / 409 (original not an ISSUED
   * INVOICE). The full credit-note web flow is D6; this is the seam.
   */
  @Post(":id/credit-notes")
  @HttpCode(HttpStatus.CREATED)
  async createCreditNote(
    @Param("id") id: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<InvoiceDetail> {
    return this.invoices.createCreditNote(id, request.session.user.id);
  }

  // -------------------------------------------------------------------------
  // Line management (D4 / ADR-0039 c2, c8). Every line write is gated to a DRAFT
  // (the service enforces 409 on a non-DRAFT — the issued-invoice immutability gate,
  // extended from the header to the lines). `lineAmountPaisa` is always derived
  // server-side; the `.strict()` schemas reject a client-sent amount. The service
  // throws the right status itself, so these handlers are thin pass-throughs.
  // -------------------------------------------------------------------------

  /**
   * Add ONE billable line to a DRAFT invoice (ADR-0039 c2). A MANUAL line omits
   * tripId/jobId (a flat fee / ad-hoc charge); a TRIP line sets tripId (+ optionally
   * jobId) for provenance. The service throws 404 (invoice missing), 409 (not a
   * DRAFT), or 400 (job-customer mismatch / stale FK / amount overflow). Returns the
   * updated invoice detail so the web re-renders the lines + totals in one round-trip.
   */
  @Post(":id/lines")
  @HttpCode(HttpStatus.CREATED)
  async addLine(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(CreateInvoiceLineSchema)) body: CreateInvoiceLineInput,
  ): Promise<InvoiceDetail> {
    return this.invoices.addLine(id, body);
  }

  /**
   * Batch-build trip lines on a DRAFT invoice from operator-selected trips, tagged
   * with a job for provenance (ADR-0039 c2/c8). Each line's description is stamped
   * with the trip's date in Bikram Sambat. NOT a Job->Trip traversal — the schema has
   * no Trip->Job link, so the request supplies the trips (see the service +
   * tech-debt notes). The service throws 404 (invoice missing), 409 (not a DRAFT), or
   * 400 (job-customer mismatch / stale trip / amount overflow).
   */
  @Post(":id/build-from-job")
  @HttpCode(HttpStatus.CREATED)
  async buildFromJob(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(BuildFromJobSchema)) body: BuildFromJobInput,
  ): Promise<InvoiceDetail> {
    return this.invoices.buildFromJob(id, body);
  }

  /**
   * Edit a line on a DRAFT invoice. `lineAmountPaisa` is re-derived whenever quantity
   * or unitPricePaisa changes (against the merged shape). The service throws 404
   * (invoice or line missing), 409 (not a DRAFT), or 400 (job-customer mismatch /
   * stale FK / overflow). Returns the updated invoice detail.
   */
  @Patch(":id/lines/:lineId")
  async updateLine(
    @Param("id") id: string,
    @Param("lineId") lineId: string,
    @Body(new ZodValidationPipe(UpdateInvoiceLineSchema)) body: UpdateInvoiceLineInput,
  ): Promise<InvoiceDetail> {
    return this.invoices.updateLine(id, lineId, body);
  }

  /**
   * Remove a line from a DRAFT invoice. 204 No Content (the aggregate-DELETE
   * convention every prior slice uses). The service throws 404 (invoice or line
   * missing) or 409 (not a DRAFT). The web re-reads the invoice afterwards.
   */
  @Delete(":id/lines/:lineId")
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeLine(@Param("id") id: string, @Param("lineId") lineId: string): Promise<void> {
    await this.invoices.removeLine(id, lineId);
  }
}
