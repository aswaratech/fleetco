import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
// `Prisma` is a VALUE import now (D3 write path uses
// `instanceof Prisma.PrismaClientKnownRequestError` to map P2003 → 400, like
// CustomersService/JobsService). The enums InvoiceStatus / DocumentType /
// InvoiceServiceType stay type-only — status comparisons here are against string
// literals ("DRAFT"), so the runtime enum object is never needed.
import { Prisma } from "@prisma/client";
import type { InvoiceStatus, DocumentType, InvoiceServiceType } from "@prisma/client";

import { computeInvoiceTax, type InvoiceTaxSnapshot } from "./invoice-tax";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { InvoiceNumberingService } from "./invoice-numbering.service";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { InvoiceSettingsService } from "./invoice-settings.service";
import type {
  CreateInvoiceInput,
  InvoiceSortColumn,
  InvoiceSortDir,
  UpdateInvoiceInput,
} from "./invoices.schemas";

// Re-export the schema-inferred input types so the controller and tests can pull
// them from this module (the JobsService / CustomersService convention).
export type { CreateInvoiceInput, UpdateInvoiceInput };

// PrismaService is injected by NestJS via TypeScript's emitDecoratorMetadata
// (see apps/api/tsconfig.json); the class reference must remain a value import at
// runtime so the DI container can resolve it. Same eslint override as the
// Customers / Jobs / Reports services.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { PrismaService } from "../prisma/prisma.service";

// Pagination defaults and bounds. Same `LIST_TAKE_` prefix and 200 ceiling as
// every prior aggregate (Customers / Jobs / Trips / Fuel logs / Expense logs).
export const LIST_TAKE_DEFAULT = 20;
export const LIST_TAKE_MAX = 200;
const LIST_TAKE_MIN = 1;

// Slim projection for the list endpoint. The list page (D6) renders the invoice
// number, the customer name (via nested include), the status + document-type
// badges, the gross + net-receivable totals, and the issue date; pulling only
// those columns via a nested Prisma `select` keeps the wire payload small as the
// ledger grows. The detail endpoint uses the broader `findById` shape (full
// nested customer + optional job + the lines) so the detail page can render every
// field and deep-link back to /customers/<id> and /jobs/<id>.
//
// The Prisma `select` literal is the runtime authority for what the list endpoint
// returns; the controller's InvoiceListItem type (re-exported from this file)
// shapes the wire response from this same select, so a divergence is a compile
// error at the call site rather than a silently dropped field. The frozen money
// columns are nullable until issue (D2/D3), so a DRAFT row carries nulls here —
// expected, not a bug.
const LIST_SELECT = {
  id: true,
  number: true,
  status: true,
  documentType: true,
  customerId: true,
  jobId: true,
  grossPaisa: true,
  netReceivablePaisa: true,
  issuedAt: true,
  createdAt: true,
  createdById: true,
  customer: {
    select: {
      id: true,
      name: true,
    },
  },
} satisfies Prisma.InvoiceSelect;

// The list item shape — derived from LIST_SELECT via Prisma's payload helper so
// the controller's response type and the tests share the precise shape.
export type InvoiceListItem = Prisma.InvoiceGetPayload<{ select: typeof LIST_SELECT }>;

// The detail shape — full Invoice + the full nested Customer (always present; the
// FK is NOT NULL), the optional nested Job (nullable FK), and the owned lines
// (ordered oldest-first so they render in the order they were captured). D4 will
// populate the lines from a job's trips; D1 returns whatever lines exist (none,
// until the write path lands).
const DETAIL_INCLUDE = {
  customer: true,
  job: true,
  lines: {
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  },
} satisfies Prisma.InvoiceInclude;

export type InvoiceDetail = Prisma.InvoiceGetPayload<{ include: typeof DETAIL_INCLUDE }>;

export interface ListResult {
  items: InvoiceListItem[];
  total: number;
}

@Injectable()
export class InvoicesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly numbering: InvoiceNumberingService,
    private readonly settings: InvoiceSettingsService,
  ) {}

  /**
   * List invoices with optional filter / sort / pagination. Returns the slim
   * projection (LIST_SELECT) so the wire payload stays small even as the ledger
   * grows; the detail endpoint uses findById with the broader DETAIL_INCLUDE.
   *
   * Defaults (when the caller passes no overrides): 20 rows, newest first by
   * createdAt — matches every prior list surface. The `id` secondary tiebreaker
   * (when createdAt itself is the primary) or the `createdAt` secondary (when any
   * other column is primary) keeps paginated results deterministic — without it,
   * two rows with identical primary sort values can flip between page loads and
   * either duplicate or skip a row.
   *
   * `number` is nullable until issue (D3); Prisma's default null-ordering sorts
   * nulls last in asc and first in desc, which is the right shape for "issued
   * documents by number" — unnumbered DRAFTs slide to one end where they make
   * sense as "not yet issued".
   *
   * `skip` and `take` are clamped to safe bounds (`LIST_TAKE_MAX = 200`) as
   * defense-in-depth: the controller validates `take` against the same ceiling
   * via `ListInvoicesQuerySchema`, but the service may also be called from inside
   * other modules / future tickets (D4 assembles lines, D6 renders pages), and a
   * clamp here ensures the database is never asked for an unbounded result.
   */
  async list({
    skip = 0,
    take = LIST_TAKE_DEFAULT,
    status,
    documentType,
    customerId,
    sortBy = "createdAt",
    sortDir = "desc",
  }: {
    skip?: number;
    take?: number;
    status?: InvoiceStatus[];
    documentType?: DocumentType[];
    customerId?: string;
    sortBy?: InvoiceSortColumn;
    sortDir?: InvoiceSortDir;
  }): Promise<ListResult> {
    const safeSkip = Number.isFinite(skip) && skip >= 0 ? Math.floor(skip) : 0;
    const safeTakeRaw = Number.isFinite(take) ? Math.floor(take) : LIST_TAKE_DEFAULT;
    const safeTake = Math.min(Math.max(safeTakeRaw, LIST_TAKE_MIN), LIST_TAKE_MAX);

    // Build the WHERE clause once; reuse it for both findMany and count so
    // `total` matches what findMany would return at skip=0/take=infinity. Empty
    // arrays must not produce `in: []` (which matches zero rows in Prisma) — the
    // schema's csvEnum normalizes those to undefined, but a belt-and-braces check
    // here keeps the service robust against any future direct caller that does
    // not go through the schema.
    const where: Prisma.InvoiceWhereInput = {
      ...(status && status.length > 0 ? { status: { in: status } } : {}),
      ...(documentType && documentType.length > 0 ? { documentType: { in: documentType } } : {}),
      ...(customerId ? { customerId } : {}),
    };

    // Primary sort by the requested column + direction; secondary tiebreaker on
    // createdAt (or id, when createdAt itself is the primary) so paginated
    // results are stable across requests. Same shape as JobsService.list and
    // CustomersService.list.
    const orderBy: Prisma.InvoiceOrderByWithRelationInput[] = [
      { [sortBy]: sortDir } as Prisma.InvoiceOrderByWithRelationInput,
      ...(sortBy === "createdAt"
        ? [{ id: sortDir } as Prisma.InvoiceOrderByWithRelationInput]
        : [{ createdAt: "desc" } as Prisma.InvoiceOrderByWithRelationInput]),
    ];

    const [items, total] = await this.prisma.$transaction([
      this.prisma.invoice.findMany({
        skip: safeSkip,
        take: safeTake,
        where,
        orderBy,
        select: LIST_SELECT,
      }),
      this.prisma.invoice.count({ where }),
    ]);

    return { items, total };
  }

  /**
   * Fetch one invoice by id with its full nested Customer, optional Job, and the
   * owned lines. Returns `null` when not found rather than throwing, so the
   * controller shapes the 404 and the service stays usable from other modules /
   * future tickets without exception handling for the not-found path (D3's issue
   * flow and D5's PDF render both load an invoice by id).
   */
  async findById(id: string): Promise<InvoiceDetail | null> {
    return this.prisma.invoice.findUnique({ where: { id }, include: DETAIL_INCLUDE });
  }

  /**
   * Plain Invoice lookup without the nested relations — for write paths that
   * need the existing row (its status, to gate mutability) but not the full
   * detail include. Mirrors JobsService.findByIdRaw / TripsService.findByIdRaw.
   */
  async findByIdRaw(id: string) {
    return this.prisma.invoice.findUnique({ where: { id } });
  }

  /**
   * Create a DRAFT invoice HEADER (ADR-0039 c5). `createdById` comes from the
   * authenticated session, never the body (the schema's `.strict()` rejects it).
   * `documentType` is fixed to INVOICE — a CREDIT_NOTE is created via
   * {@link createCreditNote}; `status` defaults to DRAFT; the `number` and the
   * frozen tax snapshot are NULL until issue (D3 issue()). The billable LINES are
   * added in D4 — a freshly-created invoice has none.
   *
   * A stale `customerId` / `jobId` surfaces as HTTP 400 via mapInvoiceWriteError
   * (Prisma P2003 → "<Field> <id> does not exist."), the JobsService precedent.
   */
  async create(input: CreateInvoiceInput, createdById: string): Promise<InvoiceDetail> {
    const data: Prisma.InvoiceUncheckedCreateInput = {
      customerId: input.customerId,
      jobId: input.jobId ?? null,
      serviceType: input.serviceType ?? null,
      discountPaisa: input.discountPaisa ?? null,
      documentType: "INVOICE",
      status: "DRAFT",
      createdById,
    };
    try {
      return await this.prisma.invoice.create({ data, include: DETAIL_INCLUDE });
    } catch (error) {
      throw mapInvoiceWriteError(error, { customerId: input.customerId, jobId: input.jobId });
    }
  }

  /**
   * Diff-PATCH a DRAFT invoice's header (ADR-0039 c5). Returns null when the row
   * is not found (controller maps to 404).
   *
   * IMMUTABILITY (the load-bearing D3 rule): only a DRAFT is editable. On an
   * ISSUED or CANCELLED row this throws ConflictException (409) — an issued
   * invoice's financial body is immutable and is corrected ONLY by a credit note.
   * Combined with the `.strict()` schema (which never accepts `number`, the tax
   * amounts, `status`, or `documentType`), every financial field is rejected on
   * an issued invoice.
   *
   * `null` in the patch clears a nullable field (jobId / serviceType /
   * discountPaisa); an omitted key leaves it (the hasOwnProperty discipline).
   */
  async update(id: string, input: UpdateInvoiceInput): Promise<InvoiceDetail | null> {
    const existing = await this.prisma.invoice.findUnique({ where: { id } });
    if (!existing) {
      return null;
    }
    if (existing.status !== "DRAFT") {
      throw new ConflictException(
        `Cannot modify a ${existing.status} invoice; an issued invoice is corrected only by a ` +
          "credit note (ADR-0039 c5).",
      );
    }

    const has = (key: keyof UpdateInvoiceInput): boolean =>
      Object.prototype.hasOwnProperty.call(input, key);

    const data: Prisma.InvoiceUncheckedUpdateInput = {
      ...(has("customerId") && input.customerId !== undefined && { customerId: input.customerId }),
      ...(has("jobId") && { jobId: input.jobId ?? null }),
      ...(has("serviceType") && { serviceType: input.serviceType ?? null }),
      ...(has("discountPaisa") && { discountPaisa: input.discountPaisa ?? null }),
    };

    try {
      return await this.prisma.invoice.update({ where: { id }, data, include: DETAIL_INCLUDE });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") {
        // Row vanished between the findUnique and the update (concurrent delete).
        return null;
      }
      throw mapInvoiceWriteError(error, {
        customerId: input.customerId ?? existing.customerId,
        jobId: input.jobId,
      });
    }
  }

  /**
   * Cancel a DRAFT invoice (DRAFT → CANCELLED). Returns null when not found
   * (controller maps to 404). Only a DRAFT can be cancelled (ADR-0039 c5): an
   * ISSUED invoice's number is permanent and is never deleted or cancelled in
   * place — its correction is a credit note. A non-DRAFT row throws
   * ConflictException (409).
   */
  async cancel(id: string): Promise<InvoiceDetail | null> {
    const existing = await this.prisma.invoice.findUnique({ where: { id } });
    if (!existing) {
      return null;
    }
    if (existing.status !== "DRAFT") {
      throw new ConflictException(
        `Only a DRAFT invoice can be cancelled; a ${existing.status} invoice's number is ` +
          "permanent (ADR-0039 c5).",
      );
    }
    return this.prisma.invoice.update({
      where: { id },
      data: { status: "CANCELLED" },
      include: DETAIL_INCLUDE,
    });
  }

  /**
   * Issue an invoice (or credit-note) draft — the one-way DRAFT → ISSUED
   * transition (ADR-0039 c4–5). In a SINGLE interactive `$transaction`:
   *
   *   1. Lock the invoice row `SELECT … FOR UPDATE` — so two concurrent issues of
   *      the SAME invoice cannot both assign a number (which would burn one and
   *      leave a gap). The second blocks here, then sees ISSUED → 409.
   *   2. Validate: it is a DRAFT (else 409); has ≥ 1 line (else 422); has a
   *      serviceType (else 422 — it selects the TDS rate).
   *   3. Compute + FREEZE the tax snapshot via computeInvoiceTax (ADR-0039 c3).
   *      The rates ride IN the snapshot, so a future statutory change is
   *      forward-only. A bad-data RangeError (e.g. discount > subtotal) maps to
   *      422, not a 500.
   *   4. Assign the next gapless fiscal-year number for the document's series
   *      (the counter advances WITH this transaction; a rollback reverts it).
   *   5. Flip to ISSUED + set issuedAt + write every frozen figure. After commit
   *      the financial body is immutable (update()/cancel() refuse a non-DRAFT).
   *
   * The supplier-PAN precondition is checked BEFORE the transaction (a documented
   * operator gate, ADR-0039 c9). The PDF render + R2 store that ADR-0039 c5 also
   * lists at issue are D5 — this leaves `pdfR2Key` NULL; the seam is the issued
   * row itself (D5 renders once at issue and stores the key).
   *
   * @param issuedAt Defaults to now (the HTTP path never passes it). Tests pass an
   *                 explicit date to exercise the BS fiscal-year boundary; a real
   *                 back-dating policy would be its own compliance decision.
   */
  async issue(id: string, issuedAt: Date = new Date()): Promise<InvoiceDetail> {
    // Precondition (independent of the row): FleetCo's own supplier PAN must be
    // configured before a real tax invoice goes out (ADR-0039 c9). Checked before
    // the transaction — a clear, actionable error, never a fabricated PAN.
    if (this.settings.getSupplierPan() === null) {
      throw new UnprocessableEntityException(
        "Cannot issue: FleetCo's supplier PAN/VAT number is not configured. Set " +
          "INVOICE_SUPPLIER_PAN (operator-supplied; ADR-0039 c9) before issuing.",
      );
    }

    return this.prisma.$transaction(async (tx) => {
      // 1. Lock the row. Raw SELECT … FOR UPDATE returns the scalar fields the
      //    issue flow needs; the enum columns come back as their string labels.
      const locked = await tx.$queryRaw<
        {
          status: InvoiceStatus;
          serviceType: InvoiceServiceType | null;
          discountPaisa: number | null;
          documentType: DocumentType;
        }[]
      >`
        SELECT "status", "serviceType", "discountPaisa", "documentType"
        FROM "invoice" WHERE "id" = ${id} FOR UPDATE`;
      const row = locked[0];
      if (row === undefined) {
        throw new NotFoundException(`Invoice ${id} not found`);
      }
      if (row.status !== "DRAFT") {
        throw new ConflictException(
          `Invoice ${id} is ${row.status}; only a DRAFT can be issued (ADR-0039 c5).`,
        );
      }
      if (row.serviceType === null) {
        throw new UnprocessableEntityException(
          "Cannot issue: serviceType is required (it selects the TDS rate). Set it on the " +
            "draft first (ADR-0039 c3/c9).",
        );
      }

      // 2. Lines (only the captured amounts are needed for the tax math).
      const lines = await tx.invoiceLine.findMany({
        where: { invoiceId: id },
        select: { lineAmountPaisa: true },
      });
      if (lines.length === 0) {
        throw new UnprocessableEntityException(
          "Cannot issue: an invoice needs at least one line (ADR-0039 c5).",
        );
      }

      // 3. Freeze the tax snapshot. computeInvoiceTax throws on bad data (e.g. a
      //    discount exceeding the subtotal) — surface as 422, not an opaque 500.
      let snapshot: InvoiceTaxSnapshot;
      try {
        snapshot = computeInvoiceTax({
          lineAmountsPaisa: lines.map((line) => line.lineAmountPaisa),
          discountPaisa: row.discountPaisa ?? undefined,
          serviceType: row.serviceType,
        });
      } catch (error) {
        if (error instanceof RangeError) {
          throw new UnprocessableEntityException(`Cannot issue: ${error.message}`);
        }
        throw error;
      }

      // 4. Assign the gapless number for this document's series + fiscal year.
      const number = await this.numbering.nextNumber(tx, row.documentType, issuedAt);

      // 5. Flip to ISSUED and FREEZE every figure (+ the two rates) onto the row.
      return tx.invoice.update({
        where: { id },
        data: {
          status: "ISSUED",
          number,
          issuedAt,
          subtotalPaisa: snapshot.subtotalPaisa,
          discountPaisa: snapshot.discountPaisa,
          vatRateBp: snapshot.vatRateBp,
          vatPaisa: snapshot.vatPaisa,
          grossPaisa: snapshot.grossPaisa,
          tdsRateBp: snapshot.tdsRateBp,
          tdsPaisa: snapshot.tdsPaisa,
          netReceivablePaisa: snapshot.netReceivablePaisa,
          serviceType: snapshot.serviceType,
        },
        include: DETAIL_INCLUDE,
      });
    });
  }

  /**
   * Create a CREDIT_NOTE draft correcting an ISSUED invoice (ADR-0039 c5) — the
   * ONLY correction path for an issued invoice (never an edit or delete). The
   * credit note is a separate document with its OWN gapless fiscal-year series
   * (it draws a CRN-… number when issued, because the counter is keyed by
   * documentType). It references the original via `originalInvoiceId` and copies
   * the customer, job, serviceType, discount, and lines (a full-reversal credit
   * note by default).
   *
   * This is the D3 SEAM: it creates the credit-note DRAFT (issued like any
   * document via {@link issue}). The credit-note SEMANTICS — full vs partial, the
   * sign convention, which lines to reverse — are an accountant-verified detail
   * refined in the D6 web surface (ADR-0039 c9); D3 ships the seam + the
   * independent numbering.
   */
  async createCreditNote(originalInvoiceId: string, createdById: string): Promise<InvoiceDetail> {
    return this.prisma.$transaction(async (tx) => {
      const original = await tx.invoice.findUnique({
        where: { id: originalInvoiceId },
        include: { lines: true },
      });
      if (!original) {
        throw new NotFoundException(`Invoice ${originalInvoiceId} not found`);
      }
      if (original.documentType !== "INVOICE") {
        throw new ConflictException(
          `Invoice ${originalInvoiceId} is a ${original.documentType}; a credit note can only ` +
            "correct an INVOICE (ADR-0039 c5).",
        );
      }
      if (original.status !== "ISSUED") {
        throw new ConflictException(
          `Invoice ${originalInvoiceId} is ${original.status}; only an ISSUED invoice can be ` +
            "credited (ADR-0039 c5).",
        );
      }

      return tx.invoice.create({
        data: {
          documentType: "CREDIT_NOTE",
          originalInvoiceId: original.id,
          customerId: original.customerId,
          jobId: original.jobId,
          serviceType: original.serviceType,
          discountPaisa: original.discountPaisa,
          status: "DRAFT",
          createdById,
          lines: {
            create: original.lines.map((line) => ({
              tripId: line.tripId,
              jobId: line.jobId,
              description: line.description,
              quantity: line.quantity,
              unitPricePaisa: line.unitPricePaisa,
              lineAmountPaisa: line.lineAmountPaisa,
            })),
          },
        },
        include: DETAIL_INCLUDE,
      });
    });
  }
}

/**
 * Map a Prisma write error to a clean HTTP exception (D3). A P2003 foreign-key
 * violation on `customerId` / `jobId` / `createdById` becomes HTTP 400 naming the
 * offending FK — the JobsService precedent (a stale FK is a bad-body problem, not
 * a conflict). Non-Prisma / non-P2003 errors pass through unchanged.
 */
function mapInvoiceWriteError(
  error: unknown,
  ctx: { customerId?: string; jobId?: string | null },
): unknown {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2003") {
    const meta = error.meta as { field_name?: string; constraint?: string } | undefined;
    const fieldName = String(meta?.field_name ?? meta?.constraint ?? "").toLowerCase();
    if (fieldName.includes("customer")) {
      return new BadRequestException(`Customer "${ctx.customerId}" does not exist.`);
    }
    if (fieldName.includes("job")) {
      return new BadRequestException(`Job "${ctx.jobId}" does not exist.`);
    }
    if (fieldName.includes("createdby")) {
      return new BadRequestException("Authenticated user no longer exists; sign in again.");
    }
    return new BadRequestException("A referenced record does not exist.");
  }
  return error;
}
