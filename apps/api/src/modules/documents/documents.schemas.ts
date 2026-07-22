import { z } from "zod";

// Zod schemas for the FleetDocument aggregate (ADR-0049 F2). Mirrors the
// proven aggregate pattern (geofences.schemas.ts / customers.schemas.ts):
// enum lists duplicated from the Prisma enum so this validation file stays
// runtime-free, `.strict()` on every object so a typo'd or server-controlled
// key surfaces as HTTP 400, and the pagination ceiling mirrored from the
// service-side LIST_TAKE_MAX.
//
// MULTIPART NOTE (the one shape divergence from JSON aggregates): the create
// path arrives as multipart/form-data, so EVERY field is a string on the wire
// — the create schema validates the string fields that ride BESIDE the file
// part; the file itself is multer's business (the controller's
// FileInterceptor + the service's magic-byte sniff).

// DocumentCategory enum — must mirror DocumentCategory in prisma/schema.prisma.
const DOCUMENT_CATEGORIES = [
  "BLUEBOOK",
  "INSURANCE",
  "ROUTE_PERMIT",
  "AGREEMENT",
  "LICENSE",
  "ID_DOCUMENT",
  "OTHER",
] as const;
export type DocumentCategoryName = (typeof DOCUMENT_CATEGORIES)[number];

// The per-entity category matrix (ADR-0049 c3): which papers may attach to
// which entity. Exported for the service's enforcement and the tests' pinning.
export const VEHICLE_DOCUMENT_CATEGORIES: readonly DocumentCategoryName[] = [
  "BLUEBOOK",
  "INSURANCE",
  "ROUTE_PERMIT",
  "AGREEMENT",
  "OTHER",
];
export const DRIVER_DOCUMENT_CATEGORIES: readonly DocumentCategoryName[] = [
  "LICENSE",
  "ID_DOCUMENT",
  "AGREEMENT",
  "OTHER",
];
export const CUSTOMER_DOCUMENT_CATEGORIES: readonly DocumentCategoryName[] = ["AGREEMENT", "OTHER"];

// Whitelist of sortable columns. `expiresAt` is on the whitelist because
// "what expires next" is the operator's routine question and the model has
// an @@index([expiresAt]); `title` for the alphabetical scan.
const SORTABLE_COLUMNS = ["createdAt", "expiresAt", "title"] as const;
export type DocumentSortColumn = (typeof SORTABLE_COLUMNS)[number];

const SORT_DIRECTIONS = ["asc", "desc"] as const;
export type DocumentSortDir = (typeof SORT_DIRECTIONS)[number];

// Pagination ceiling duplicated from documents.service.ts on purpose (the
// service is the runtime authority); both constants move together.
const QUERY_MAX_TAKE = 200;

const DocumentCategoryEnum = z.enum(DOCUMENT_CATEGORIES, {
  error: () => `Category must be one of: ${DOCUMENT_CATEGORIES.join(", ")}.`,
});

// Title bounds: trimmed, required, loose max (256) for transliterated names.
// The UI's helper text (not this schema) carries the "no license/ID numbers
// in titles" Tier-discipline nudge — free text cannot be machine-policed.
const Title = z.string().trim().min(1, "Title is required.").max(256, "Title is too long.");

// Notes: optional; empty collapses to undefined (the create) / null (the
// PATCH clear) at the call sites below.
const Notes = z.string().trim().max(2048, "Notes are too long.");

// cuid shape, identical to the geofences/fuel-logs Cuid helper.
const Cuid = z
  .string()
  .trim()
  .min(1, "Required.")
  .regex(/^c[a-z0-9]{8,}$/i, "Must be a valid id.");

// Multipart string fields arrive as "" when the form sends an empty input;
// normalize to undefined BEFORE the cuid/date checks so an empty picker means
// "not set", mirroring the env-var emptyStringAsUndefined convention.
const OptionalMultipartCuid = z
  .string()
  .optional()
  .transform((raw) => {
    if (raw === undefined) return undefined;
    const trimmed = raw.trim();
    return trimmed.length === 0 ? undefined : trimmed;
  })
  .pipe(Cuid.optional());

const OptionalMultipartDate = z
  .string()
  .optional()
  .transform((raw, ctx): Date | undefined => {
    if (raw === undefined) return undefined;
    const trimmed = raw.trim();
    if (trimmed.length === 0) return undefined;
    const parsed = new Date(trimmed);
    if (Number.isNaN(parsed.getTime())) {
      ctx.addIssue({ code: "custom", message: "Must be an ISO date." });
      return z.NEVER;
    }
    return parsed;
  });

/**
 * The multipart string fields riding beside the `file` part on
 * `POST /api/v1/documents`. Exactly ONE of vehicleId / driverId / customerId
 * must be set — the superRefine names the offending shape so the form can
 * surface it; the service re-checks (it is the single writer and the DB has
 * no CHECK, per the recorded ADR-0049 decision).
 */
export const CreateDocumentSchema = z
  .object({
    vehicleId: OptionalMultipartCuid,
    driverId: OptionalMultipartCuid,
    customerId: OptionalMultipartCuid,
    category: DocumentCategoryEnum,
    title: Title,
    notes: Notes.optional().transform((value) =>
      value === undefined || value.length === 0 ? undefined : value,
    ),
    expiresAt: OptionalMultipartDate,
  })
  .strict()
  .superRefine((data, ctx) => {
    const set = [data.vehicleId, data.driverId, data.customerId].filter(
      (id) => id !== undefined,
    ).length;
    if (set !== 1) {
      ctx.addIssue({
        code: "custom",
        message: "Exactly one of vehicleId, driverId, or customerId must be provided.",
        path: set === 0 ? ["vehicleId"] : ["customerId"],
      });
    }
  });
export type CreateDocumentInput = z.infer<typeof CreateDocumentSchema>;

/**
 * PATCH body (JSON): metadata only — the entity FKs and the stored bytes are
 * immutable (re-attach = delete + re-upload, a deliberate friction on a
 * compliance-evidence surface). `notes`/`expiresAt` accept null to CLEAR.
 */
export const UpdateDocumentSchema = z
  .object({
    title: Title.optional(),
    notes: Notes.nullable()
      .optional()
      .transform((value) => (typeof value === "string" && value.length === 0 ? null : value)),
    expiresAt: z.coerce.date().nullable().optional(),
    category: DocumentCategoryEnum.optional(),
  })
  .strict()
  .refine((data) => Object.keys(data).length > 0, {
    message: "At least one field must be provided.",
  });
export type UpdateDocumentInput = z.infer<typeof UpdateDocumentSchema>;

/**
 * List query: EXACTLY ONE entity filter is required (a fleet-wide unscoped
 * document list is not a v1 surface — ADR-0049 keeps reads entity-anchored),
 * plus an optional category narrow and the standard sort/pagination.
 */
export const ListDocumentsQuerySchema = z
  .object({
    vehicleId: Cuid.optional(),
    driverId: Cuid.optional(),
    customerId: Cuid.optional(),
    category: DocumentCategoryEnum.optional(),
    skip: z.coerce.number().int().min(0).optional(),
    take: z.coerce.number().int().min(1).max(QUERY_MAX_TAKE).optional(),
    sortBy: z.enum(SORTABLE_COLUMNS).optional(),
    sortDir: z.enum(SORT_DIRECTIONS).optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    const set = [data.vehicleId, data.driverId, data.customerId].filter(
      (id) => id !== undefined,
    ).length;
    if (set !== 1) {
      ctx.addIssue({
        code: "custom",
        message: "Exactly one of vehicleId, driverId, or customerId must be provided.",
        path: ["vehicleId"],
      });
    }
  });
export type ListDocumentsQuery = z.infer<typeof ListDocumentsQuerySchema>;
