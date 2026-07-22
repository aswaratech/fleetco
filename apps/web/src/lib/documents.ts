// Fleet-document display helpers (ADR-0049 F4). Mirrors the API's
// documents.schemas.ts vocabulary: the category union, the per-entity
// category matrices (which papers may attach to which entity — the create
// form narrows its select from these), and the byte-size formatter the
// documents table renders. Pure module — no fetch, no React.

export type DocumentCategory =
  | "BLUEBOOK"
  | "INSURANCE"
  | "ROUTE_PERMIT"
  | "AGREEMENT"
  | "LICENSE"
  | "ID_DOCUMENT"
  | "OTHER";

export type DocumentEntityType = "VEHICLE" | "DRIVER" | "CUSTOMER";

/** The FleetDocument wire shape (dates as ISO strings; `entityType` is the
 * API-derived convenience field). */
export interface FleetDocumentListItem {
  id: string;
  vehicleId: string | null;
  driverId: string | null;
  customerId: string | null;
  entityType: DocumentEntityType;
  category: DocumentCategory;
  title: string;
  notes: string | null;
  expiresAt: string | null;
  contentType: string;
  sizeBytes: number;
  createdAt: string;
}

export interface DocumentsListResponse {
  items: FleetDocumentListItem[];
  total: number;
  skip: number;
  take: number;
}

export const DOCUMENT_CATEGORY_LABELS: Record<DocumentCategory, string> = {
  BLUEBOOK: "Bluebook",
  INSURANCE: "Insurance",
  ROUTE_PERMIT: "Route permit",
  AGREEMENT: "Agreement",
  LICENSE: "License",
  ID_DOCUMENT: "ID document",
  OTHER: "Other",
};

// The per-entity category matrix — must mirror the API's
// documents.schemas.ts (VEHICLE_/DRIVER_/CUSTOMER_DOCUMENT_CATEGORIES).
export const ENTITY_DOCUMENT_CATEGORIES: Record<DocumentEntityType, readonly DocumentCategory[]> = {
  VEHICLE: ["BLUEBOOK", "INSURANCE", "ROUTE_PERMIT", "AGREEMENT", "OTHER"],
  DRIVER: ["LICENSE", "ID_DOCUMENT", "AGREEMENT", "OTHER"],
  CUSTOMER: ["AGREEMENT", "OTHER"],
};

/** The multipart field name each entity kind rides on the create body. */
export const ENTITY_FIELD: Record<DocumentEntityType, "vehicleId" | "driverId" | "customerId"> = {
  VEHICLE: "vehicleId",
  DRIVER: "driverId",
  CUSTOMER: "customerId",
};

/**
 * Compact byte-size display for the documents table: `640 B`, `12.4 KB`,
 * `1.2 MB`. One decimal above the unit boundary, none for bytes; the 10 MB
 * upload ceiling keeps GB out of scope by construction.
 */
export function formatBytes(sizeBytes: number): string {
  if (!Number.isFinite(sizeBytes) || sizeBytes < 0) return "—";
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  const kb = sizeBytes / 1024;
  if (kb < 1024) return `${kb >= 100 ? Math.round(kb) : kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  return `${mb >= 100 ? Math.round(mb) : mb.toFixed(1)} MB`;
}
