import { GeofenceType } from "@prisma/client";
import { z } from "zod";

import { type GeofencesService } from "../../geofences/geofences.service";
import {
  ListGeofencesQuerySchema,
  type GeofenceSortColumn,
} from "../../geofences/geofences.schemas";
import { toQueryShape } from "./query-shape";
import { GetByIdArgs, type ToolDefinition } from "./tool.types";

// Geofence read tools (ADR-0043 c3 stage one). Gate is geofences:read (the
// ADMIN + OFFICE_STAFF read half of ADR-0030 c5's split — the agent reads
// fence CONFIG here, never writes it). The row's boundaryWkt polygon text is
// STRIPPED by the redaction layer before model context (coordinate data has
// no conversational use and egresses to a hosted provider); name/type/
// customer binding pass.

const GEOFENCE_SORT = [
  "name",
  "createdAt",
  "type",
] as const satisfies readonly GeofenceSortColumn[];

const ListGeofencesArgs = z
  .object({
    type: z.array(z.enum(GeofenceType)).optional(),
    customerId: z.string().trim().min(1).optional(),
    sortBy: z.enum(GEOFENCE_SORT).optional(),
    sortDir: z.enum(["asc", "desc"]).optional(),
    skip: z.number().int().min(0).optional(),
    take: z.number().int().min(1).max(200).optional(),
  })
  .strict();

export function buildGeofencesTools(geofences: GeofencesService): ToolDefinition[] {
  return [
    {
      name: "list_geofences",
      description:
        "List geofences (DEPOT / CUSTOMER_SITE / ROUTE_CORRIDOR boundaries) with " +
        "optional type/customerId filters, sorting, pagination (take ≤ 200). " +
        "Boundary geometry is not returned — names, types, and customer bindings are.",
      capabilities: ["geofences:read"],
      riskTier: "read",
      argsSchema: ListGeofencesArgs,
      async execute(args) {
        const query = ListGeofencesQuerySchema.parse(toQueryShape(ListGeofencesArgs.parse(args)));
        return geofences.list(query);
      },
    },
    {
      name: "get_geofence",
      description:
        "Fetch one geofence by id: name, type, owning customer (for CUSTOMER_SITE). " +
        "Boundary geometry is not returned.",
      capabilities: ["geofences:read"],
      riskTier: "read",
      argsSchema: GetByIdArgs,
      async execute(args) {
        const { id } = GetByIdArgs.parse(args);
        return geofences.getById(id);
      },
    },
  ];
}
