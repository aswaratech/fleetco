import Link from "next/link";

import { NepaliDate } from "@/components/nepali-date";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { apiFetch } from "@/lib/api";
import { complianceBadgeState } from "@/lib/compliance";
import {
  DOCUMENT_CATEGORY_LABELS,
  ENTITY_FIELD,
  formatBytes,
  type DocumentsListResponse,
  type DocumentEntityType,
} from "@/lib/documents";

import { DeleteDocumentDialog } from "./delete-document-dialog";

interface DocumentsSectionProps {
  entityType: DocumentEntityType;
  entityId: string;
  /** The owning detail page path, e.g. `/vehicles/abc123` (links + revalidation). */
  entityPath: string;
  /** The empty-state noun: "vehicle" / "driver" / "customer". */
  entityNoun: string;
}

interface MeResponse {
  id: string;
  email: string;
  role: string;
}

// The shared Documents section (ADR-0049 F4, DESIGN.md §"Fleet documents &
// renewals") rendered on the vehicle / driver / customer detail pages. A
// SERVER component: it fetches the entity's documents and the /me role
// signal (the delete affordance renders only for ADMIN — the API's
// documents:delete gate is the real wall), and renders the house section
// table. Open links stream through the authed /api/documents/[id] proxy —
// document bytes never get a public URL.
export async function DocumentsSection({
  entityType,
  entityId,
  entityPath,
  entityNoun,
}: DocumentsSectionProps): Promise<React.ReactElement> {
  const [documents, me] = await Promise.all([
    apiFetch<DocumentsListResponse>(
      `/api/v1/documents?${ENTITY_FIELD[entityType]}=${encodeURIComponent(entityId)}&take=200`,
    ),
    apiFetch<MeResponse>("/me"),
  ]);
  const isAdmin = me.role === "ADMIN";

  return (
    <section className="border-border-subtle bg-surface-raised rounded border p-6 shadow-sm">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-text-muted text-xs font-medium uppercase tracking-wide">Documents</h2>
        <Button asChild size="sm" variant="outline">
          <Link href={`${entityPath}/documents/new`}>Add document</Link>
        </Button>
      </div>

      {documents.items.length === 0 ? (
        <p className="text-text-muted text-sm">
          No documents for this {entityNoun}.{" "}
          <Link href={`${entityPath}/documents/new`} className="text-text-accent hover:underline">
            Upload the first document
          </Link>
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Title</TableHead>
              <TableHead>Category</TableHead>
              <TableHead>Expires</TableHead>
              <TableHead className="text-right">Size</TableHead>
              <TableHead>Uploaded</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {documents.items.map((document) => (
              <TableRow key={document.id}>
                <TableCell className="font-medium">{document.title}</TableCell>
                <TableCell>
                  <Badge variant="neutral">{DOCUMENT_CATEGORY_LABELS[document.category]}</Badge>
                </TableCell>
                <TableCell>
                  <DocumentExpiry iso={document.expiresAt} />
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatBytes(document.sizeBytes)}
                </TableCell>
                <TableCell>
                  <NepaliDate iso={document.createdAt} format="bs" />
                </TableCell>
                <TableCell className="text-right">
                  <span className="inline-flex items-center gap-1">
                    <Button asChild variant="ghost" size="sm">
                      {/* target=_blank so a PDF/photo opens beside the page;
                          the proxy route streams inline with the sniffed type. */}
                      <a href={`/api/documents/${document.id}`} target="_blank" rel="noreferrer">
                        Open
                      </a>
                    </Button>
                    {isAdmin ? (
                      <DeleteDocumentDialog
                        documentId={document.id}
                        title={document.title}
                        entityPath={entityPath}
                      />
                    ) : null}
                  </span>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {isAdmin || documents.items.length === 0 ? null : (
        <p className="text-text-muted mt-3 text-xs">Documents can be removed only by an admin.</p>
      )}
    </section>
  );
}

/** The expiry cell: BS date + the shipped compliance badge; em-dash when the
 * document carries no expiry. Mirrors the vehicle page's ComplianceExpiry. */
function DocumentExpiry({ iso }: { iso: string | null }): React.ReactElement {
  if (iso === null) return <span>—</span>;
  const state = complianceBadgeState(iso, new Date());
  return (
    <span className="inline-flex items-center gap-2">
      <NepaliDate iso={iso} format="bs" />
      {state === "expired" ? <Badge variant="error">Expired</Badge> : null}
      {state === "expiring-soon" ? <Badge variant="warning">Expiring soon</Badge> : null}
    </span>
  );
}
