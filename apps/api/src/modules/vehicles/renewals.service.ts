import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import {
  type Prisma,
  type ExpenseCategory,
  type DocumentCategory,
  type RenewalRecord,
} from "@prisma/client";

// PrismaService and DocumentsService are injected by NestJS via
// emitDecoratorMetadata; the class references must remain value imports so
// the DI container can resolve them (the standard override).
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { PrismaService } from "../prisma/prisma.service";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { DocumentsService } from "../documents/documents.service";
import { type CreateRenewalInput, type RenewalKindName } from "./renewals.schemas";

// The renewal-records slice (ADR-0049 c4): the atomic "Renew" action and its
// per-vehicle history. renew() is the ONLY writer of renewal_record rows and
// executes as one interactive $transaction — snapshot the pre-image expiry
// from the vehicle row, validate the optional document/expense links through
// the owning modules' rules, create the record, and update the vehicle's
// matching compliance fields — so a mid-flight failure can never leave a
// recorded renewal whose vehicle still shows the old expiry (the ServiceRecord
// anchor-advance / iter-11 odometer-bump transaction shape). Append-only:
// there is no update or delete (a wrong entry is corrected by renewing again
// with a note — the ledger posture).

export const LIST_TAKE_DEFAULT = 50;
export const LIST_TAKE_MAX = 200;
const LIST_TAKE_MIN = 1;

/** The vehicle expiry column each kind renews. */
const EXPIRY_FIELD: Record<
  RenewalKindName,
  "bluebookExpiresAt" | "insuranceExpiresAt" | "routePermitExpiresAt"
> = {
  BLUEBOOK: "bluebookExpiresAt",
  INSURANCE: "insuranceExpiresAt",
  ROUTE_PERMIT: "routePermitExpiresAt",
};

/** The FleetDocument category a kind's proof document must carry (the
 * matching-category rule — a BLUEBOOK renewal links a BLUEBOOK scan). */
const DOCUMENT_CATEGORY_FOR_KIND: Record<RenewalKindName, DocumentCategory> = {
  BLUEBOOK: "BLUEBOOK",
  INSURANCE: "INSURANCE",
  ROUTE_PERMIT: "ROUTE_PERMIT",
};

/** The ExpenseLog categories a kind's cost link may carry (ADR-0049 c4):
 * insurance premiums are INSURANCE; permit fees are PERMIT; a Bluebook
 * renewal's government fee is filed as PERMIT or OTHER in the Phase-1
 * category set (there is no BLUEBOOK expense category on purpose). */
const EXPENSE_CATEGORIES_FOR_KIND: Record<RenewalKindName, readonly ExpenseCategory[]> = {
  BLUEBOOK: ["PERMIT", "OTHER"],
  INSURANCE: ["INSURANCE"],
  ROUTE_PERMIT: ["PERMIT"],
};

/** A history row with its linked proof/cost SUMMARIES nested (F5's read
 * shape): the web renders the document's title as an Open link and the
 * expense's amount via formatNpr without N+1 fetches. Slim selects only —
 * never the full linked rows. */
export type RenewalRecordWithLinks = RenewalRecord & {
  document: { id: string; title: string } | null;
  expenseLog: { id: string; amountPaisa: number } | null;
};

export interface RenewalsListResult {
  items: RenewalRecordWithLinks[];
  total: number;
  skip: number;
  take: number;
}

@Injectable()
export class RenewalsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly documents: DocumentsService,
  ) {}

  /**
   * The atomic renew (ADR-0049 c4). Returns the created record; the vehicle's
   * matching expiry + identity fields are updated in the same commit. The
   * reminder re-arms for free: the new expiry is a new NotificationLog
   * occurrenceKey (zero notification-code involvement).
   */
  async renew(
    vehicleId: string,
    input: CreateRenewalInput,
    createdById: string,
  ): Promise<RenewalRecord> {
    const vehicle = await this.prisma.vehicle.findUnique({ where: { id: vehicleId } });
    if (vehicle === null) {
      throw new NotFoundException(`Vehicle ${vehicleId} not found.`);
    }

    if (input.documentId !== undefined) {
      await this.documents.assertLinkableToVehicle(
        input.documentId,
        vehicleId,
        DOCUMENT_CATEGORY_FOR_KIND[input.kind],
      );
    }
    if (input.expenseLogId !== undefined) {
      await this.assertExpenseLogLinkable(input.expenseLogId, vehicleId, input.kind);
    }

    // The server-side pre-image snapshot (the first pre-image audit outside
    // AgentAction.previousJson): read the OLD expiry from the vehicle row the
    // transaction is about to update — never from the client.
    const previousExpiresAt = vehicle[EXPIRY_FIELD[input.kind]];

    const vehicleData = this.vehicleUpdateFor(input);

    return this.prisma.$transaction(async (tx) => {
      const record = await tx.renewalRecord.create({
        data: {
          vehicleId,
          kind: input.kind,
          previousExpiresAt,
          newExpiresAt: input.newExpiresAt,
          renewedAt: input.renewedAt ?? new Date(),
          documentId: input.documentId ?? null,
          expenseLogId: input.expenseLogId ?? null,
          notes: input.notes === undefined || input.notes.length === 0 ? null : input.notes,
          createdById,
        },
      });
      await tx.vehicle.update({ where: { id: vehicleId }, data: vehicleData });
      return record;
    });
  }

  /** The per-vehicle renewal history, newest first. 404s a ghost vehicle so
   * an empty history and a wrong id are distinguishable. */
  async list(
    vehicleId: string,
    {
      kind,
      skip = 0,
      take = LIST_TAKE_DEFAULT,
    }: { kind?: RenewalKindName; skip?: number; take?: number },
  ): Promise<RenewalsListResult> {
    const vehicle = await this.prisma.vehicle.findUnique({
      where: { id: vehicleId },
      select: { id: true },
    });
    if (vehicle === null) {
      throw new NotFoundException(`Vehicle ${vehicleId} not found.`);
    }

    const safeSkip = Number.isFinite(skip) ? Math.max(Math.floor(skip), 0) : 0;
    const safeTakeRaw = Number.isFinite(take) ? Math.floor(take) : LIST_TAKE_DEFAULT;
    const safeTake = Math.min(Math.max(safeTakeRaw, LIST_TAKE_MIN), LIST_TAKE_MAX);

    const where: Prisma.RenewalRecordWhereInput = {
      vehicleId,
      ...(kind !== undefined ? { kind } : {}),
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.renewalRecord.findMany({
        where,
        orderBy: [{ renewedAt: "desc" }, { id: "asc" }],
        skip: safeSkip,
        take: safeTake,
        // The F5 read shape: nest the linked proof/cost summaries (slim
        // selects) so the history table renders titles and amounts without
        // N+1 fetches. Absent links stay null.
        include: {
          document: { select: { id: true, title: true } },
          expenseLog: { select: { id: true, amountPaisa: true } },
        },
      }),
      this.prisma.renewalRecord.count({ where }),
    ]);
    return { items, total, skip: safeSkip, take: safeTake };
  }

  /** The vehicle-side write for a renewal: the kind's expiry plus whichever
   * of the kind's identity fields the operator supplied (absent = the
   * vehicle's existing value stands — the conditional pass-through rule). */
  private vehicleUpdateFor(input: CreateRenewalInput): Prisma.VehicleUpdateInput {
    const data: Prisma.VehicleUpdateInput = {
      [EXPIRY_FIELD[input.kind]]: input.newExpiresAt,
    };
    if (input.kind === "BLUEBOOK" && input.bluebookNumber !== undefined) {
      data.bluebookNumber = input.bluebookNumber;
    }
    if (input.kind === "INSURANCE") {
      if (input.insurer !== undefined) data.insurer = input.insurer;
      if (input.insurancePolicyNumber !== undefined) {
        data.insurancePolicyNumber = input.insurancePolicyNumber;
      }
      if (input.insuranceType !== undefined) data.insuranceType = input.insuranceType;
    }
    if (input.kind === "ROUTE_PERMIT" && input.routePermitNumber !== undefined) {
      data.routePermitNumber = input.routePermitNumber;
    }
    return data;
  }

  /** The cost link-check — the ServiceRecords.assertExpenseLogLinkable rule
   * with the per-kind category set (link, never copy, never create inline). */
  private async assertExpenseLogLinkable(
    expenseLogId: string,
    vehicleId: string,
    kind: RenewalKindName,
  ): Promise<void> {
    const expense = await this.prisma.expenseLog.findUnique({
      where: { id: expenseLogId },
      select: { category: true, vehicleId: true },
    });
    if (expense === null) {
      throw new BadRequestException(`Expense log ${expenseLogId} does not exist.`);
    }
    const allowed = EXPENSE_CATEGORIES_FOR_KIND[kind];
    if (!allowed.includes(expense.category)) {
      throw new BadRequestException(
        `Expense log ${expenseLogId} is category ${expense.category}; a ${kind} renewal can ` +
          `only link a ${allowed.join(" or ")} expense.`,
      );
    }
    if (expense.vehicleId !== vehicleId) {
      throw new BadRequestException(
        `Expense log ${expenseLogId} is not attributed to this vehicle; a renewal must ` +
          "reference an expense on the same vehicle.",
      );
    }
  }
}
