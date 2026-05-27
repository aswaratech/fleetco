import { ConflictException, Injectable } from "@nestjs/common";
import { Prisma, type Customer, CustomerStatus } from "@prisma/client";

import type {
  CreateCustomerInput,
  CustomerSortColumn,
  CustomerSortDir,
  UpdateCustomerInput,
} from "./customers.schemas";

// Re-export the schema-inferred types so existing call sites that
// import { CreateCustomerInput, UpdateCustomerInput } from this module
// keep working without churn — the authoritative shape lives next to
// the schema in customers.schemas.ts. Same pattern DriversService
// follows after the iter-7 refactor.
export type { CreateCustomerInput, UpdateCustomerInput };

// PrismaService is injected by NestJS via TypeScript's emitDecoratorMetadata
// (see apps/api/tsconfig.json); the class reference must remain a value
// import at runtime so the DI container can resolve it. Same eslint
// override as the Drivers and Vehicles services.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { PrismaService } from "../prisma/prisma.service";

export interface ListResult {
  items: Customer[];
  total: number;
}

// Prisma's unique-constraint violation code. Surfaced as HTTP 409 by
// the controller rather than 500 so the client can render a clear
// inline message. The translation is documented in
// docs/runbook/api-error-mapping.md and applied identically to
// Vehicles' registrationNumber and Drivers' licenseNumber. Customers'
// only unique column is `panNumber`; a duplicate PAN hits this path.
const PRISMA_UNIQUE_VIOLATION = "P2002";

// Prisma's FK-constraint violation code. Customers has no inbound FKs
// today; the future Jobs aggregate will reference Customer by id with
// onDelete: Restrict per ADR-0003. The translation contract is wired
// here so the Jobs slice can land its FK without re-shaping the delete
// path — same forward-compatible move the Drivers iter-7 P2003 surface
// made for the Trips slice.
const PRISMA_FK_VIOLATION = "P2003";

function isPrismaUniqueViolation(error: unknown): error is Prisma.PrismaClientKnownRequestError {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError && error.code === PRISMA_UNIQUE_VIOLATION
  );
}

function isPrismaFkViolation(error: unknown): error is Prisma.PrismaClientKnownRequestError {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError && error.code === PRISMA_FK_VIOLATION
  );
}

// PAN-number normalization. The Customer.panNumber column has a
// unique index that is case-sensitive at the database level (Postgres
// default), so the service must enforce a normalized form before
// persisting — otherwise "AbC-123" and "abc-123" would both succeed
// and create a duplicate-looking-pair that the index cannot collapse.
// Trim handles trailing whitespace from form submissions; uppercase
// canonicalizes the case. Mirror of how DriversService treats
// licenseNumber (which has the same uniqueness constraint).
//
// Empty string post-trim is treated the same as null — both mean
// "no PAN on record". The caller (create/update) passes the result
// straight through to Prisma so `null` skips the unique check
// entirely (Postgres allows multiple NULLs under a UNIQUE index).
function normalizePanNumber(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  return trimmed.toUpperCase();
}

// Pagination defaults and bounds. Names match the iter-15 kickoff
// (`LIST_TAKE_DEFAULT` / `LIST_TAKE_MAX`) and the iter-6 Drivers
// service naming, so the two surfaces stay grep-symmetric. The take
// cap (200) matches the Drivers and Vehicles caps; the minimum take
// (1) prevents the degenerate count-only request through this endpoint.
//
// LIST_TAKE_MAX is defense-in-depth: the controller validates `take`
// against the same ceiling via `ListCustomersQuerySchema`, but the
// service is also reachable from future internal callers (the Jobs
// slice will fetch a customer by id during job creation), and a clamp
// here ensures the database is never asked for an unbounded result
// regardless of how the call site reaches the service.
export const LIST_TAKE_DEFAULT = 20;
export const LIST_TAKE_MAX = 200;
const LIST_TAKE_MIN = 1;

@Injectable()
export class CustomersService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * List customers. Supports filtering by status, sorting by a
   * whitelisted column, and pagination. `total` reflects the filtered
   * count so the UI can render correct "Showing M–N of T" copy and
   * disable next-page at the edge.
   *
   * Defaults (when the caller passes no overrides): 20 rows, newest
   * first by createdAt. `sortBy=createdAt, sortDir=desc` matches the
   * Drivers and Vehicles surfaces and the established list-page
   * convention. The `id` secondary tiebreaker (when createdAt itself
   * is the primary) or the `createdAt` secondary (when any other
   * column is primary) is preserved so paginated results are
   * deterministic — without it, two rows with identical primary sort
   * values can flip between page loads and either duplicate or skip
   * a row.
   *
   * `skip` and `take` are clamped to safe bounds (`LIST_TAKE_MAX = 200`)
   * as a defense-in-depth: the controller validates `take` against the
   * same ceiling via `ListCustomersQuerySchema`, but the service may
   * also be called from inside other modules' code paths in future
   * slices (the Jobs slice will fetch a customer by id during job
   * creation), and a clamp here ensures the database is never asked
   * for an unbounded result.
   */
  async list({
    skip = 0,
    take = LIST_TAKE_DEFAULT,
    status,
    sortBy = "createdAt",
    sortDir = "desc",
  }: {
    skip?: number;
    take?: number;
    status?: CustomerStatus[];
    sortBy?: CustomerSortColumn;
    sortDir?: CustomerSortDir;
  }): Promise<ListResult> {
    const safeSkip = Number.isFinite(skip) && skip >= 0 ? Math.floor(skip) : 0;
    const safeTakeRaw = Number.isFinite(take) ? Math.floor(take) : LIST_TAKE_DEFAULT;
    const safeTake = Math.min(Math.max(safeTakeRaw, LIST_TAKE_MIN), LIST_TAKE_MAX);

    // Build the WHERE clause once; reuse it for both findMany and count
    // so `total` matches what findMany would return at skip=0/take=∞.
    // Empty arrays should not produce `in: []` (which would match zero
    // rows in Prisma) — the schema's csvEnum normalizes those to
    // `undefined`, but a belt-and-braces check here keeps the service
    // robust against any future direct caller that doesn't go through
    // the schema.
    const where: Prisma.CustomerWhereInput = {
      ...(status && status.length > 0 ? { status: { in: status } } : {}),
    };

    // Primary sort by the requested column + direction; secondary
    // tie-breaker on createdAt (or id, when createdAt itself is the
    // primary) so paginated results are stable across requests. Same
    // shape as DriversService.list and VehiclesService.list.
    const orderBy: Prisma.CustomerOrderByWithRelationInput[] = [
      { [sortBy]: sortDir } as Prisma.CustomerOrderByWithRelationInput,
      ...(sortBy === "createdAt"
        ? [{ id: sortDir } as Prisma.CustomerOrderByWithRelationInput]
        : [{ createdAt: "desc" } as Prisma.CustomerOrderByWithRelationInput]),
    ];

    const [items, total] = await this.prisma.$transaction([
      this.prisma.customer.findMany({ skip: safeSkip, take: safeTake, where, orderBy }),
      this.prisma.customer.count({ where }),
    ]);

    return { items, total };
  }

  /**
   * Fetch one customer by id. Returns `null` when not found rather
   * than throwing, so the controller can shape the 404 response and
   * the service stays usable from other modules without exception
   * handling for the not-found path. (The future Jobs slice will call
   * this during job creation; an internal caller seeing `null` is
   * more useful than an internal caller catching NotFoundException.)
   */
  async findById(id: string): Promise<Customer | null> {
    return this.prisma.customer.findUnique({ where: { id } });
  }

  /**
   * Create a Customer. `createdById` is supplied by the controller
   * from the authenticated session, not by the client. The iter-16
   * create schema rejects unknown keys via `.strict()`, but the
   * service itself does not depend on that — it accepts only fields
   * from CreateCustomerInput.
   *
   * Defaults and normalization applied at the service layer:
   *   - `status` defaults to `ACTIVE`.
   *   - Optional/nullable fields (contactPerson, email, panNumber,
   *     address) are stored as `null` when absent.
   *   - `panNumber` is trimmed and uppercased before persisting (see
   *     `normalizePanNumber` for the rationale — the database-level
   *     unique index is case-sensitive).
   *
   * Throws ConflictException (HTTP 409) on unique-constraint violation
   * of panNumber per docs/runbook/api-error-mapping.md; everything
   * else propagates and Nest's default exception filter renders 500.
   * The 409 message names the offending PAN and the `field` token
   * "panNumber" lives on the controller-level mapping so the web
   * action layer can surface it as a field-level error.
   */
  async create(input: CreateCustomerInput, createdById: string): Promise<Customer> {
    const normalizedPan = normalizePanNumber(input.panNumber ?? null);
    const data: Prisma.CustomerUncheckedCreateInput = {
      name: input.name,
      contactPerson: input.contactPerson ?? null,
      phone: input.phone,
      email: input.email ?? null,
      panNumber: normalizedPan,
      address: input.address ?? null,
      status: input.status ?? CustomerStatus.ACTIVE,
      createdById,
    };

    try {
      return await this.prisma.customer.create({ data });
    } catch (error) {
      if (isPrismaUniqueViolation(error)) {
        // The only unique column on Customer is panNumber. Name the
        // offending value in the message per the runbook's "name the
        // conflicting field" convention; the controller layer maps
        // this to HTTP 409 and adds the `field: "panNumber"` hint to
        // the response body.
        throw new ConflictException(`A customer with PAN ${normalizedPan ?? ""} already exists.`);
      }
      throw error;
    }
  }

  /**
   * Partial update. The controller's validation guarantees the body
   * is non-empty (`.refine` on UpdateCustomerSchema) and contains only
   * mutable fields (`.strict()`). The service distinguishes "client
   * provided null" (clear the field) from "client did not mention"
   * (leave the field alone) via hasOwnProperty for nullable optional
   * fields. Mirror of how DriversService.update handles dateOfBirth
   * and terminatedAt.
   *
   * `panNumber` is normalized when the client mentions it; an
   * explicit `null` clears the column. A whitespace-only string is
   * treated as `null` so an operator who blanks out the PAN field on
   * the web form does not get a "name your value" 400 — the
   * normalizer collapses the input to null.
   *
   * Returns null when the customer is not found, mirroring findById's
   * shape so the controller can shape the 404 response.
   */
  async update(id: string, input: UpdateCustomerInput): Promise<Customer | null> {
    const existing = await this.prisma.customer.findUnique({ where: { id } });
    if (!existing) {
      return null;
    }

    // Compute the normalized PAN once when the client mentions the
    // field, so the catch block below can include the offending value
    // in the 409 message. (The Drivers analogue uses input.licenseNumber
    // directly; here we use the normalized form because that is what
    // hit the unique index.)
    const clientProvidedPan = Object.prototype.hasOwnProperty.call(input, "panNumber");
    const normalizedPan = clientProvidedPan ? normalizePanNumber(input.panNumber ?? null) : null;

    const data: Prisma.CustomerUpdateInput = {
      ...(input.name !== undefined && { name: input.name }),
      ...(Object.prototype.hasOwnProperty.call(input, "contactPerson") && {
        contactPerson: input.contactPerson ?? null,
      }),
      ...(input.phone !== undefined && { phone: input.phone }),
      ...(Object.prototype.hasOwnProperty.call(input, "email") && {
        email: input.email ?? null,
      }),
      ...(clientProvidedPan && { panNumber: normalizedPan }),
      ...(Object.prototype.hasOwnProperty.call(input, "address") && {
        address: input.address ?? null,
      }),
      ...(input.status !== undefined && { status: input.status }),
    };

    try {
      return await this.prisma.customer.update({ where: { id }, data });
    } catch (error) {
      if (isPrismaUniqueViolation(error)) {
        throw new ConflictException(`A customer with PAN ${normalizedPan ?? ""} already exists.`);
      }
      throw error;
    }
  }

  /**
   * Hard delete. Returns true on delete, false when the customer was
   * not found, so the controller can shape the 404 response.
   *
   * Forward-compatible FK-violation surface: Customers has no inbound
   * FKs today, but the future Jobs aggregate will reference Customer
   * by id with onDelete: Restrict per ADR-0003. When that lands, a
   * delete against a referenced Customer will raise Prisma P2003;
   * this branch translates it to ConflictException (HTTP 409) with
   * the same message shape DriversService.delete uses for Trips. The
   * forward-compatibility shipment now (rather than once Jobs lands)
   * keeps the iter-17 Jobs migration painless — no service refactor
   * needed, just the FK declaration in schema.prisma and the matching
   * web-side dialog parsing.
   *
   * Today the P2003 branch is dead code (no inbound FKs exist), but
   * the iter-16 service tests pin the contract so a regression is
   * caught the moment the Jobs FK ships.
   */
  async delete(id: string): Promise<boolean> {
    try {
      await this.prisma.customer.delete({ where: { id } });
      return true;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        // P2025 = "An operation failed because it depends on one or
        // more records that were required but not found." Prisma raises
        // this when delete targets a non-existent row.
        if (error.code === "P2025") {
          return false;
        }
        // P2003 = FK constraint violation on the referencing side.
        // Forward-compatible with the future Jobs slice — see the
        // class-level docstring for the rationale. Until Jobs lands,
        // this branch is unreachable in practice; the iter-16 tests
        // assert the message shape so the Jobs FK lands clean.
        if (isPrismaFkViolation(error)) {
          throw new ConflictException(`Cannot delete customer: it is referenced by other records.`);
        }
      }
      throw error;
    }
  }
}
