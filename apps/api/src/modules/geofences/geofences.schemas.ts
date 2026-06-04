import { z } from "zod";

import { PolygonParam, type ParsedPolygon } from "../../common/wkt";

// Zod schemas for the Geofences slice (ADR-0030 G2). Mirrors the proven
// aggregate pattern (customers.schemas.ts / jobs.schemas.ts / fuel-logs):
// enum lists duplicated from the Prisma enum (so this validation file does
// NOT pull the Prisma runtime), `.strict()` on every object so a typo'd or
// server-controlled key surfaces as HTTP 400, comma-separated multi-value
// enum filters via `csvEnum`, and an explicit pagination ceiling mirrored
// from the service-side LIST_TAKE_MAX.
//
// THE BOUNDARY REPRESENTATION (ADR-0030 commitment 1): the write schemas
// accept the polygon boundary as the SAME `lon,lat;lon,lat;…` vertex string
// the GPS T5 geofence-status query already parses — via the SHARED
// `PolygonParam` from common/wkt (extracted in G2 so a stored fence and a
// query-param fence are byte-identical WKT). After the transform, the
// `boundary` field is a `ParsedPolygon` ({ wkt, vertexCount }); the service
// stores `boundary.wkt` into the canonical `boundaryWkt` text column and the
// database derives the geometry(Polygon,4326) from it.

// GeofenceType enum — must mirror GeofenceType in prisma/schema.prisma. Order
// matches the Prisma enum so an audit grep finds both lists side by side; the
// order has no runtime significance. Duplicated as a const (not imported from
// @prisma/client) so this schema file stays runtime-free, the same convention
// every other aggregate's schema follows.
const GEOFENCE_TYPES = ["DEPOT", "CUSTOMER_SITE", "ROUTE_CORRIDOR"] as const;
export type GeofenceTypeName = (typeof GEOFENCE_TYPES)[number];

// Whitelist of sortable columns (kickoff: name / createdAt / type). Allowing
// an arbitrary column would invite expensive sorts and accidental information
// disclosure (`sortBy=boundaryWkt` would expose ordering signal over the
// geometry text) — the same defense the customers / jobs / fuel-logs schemas
// document. `type` is on the whitelist because "group by fence kind" is a
// routine admin sort and the model has a @@index([type]).
const SORTABLE_COLUMNS = ["name", "createdAt", "type"] as const;
export type GeofenceSortColumn = (typeof SORTABLE_COLUMNS)[number];

const SORT_DIRECTIONS = ["asc", "desc"] as const;
export type GeofenceSortDir = (typeof SORT_DIRECTIONS)[number];

// Pagination ceiling duplicated from geofences.service.ts on purpose: the
// service is the runtime authority (the schema can only validate what the
// client sent; it cannot speak for the database). Both constants must move
// together when one changes; the same coupling every list schema documents.
const QUERY_MAX_TAKE = 200;

// Name bounds. Trimmed + required non-empty (an all-whitespace value collapses
// to "" after trim and fails). Max length is loose (256) to accommodate
// Nepali transliterated site names.
const Name = z.string().trim().min(1, "Name is required.").max(256, "Name is too long.");

const GeofenceTypeEnum = z.enum(GEOFENCE_TYPES, {
  error: () => `Type must be one of: ${GEOFENCE_TYPES.join(", ")}.`,
});

// cuid shape for the `customerId` FK, identical to the fuel-logs / telematics
// `Cuid` helper: loose enough to accept any Prisma `cuid()` without the false
// rejections zod's strict `.cuid()` produces on some toolchain versions, tight
// enough to keep query-string / body garbage out. A stale-but-cuid-shaped id
// slips through to the service and fails the insert (Prisma P2003 → 400 with a
// field-level error) there.
const Cuid = z
  .string()
  .trim()
  .min(1, "Required.")
  .regex(/^c[a-z0-9]{8,}$/i, "Must be a valid id.");

// `customerId` list filter: cuid-shaped, single value. An empty string (e.g.
// `?customerId=`) normalizes to `undefined` so the service omits the filter
// rather than asking Prisma for `where customerId = ''`. Same shape as the
// fuel-logs CuidFilter.
const CuidFilter = z
  .string()
  .optional()
  .transform((raw, ctx): string | undefined => {
    if (raw === undefined) return undefined;
    const trimmed = raw.trim();
    if (trimmed.length === 0) return undefined;
    if (!/^c[a-z0-9]{8,}$/i.test(trimmed)) {
      ctx.addIssue({ code: "custom", message: "Must be a valid id." });
      return z.NEVER;
    }
    return trimmed;
  });

// Helper: turn a single-string-or-comma-separated query value into a
// validated, deduplicated array of enum members (reused by `type`). An empty
// result (e.g. `?type=`) maps to `undefined` so the service omits the filter
// rather than asking Prisma for `where type in ()` (which matches zero rows).
// Identical in shape to every other aggregate's csvEnum.
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
          ctx.addIssue({ code: "custom", message: `Must be one of: ${values.join(", ")}.` });
          return z.NEVER;
        }
        seen.add(parsed.data);
      }
      return Array.from(seen);
    });
}

// Coerce a string-typed query param to a non-negative integer with bounds
// checking. Out-of-range values return 400 with a clear message rather than
// being silently clamped — a deliberate `take=10000` clamped to 200 would
// surprise an API consumer. Same helper shape as every other list schema.
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

// GET /api/v1/geofences query parameters. Filter (type / customerId) + sort +
// pagination, mirroring the customers / jobs list contracts. `.strict()` so a
// typo'd query key (e.g. `?tyep=DEPOT`) surfaces as 400 rather than being
// silently ignored.
export const ListGeofencesQuerySchema = z
  .object({
    type: csvEnum(GEOFENCE_TYPES),
    customerId: CuidFilter,
    sortBy: z.enum(SORTABLE_COLUMNS).optional(),
    sortDir: z.enum(SORT_DIRECTIONS).optional(),
    skip: intParam(0, Number.MAX_SAFE_INTEGER, "skip"),
    take: intParam(1, QUERY_MAX_TAKE, "take"),
  })
  .strict();

export type ListGeofencesQuery = z.infer<typeof ListGeofencesQuerySchema>;

// ---------------------------------------------------------------------------
// The type/ownership invariant (ADR-0030 commitment 4).
// ---------------------------------------------------------------------------
//
// A CUSTOMER_SITE fence belongs to a Customer (its boundary is Tier-3 customer
// data); DEPOT and ROUTE_CORRIDOR fences are company-owned and have no
// customer. The rule is NOT a database constraint (the FK is merely nullable),
// so it is enforced here. Exported as a plain function — mirroring the Jobs
// `validateJobCrossFields` / Trips approach — so the SERVICE can re-run the
// SAME rule against the MERGED shape on PATCH: a PATCH that changes only `type`
// must re-validate against the row's stored `customerId`, and a PATCH that
// changes only `customerId` against the stored `type`. The schema layer can
// only see the request body, so the merged-shape authority is the service.

export interface GeofenceOwnershipShape {
  type: GeofenceTypeName;
  // null / undefined both mean "no owning customer".
  customerId: string | null | undefined;
}

/**
 * Validate the geofence type/ownership invariant. Returns a list of
 * human-readable error messages; an empty array means valid.
 *
 *   - CUSTOMER_SITE requires a non-null customerId.
 *   - DEPOT / ROUTE_CORRIDOR require customerId to be null.
 */
export function validateGeofenceOwnership(shape: GeofenceOwnershipShape): string[] {
  const errors: string[] = [];
  const hasCustomer = shape.customerId !== null && shape.customerId !== undefined;
  if (shape.type === "CUSTOMER_SITE" && !hasCustomer) {
    errors.push("A CUSTOMER_SITE geofence requires a customerId.");
  }
  if (shape.type !== "CUSTOMER_SITE" && hasCustomer) {
    errors.push(`A ${shape.type} geofence must not have a customerId.`);
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Write-path schemas — POST and PATCH bodies.
// ---------------------------------------------------------------------------
//
// Both schemas are `.strict()` so server-controlled / derived keys are
// rejected on the wire with HTTP 400 rather than silently dropped:
//
//   - `createdById` is filled from the authenticated session (ADR-0021) and
//     must never be accepted from the body.
//   - `geometry` is GENERATED in the database from `boundaryWkt`; a client
//     can never supply it.
//   - `id` / `createdAt` / `updatedAt` are server-owned by Prisma convention.
//   - `boundaryWkt` itself is not a wire field either — the client sends the
//     `lon,lat;…` `boundary` representation and the service derives the WKT.
//
// The only accepted keys are `name`, `type`, `boundary`, and `customerId`.

/**
 * POST /api/v1/geofences body schema. Required: name, type, boundary.
 * Optional: customerId (required for CUSTOMER_SITE, forbidden otherwise — see
 * the superRefine). The `boundary` is the shared `lon,lat;…` PolygonParam
 * (ADR-0030 c1); the resulting WKT is what the service stores.
 */
export const CreateGeofenceSchema = z
  .object({
    name: Name,
    type: GeofenceTypeEnum,
    boundary: PolygonParam,
    customerId: Cuid.nullable().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    // The type/ownership invariant runs at the schema layer on create (the
    // full shape is present). On PATCH the service re-runs it against the
    // merged shape. Issues are pinned to `customerId` so the G3 form can
    // highlight the right input.
    for (const message of validateGeofenceOwnership({
      type: value.type,
      customerId: value.customerId ?? null,
    })) {
      ctx.addIssue({ code: "custom", message, path: ["customerId"] });
    }
  });

export type CreateGeofenceInput = z.infer<typeof CreateGeofenceSchema>;

/**
 * PATCH /api/v1/geofences/:id body schema. Every field is optional
 * (diff-PATCH semantics). All four are mutable:
 *
 *   - `name` — rename.
 *   - `type` — re-classify (re-validated against the merged customerId).
 *   - `boundary` — redraw; the service re-runs the ST_IsValid gate (a PATCH
 *     that changes the boundary re-runs the same validity check as create).
 *   - `customerId` — re-own (re-validated against the merged type); explicit
 *     `null` clears the owner.
 *
 * The type/ownership invariant is NOT superRefined here — a partial body may
 * omit `type` (or `customerId`), so the rule can only be decided against the
 * merged shape, which is the service's job (mirror of the fuel-logs /
 * expense-logs service-layer cross-field check).
 */
export const UpdateGeofenceSchema = z
  .object({
    name: Name.optional(),
    type: GeofenceTypeEnum.optional(),
    boundary: PolygonParam.optional(),
    customerId: Cuid.nullable().optional(),
  })
  .strict()
  .refine((data) => Object.keys(data).length > 0, {
    message: "At least one field is required.",
  });

export type UpdateGeofenceInput = z.infer<typeof UpdateGeofenceSchema>;

// Re-export the shared ParsedPolygon so service / test call sites can import
// the boundary type from this module alongside the input types.
export type { ParsedPolygon };
