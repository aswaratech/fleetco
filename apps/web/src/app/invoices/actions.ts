"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { apiFetch, ApiError } from "@/lib/api";
import {
  BuildFromJobFormSchema,
  CreateInvoiceFormSchema,
  CreateLineFormSchema,
  UpdateLineFormSchema,
  rupeesStringToPaisa,
  type BuildFromJobFormValues,
  type CreateInvoiceFormValues,
  type CreateLineFormValues,
  type UpdateInvoiceHeaderFormValues,
  type UpdateLineFormValues,
} from "@/lib/invoices-schema";

// Server actions for the Invoices write path (Program D / D6). Every action calls
// apiFetch from the server context (cookies forward automatically) and reshapes
// API errors into a structured result the client can render inline. Success paths
// that navigate use Next.js's redirect (which throws NEXT_REDIRECT, caught by the
// framework as a navigation, NOT a real error); the in-place line actions return
// { ok: true } and the calling island refreshes the route.
//
// Mirror of apps/web/src/app/jobs/actions.ts in shape + error model. The API is
// authoritative: it owns the integer-paisa bounds, the DRAFT-only mutability gate
// (409 on an ISSUED/CANCELLED row), and the issue preconditions (422). This layer
// re-validates client-side (defense in depth), converts the rupees form edge to
// integer paisa, and threads the right field token to the form.

export interface ActionError {
  ok: false;
  message: string;
  status: number;
  field?: string;
}

export interface ActionOk {
  ok: true;
}

// A FK-not-found 400 from the API names the offending field in its message
// ("Customer \"…\" does not exist.", "Job \"…\" does not exist.", "Trip \"…\"
// does not exist."). Map it to the form field token so the picker highlights.
function fieldForFkError(message: string): string | undefined {
  if (/customer .* does not exist/i.test(message)) return "customerId";
  if (/trip .* does not exist/i.test(message)) return "tripId";
  if (
    /job .* does not exist/i.test(message) ||
    /job .* belongs to a different customer/i.test(message)
  )
    return "jobId";
  return undefined;
}

function networkError(): ActionError {
  return { ok: false, message: "Could not reach the FleetCo API. Try again.", status: 0 };
}

// ---------------------------------------------------------------------------
// Header: create DRAFT, edit DRAFT.
// ---------------------------------------------------------------------------

// createInvoiceAction — POSTs a new DRAFT header, then redirects to the edit
// surface so the operator can add lines (the line management lives there). On a
// stale customerId / jobId the API answers 400; we map it to the right picker.
export async function createInvoiceAction(
  values: CreateInvoiceFormValues,
): Promise<ActionError | never> {
  const parsed = CreateInvoiceFormSchema.safeParse(values);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "form"}: ${issue.message}`)
      .join("; ");
    return { ok: false, message: issues, status: 400 };
  }

  // Build the wire body. Optional fields are omitted when blank (the API's schema
  // rejects an empty string for an id / enum); the discount rupees string converts
  // to integer paisa.
  const body: Record<string, unknown> = { customerId: parsed.data.customerId };
  if (parsed.data.jobId && parsed.data.jobId.length > 0) body.jobId = parsed.data.jobId;
  if (parsed.data.serviceType && parsed.data.serviceType.length > 0) {
    body.serviceType = parsed.data.serviceType;
  }
  if (parsed.data.discount && parsed.data.discount.length > 0) {
    body.discountPaisa = rupeesStringToPaisa(parsed.data.discount);
  }

  let created: { id: string };
  try {
    created = await apiFetch<{ id: string }>("/api/v1/invoices", { method: "POST", json: body });
  } catch (error) {
    if (error instanceof ApiError) {
      const field = error.status === 400 ? fieldForFkError(error.message) : undefined;
      return { ok: false, message: error.message, status: error.status, field };
    }
    return networkError();
  }

  revalidatePath("/invoices");
  redirect(`/invoices/${created.id}/edit`);
}

// updateInvoiceHeaderAction — PATCHes only the header fields the operator changed
// (the edit form computes the diff). The changed values are raw form strings; ""
// maps to wire `null` (clear the nullable jobId / serviceType / discount), a
// present value is converted (discount → paisa). customerId is NOT editable here.
// Returns { ok: true } (the calling form refreshes) rather than redirecting — the
// edit page is the DRAFT workbench, so a header save keeps the operator there to
// continue managing lines.
export async function updateInvoiceHeaderAction(
  id: string,
  changed: Partial<UpdateInvoiceHeaderFormValues>,
): Promise<ActionError | ActionOk> {
  const body: Record<string, unknown> = {};
  if (Object.prototype.hasOwnProperty.call(changed, "jobId")) {
    body.jobId = changed.jobId && changed.jobId.length > 0 ? changed.jobId : null;
  }
  if (Object.prototype.hasOwnProperty.call(changed, "serviceType")) {
    body.serviceType =
      changed.serviceType && changed.serviceType.length > 0 ? changed.serviceType : null;
  }
  if (Object.prototype.hasOwnProperty.call(changed, "discount")) {
    body.discountPaisa =
      changed.discount && changed.discount.length > 0
        ? rupeesStringToPaisa(changed.discount)
        : null;
  }

  if (Object.keys(body).length === 0) {
    return { ok: false, message: "Nothing to update.", status: 400 };
  }

  try {
    await apiFetch<unknown>(`/api/v1/invoices/${id}`, { method: "PATCH", json: body });
  } catch (error) {
    if (error instanceof ApiError) {
      const field = error.status === 400 ? fieldForFkError(error.message) : undefined;
      return { ok: false, message: error.message, status: error.status, field };
    }
    return networkError();
  }

  revalidatePath("/invoices");
  revalidatePath(`/invoices/${id}`);
  revalidatePath(`/invoices/${id}/edit`);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Lifecycle transitions: issue, cancel, credit note.
// ---------------------------------------------------------------------------

// issueInvoiceAction — POSTs /:id/issue (the one-way DRAFT → ISSUED transition).
// The API throws 409 (not a DRAFT) or 422 (no lines / no serviceType / supplier
// PAN not configured / R2 not configured / discount > subtotal); those messages
// are already clear + actionable (they name the env var + ADR), so we surface them
// verbatim. On success, redirect to the now-ISSUED detail page.
export async function issueInvoiceAction(id: string): Promise<ActionError | never> {
  try {
    await apiFetch<unknown>(`/api/v1/invoices/${id}/issue`, { method: "POST", json: {} });
  } catch (error) {
    if (error instanceof ApiError) {
      return { ok: false, message: error.message, status: error.status };
    }
    return networkError();
  }

  revalidatePath("/invoices");
  revalidatePath(`/invoices/${id}`);
  redirect(`/invoices/${id}`);
}

// cancelInvoiceAction — POSTs /:id/cancel (DRAFT → CANCELLED). 409 when the row is
// not a DRAFT (an ISSUED invoice's number is permanent — corrected by credit note,
// never cancelled in place). On success, redirect to the (now CANCELLED) detail.
export async function cancelInvoiceAction(id: string): Promise<ActionError | never> {
  try {
    await apiFetch<unknown>(`/api/v1/invoices/${id}/cancel`, { method: "POST", json: {} });
  } catch (error) {
    if (error instanceof ApiError) {
      return { ok: false, message: error.message, status: error.status };
    }
    return networkError();
  }

  revalidatePath("/invoices");
  revalidatePath(`/invoices/${id}`);
  redirect(`/invoices/${id}`);
}

// createCreditNoteAction — POSTs /:id/credit-notes (the ONLY correction path for
// an ISSUED invoice). Returns a CREDIT_NOTE DRAFT (copying the original's lines);
// redirect to ITS edit surface so the operator can adjust + issue it. 409 when the
// original is not an ISSUED INVOICE.
export async function createCreditNoteAction(id: string): Promise<ActionError | never> {
  let created: { id: string };
  try {
    created = await apiFetch<{ id: string }>(`/api/v1/invoices/${id}/credit-notes`, {
      method: "POST",
      json: {},
    });
  } catch (error) {
    if (error instanceof ApiError) {
      return { ok: false, message: error.message, status: error.status };
    }
    return networkError();
  }

  revalidatePath("/invoices");
  revalidatePath(`/invoices/${id}`);
  redirect(`/invoices/${created.id}/edit`);
}

// ---------------------------------------------------------------------------
// Line management (in-place; the calling island refreshes the route on success).
// ---------------------------------------------------------------------------

function revalidateInvoice(id: string): void {
  revalidatePath(`/invoices/${id}`);
  revalidatePath(`/invoices/${id}/edit`);
}

// addLineAction — POSTs one manual line. lineAmountPaisa is derived server-side;
// the unit price converts rupees → paisa here. 409 when the invoice is not a DRAFT.
export async function addLineAction(
  invoiceId: string,
  values: CreateLineFormValues,
): Promise<ActionError | ActionOk> {
  const parsed = CreateLineFormSchema.safeParse(values);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "form"}: ${issue.message}`)
      .join("; ");
    return { ok: false, message: issues, status: 400 };
  }

  const body = {
    description: parsed.data.description,
    quantity: Number(parsed.data.quantity),
    unitPricePaisa: rupeesStringToPaisa(parsed.data.unitPrice),
  };

  try {
    await apiFetch<unknown>(`/api/v1/invoices/${invoiceId}/lines`, { method: "POST", json: body });
  } catch (error) {
    if (error instanceof ApiError) {
      return { ok: false, message: error.message, status: error.status };
    }
    return networkError();
  }

  revalidateInvoice(invoiceId);
  return { ok: true };
}

// updateLineAction — PATCHes a line; the API re-derives lineAmountPaisa.
export async function updateLineAction(
  invoiceId: string,
  lineId: string,
  values: UpdateLineFormValues,
): Promise<ActionError | ActionOk> {
  const parsed = UpdateLineFormSchema.safeParse(values);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "form"}: ${issue.message}`)
      .join("; ");
    return { ok: false, message: issues, status: 400 };
  }

  const body = {
    description: parsed.data.description,
    quantity: Number(parsed.data.quantity),
    unitPricePaisa: rupeesStringToPaisa(parsed.data.unitPrice),
  };

  try {
    await apiFetch<unknown>(`/api/v1/invoices/${invoiceId}/lines/${lineId}`, {
      method: "PATCH",
      json: body,
    });
  } catch (error) {
    if (error instanceof ApiError) {
      return { ok: false, message: error.message, status: error.status };
    }
    return networkError();
  }

  revalidateInvoice(invoiceId);
  return { ok: true };
}

// removeLineAction — DELETEs a line (204). 409 when the invoice is not a DRAFT.
export async function removeLineAction(
  invoiceId: string,
  lineId: string,
): Promise<ActionError | ActionOk> {
  try {
    await apiFetch<void>(`/api/v1/invoices/${invoiceId}/lines/${lineId}`, { method: "DELETE" });
  } catch (error) {
    if (error instanceof ApiError) {
      return { ok: false, message: error.message, status: error.status };
    }
    return networkError();
  }

  revalidateInvoice(invoiceId);
  return { ok: true };
}

// buildFromJobAction — POSTs /:id/build-from-job: a batch of operator-selected
// trip lines tagged with a job for provenance (NOT a job traversal — the schema
// has no Trip→Job link; see docs/tech-debt.md). Each line's unit price converts
// rupees → paisa. 400 when the job does not belong to the invoice's customer or a
// trip is stale; 409 when the invoice is not a DRAFT.
export async function buildFromJobAction(
  invoiceId: string,
  values: BuildFromJobFormValues,
): Promise<ActionError | ActionOk> {
  const parsed = BuildFromJobFormSchema.safeParse(values);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "form"}: ${issue.message}`)
      .join("; ");
    return { ok: false, message: issues, status: 400 };
  }

  const body = {
    jobId: parsed.data.jobId,
    lines: parsed.data.lines.map((line) => ({
      tripId: line.tripId,
      quantity: Number(line.quantity),
      unitPricePaisa: rupeesStringToPaisa(line.unitPrice),
      ...(line.description && line.description.length > 0 ? { description: line.description } : {}),
    })),
  };

  try {
    await apiFetch<unknown>(`/api/v1/invoices/${invoiceId}/build-from-job`, {
      method: "POST",
      json: body,
    });
  } catch (error) {
    if (error instanceof ApiError) {
      const field = error.status === 400 ? fieldForFkError(error.message) : undefined;
      return { ok: false, message: error.message, status: error.status, field };
    }
    return networkError();
  }

  revalidateInvoice(invoiceId);
  return { ok: true };
}
