import { z } from "zod";

// Zod schemas for the Sites slice (ADR-0047 W3 — the reusable pinned-location
// aggregate's CRUD surface). This file deliberately mirrors
// apps/api/src/modules/customers/customers.schemas.ts in shape and convention:
// enum lists duplicated from the Prisma enum (so the validation file does not
// pull the Prisma runtime), `.strict()` to reject unknown keys with HTTP 400,
// a comma-separated multi-value enum filter via `csvEnum`, and an explicit
// pagination ceiling mirrored from the service-side LIST_TAKE_MAX constant.
//
// A Site is a geographic PIN (crusher / pit / delivery site / depot), not a
// polygon Geofence. The pin's `latitude`/`longitude` are the canonical
// Prisma-native Float columns; the database derives a generated
// geometry(Point, 4326) column from them (ADR-0047 c4, the GpsPing Point
// hybrid reused). The wire schema therefore accepts ONLY the two floats — never
// `geometry` — and `.strict()` rejects a client that tries to smuggle it.

// SiteKind enum — must mirror SiteKind in prisma/schema.prisma (ADR-0047 c4).
// Order matches the Prisma enum so an audit grep finds both lists side by side;
// the order has no runtime significance.
const SITE_KINDS = ["CRUSHER", "PIT", "DELIVERY_SITE", "DEPOT", "OTHER"] as const;

// Reusable field validators for the write path, mirroring the Customer-slice
// rules (name trimmed + required non-empty; optional free-text fields trimmed
// with a loose max length).
//
//   - name is trimmed and required non-empty (an all-whitespace value collapses
//     to "" after trim and fails). Max length is loose (256) to accommodate
//     Nepali transliterated site names (e.g. "Kalimati Crusher").
//   - kind is a required curated enum — the dispatcher must say what kind of
//     place this is; there is no sensible default (a crusher and a delivery
//     site are different grains), unlike Customer.status which defaults ACTIVE.
//   - address / contactName / contactPhone are optional + nullable free-text
//     strings (the ticket's "optional strings"). Per CLAUDE.md's "no PII-heavy
//     regex" / "loose validation" rule, contactPhone is NOT constrained by the
//     Nepal phone regex the Customer/Driver `phone` fields use — a site contact
//     may be a landline, an extension, or a foreign number, and tightening this
//     into a regex later is an ADR-gated change, not a silent one. contactName
//     and contactPhone are Tier-2 PII (ADR-0047 c6), redacted via the pino
//     `*.contactName` / `*.phone` paths (already on main from W2).
const Name = z.string().trim().min(1, "Name is required.").max(256, "Name is too long.");

const SiteKindEnum = z.enum(SITE_KINDS, {
  error: () => `Kind must be one of: ${SITE_KINDS.join(", ")}.`,
});

// Latitude / longitude — WGS84 decimal degrees, sent as JSON numbers in the
// request body (NOT query strings, so no string coercion — contrast the
// `intParam` helper below, which coerces string query params). The service
// writes ONLY these floats; the database generates the geometry(Point, 4326)
// column from them (X = longitude, Y = latitude — the ST_MakePoint(lon, lat)
// foot-gun the schema doc-comment flags). Out-of-range values return HTTP 400
// with a clear message rather than persisting an impossible pin.
const Latitude = z
  .number({ error: "Latitude is required and must be a number." })
  .min(-90, "Latitude must be between -90 and 90.")
  .max(90, "Latitude must be between -90 and 90.");

const Longitude = z
  .number({ error: "Longitude is required and must be a number." })
  .min(-180, "Longitude must be between -180 and 180.")
  .max(180, "Longitude must be between -180 and 180.");

const Address = z.string().trim().max(512, "Address is too long.");

const ContactName = z.string().trim().max(128, "Contact name is too long.");

const ContactPhone = z.string().trim().max(32, "Contact phone is too long.");

// POST /api/v1/sites request body. Required: name, kind, latitude, longitude.
// Optional + nullable: address, contactName, contactPhone. `createdById` is NOT
// accepted from the client — the controller pulls it from
// `request.session.user.id` (ADR-0021). `geometry` is NOT accepted — it is
// database-generated. `.strict()` rejects either (and any other unknown key)
// with HTTP 400 so a stray field never reaches Prisma.
//
// Optional-and-nullable fields accept `null` as an explicit "absent" marker; a
// missing key is treated the same. Both shapes normalize to `null` at the
// service layer, mirroring how Customers handles contactPerson.
export const CreateSiteSchema = z
  .object({
    name: Name,
    kind: SiteKindEnum,
    latitude: Latitude,
    longitude: Longitude,
    address: Address.nullable().optional(),
    contactName: ContactName.nullable().optional(),
    contactPhone: ContactPhone.nullable().optional(),
  })
  .strict();

export type CreateSiteInput = z.infer<typeof CreateSiteSchema>;

// PATCH /api/v1/sites/:id — partial update. Mirrors the Customers pattern: take
// CreateSiteSchema's shape as `.partial()` (so latitude/longitude stay
// range-checked when present) and reject empty bodies via `.refine` so a no-op
// PATCH surfaces as 400 rather than silently returning the unchanged row.
//
// Every field stays nullable-where-it-was-nullable: the operator can clear a
// previously-entered contactName by sending `null` explicitly (the service
// distinguishes "client provided null" from "client did not mention" via
// hasOwnProperty).
export const UpdateSiteSchema = CreateSiteSchema.partial()
  .strict()
  .refine((data) => Object.keys(data).length > 0, {
    message: "At least one field is required.",
  });

export type UpdateSiteInput = z.infer<typeof UpdateSiteSchema>;

// GET /api/v1/sites query parameters. Filter / sort / pagination contract
// mirrors the Customers list endpoint so the web client's URL-searchParams
// convention (paginator, sortable-header, filter-toolbar) reuses across
// surfaces.
//
// Wire conventions:
//   - `kind` accepts either a single value (`?kind=CRUSHER`) or a
//     comma-separated list (`?kind=CRUSHER,PIT`). Both normalize to a
//     deduplicated array; the service builds a Prisma `in:` filter from it. An
//     empty string (after splitting) is treated as "no filter".
//   - `sortBy` is restricted to a whitelist (`name` / `createdAt`). Allowing an
//     arbitrary column would invite expensive sorts and accidental information
//     disclosure (`sortBy=contactPhone` would leak ordering signal about Tier-2
//     PII — the same defense every list schema documents).
//   - `sortDir` defaults at the controller to `desc` (most-recent-first is the
//     common case for `createdAt`).
//   - `skip` defaults to 0; `take` defaults to 20. The `take` ceiling mirrors
//     the service's LIST_TAKE_MAX so an over-large `take` surfaces as HTTP 400
//     rather than being silently clamped.
const SORTABLE_COLUMNS = ["name", "createdAt"] as const;
export type SiteSortColumn = (typeof SORTABLE_COLUMNS)[number];

const SORT_DIRECTIONS = ["asc", "desc"] as const;
export type SiteSortDir = (typeof SORT_DIRECTIONS)[number];

// Pagination ceiling duplicated from sites.service.ts on purpose: the service
// is the runtime authority (the schema can only validate what the client sent).
// Both constants must move together when one changes.
const QUERY_MAX_TAKE = 200;

// Helper: turn a single-string-or-comma-separated query value into a validated,
// deduplicated array of enum members. Copied verbatim from the Customers /
// Geofences schemas — promoting these list-query helpers to a shared module is
// still deferred (the customers-schema comment flags the same duplication
// budget); this slice keeps the established per-module copy rather than opening
// a cross-cutting refactor inside a feature ticket.
function csvEnum<T extends readonly [string, ...string[]]>(values: T) {
  const member = z.enum(values);
  return z
    .string()
    .optional()
    .transform((raw, ctx): T[number][] | undefined => {
      if (raw === undefined || raw === "") return undefined;
      const parts = raw
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      if (parts.length === 0) return undefined;
      const seen = new Set<T[number]>();
      for (const part of parts) {
        const parsed = member.safeParse(part);
        if (!parsed.success) {
          ctx.addIssue({
            code: "custom",
            message: `Must be one of: ${values.join(", ")}.`,
          });
          return z.NEVER;
        }
        seen.add(parsed.data);
      }
      return Array.from(seen);
    });
}

// Coerce a string-typed query param to a non-negative integer with bounds
// checking. Express's query parser hands us strings; without coercion the
// schema would reject every numeric param. Out-of-range values return 400 with
// a clear message rather than being silently clamped. Copied from
// customers.schemas.ts (see the csvEnum note on the deferred promotion).
function intParam(min: number, max: number, fieldLabel: string) {
  return z
    .string()
    .optional()
    .transform((raw, ctx): number | undefined => {
      if (raw === undefined || raw === "") return undefined;
      const n = Number(raw);
      if (!Number.isFinite(n) || !Number.isInteger(n)) {
        ctx.addIssue({ code: "custom", message: `${fieldLabel} must be an integer.` });
        return z.NEVER;
      }
      if (n < min) {
        ctx.addIssue({ code: "custom", message: `${fieldLabel} must be ${min} or greater.` });
        return z.NEVER;
      }
      if (n > max) {
        ctx.addIssue({ code: "custom", message: `${fieldLabel} must be ${max} or less.` });
        return z.NEVER;
      }
      return n;
    });
}

export const ListSitesQuerySchema = z
  .object({
    kind: csvEnum(SITE_KINDS),
    sortBy: z.enum(SORTABLE_COLUMNS).optional(),
    sortDir: z.enum(SORT_DIRECTIONS).optional(),
    skip: intParam(0, Number.MAX_SAFE_INTEGER, "skip"),
    take: intParam(1, QUERY_MAX_TAKE, "take"),
  })
  // Strict so a typo'd query key (e.g. `?kidn=CRUSHER`) surfaces as 400 rather
  // than being silently ignored. Matches the Customers / Geofences contracts.
  .strict();

export type ListSitesQuery = z.infer<typeof ListSitesQuerySchema>;
