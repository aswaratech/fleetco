"use server";

import { revalidatePath } from "next/cache";

import { apiFetch, ApiError } from "@/lib/api";
import type { FleetDocumentListItem } from "@/lib/documents";

// Server actions for the fleet-documents write path (ADR-0049 F4). The
// upload passes the client-built multipart FormData straight through
// apiFetch (which only sets content-type for its `json` sugar, so the
// multipart boundary survives — the chat uploadAttachmentAction precedent);
// the delete calls the ADMIN-only endpoint and revalidates the owning
// entity page. Errors reshape into the house structured result the client
// islands render inline.

export interface DocumentActionError {
  ok: false;
  message: string;
  status: number;
}

export type UploadDocumentResult =
  | { ok: true; document: FleetDocumentListItem }
  | DocumentActionError;
export type DeleteDocumentResult = { ok: true } | DocumentActionError;

function failureOf(error: unknown): DocumentActionError {
  if (error instanceof ApiError) {
    return { ok: false, message: error.message, status: error.status };
  }
  return { ok: false, message: "Something went wrong. Try again.", status: 500 };
}

/**
 * Upload one document. `entityPath` is the owning detail page's path (e.g.
 * `/vehicles/abc123`) — revalidated on success so the section shows the new
 * row when the form navigates back.
 */
export async function uploadDocumentAction(
  entityPath: string,
  formData: FormData,
): Promise<UploadDocumentResult> {
  try {
    const document = await apiFetch<FleetDocumentListItem>("/api/v1/documents", {
      method: "POST",
      body: formData,
    });
    revalidatePath(entityPath);
    return { ok: true, document };
  } catch (error) {
    return failureOf(error);
  }
}

/** ADMIN-only delete (the API's documents:delete gate is the real wall —
 * the UI merely hides the affordance from office staff). */
export async function deleteDocumentAction(
  documentId: string,
  entityPath: string,
): Promise<DeleteDocumentResult> {
  try {
    await apiFetch<void>(`/api/v1/documents/${encodeURIComponent(documentId)}`, {
      method: "DELETE",
    });
    revalidatePath(entityPath);
    return { ok: true };
  } catch (error) {
    return failureOf(error);
  }
}
