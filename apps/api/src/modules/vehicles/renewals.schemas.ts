import { z } from "zod";

// Zod schemas for the renewal-records slice (ADR-0049 F3). The create body is
// a per-kind discriminated shape flattened into one `.strict()` object: the
// kind selects WHICH vehicle compliance fields may ride along (Bluebook
// number / insurer+policy+type / permit number), and a cross-field superRefine
// rejects fields that do not belong to the chosen kind — so a typo'd payload
// surfaces as a 400 naming the offending field, never a silently-ignored key.

// RenewalKind — must mirror RenewalKind in prisma/schema.prisma (and the
// compliance reminder kinds, the anti-drift rule).
const RENEWAL_KINDS = ["BLUEBOOK", "INSURANCE", "ROUTE_PERMIT"] as const;
export type RenewalKindName = (typeof RENEWAL_KINDS)[number];

// InsuranceType — must mirror InsuranceType in prisma/schema.prisma.
const INSURANCE_TYPES = ["THIRD_PARTY", "COMPREHENSIVE"] as const;

const QUERY_MAX_TAKE = 200;

const Cuid = z
  .string()
  .trim()
  .min(1, "Required.")
  .regex(/^c[a-z0-9]{8,}$/i, "Must be a valid id.");

const FreeText = (max: number) => z.string().trim().min(1).max(max);

// The per-kind field ownership map: which optional vehicle-identity fields a
// renewal of each kind may update alongside the expiry. Exported for the
// service and the tests.
export const KIND_FIELDS: Record<RenewalKindName, readonly string[]> = {
  BLUEBOOK: ["bluebookNumber"],
  INSURANCE: ["insurer", "insurancePolicyNumber", "insuranceType"],
  ROUTE_PERMIT: ["routePermitNumber"],
};

/**
 * POST /api/v1/vehicles/:id/renewals body. `newExpiresAt` is the one hard
 * requirement; `renewedAt` defaults to now at the service; the kind's number
 * fields are optional (an operator may renew without re-keying an unchanged
 * number — the vehicle's existing value stands).
 */
export const CreateRenewalSchema = z
  .object({
    kind: z.enum(RENEWAL_KINDS, {
      error: () => `Kind must be one of: ${RENEWAL_KINDS.join(", ")}.`,
    }),
    newExpiresAt: z.coerce.date(),
    renewedAt: z.coerce.date().optional(),
    bluebookNumber: FreeText(64).optional(),
    insurer: FreeText(128).optional(),
    insurancePolicyNumber: FreeText(64).optional(),
    insuranceType: z.enum(INSURANCE_TYPES).optional(),
    routePermitNumber: FreeText(64).optional(),
    documentId: Cuid.optional(),
    expenseLogId: Cuid.optional(),
    notes: z.string().trim().max(2048).optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    const allowed = new Set(KIND_FIELDS[data.kind]);
    for (const field of Object.values(KIND_FIELDS).flat()) {
      if (!allowed.has(field) && data[field as keyof typeof data] !== undefined) {
        ctx.addIssue({
          code: "custom",
          message: `${field} does not belong to a ${data.kind} renewal.`,
          path: [field],
        });
      }
    }
  });
export type CreateRenewalInput = z.infer<typeof CreateRenewalSchema>;

/** GET /api/v1/vehicles/:id/renewals query — kind filter + pagination;
 * renewedAt desc is the only order (a history reads newest-first). */
export const ListRenewalsQuerySchema = z
  .object({
    kind: z.enum(RENEWAL_KINDS).optional(),
    skip: z.coerce.number().int().min(0).optional(),
    take: z.coerce.number().int().min(1).max(QUERY_MAX_TAKE).optional(),
  })
  .strict();
export type ListRenewalsQuery = z.infer<typeof ListRenewalsQuerySchema>;
