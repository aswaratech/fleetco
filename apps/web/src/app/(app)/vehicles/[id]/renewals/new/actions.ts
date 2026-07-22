"use server";

import { revalidatePath } from "next/cache";

import { apiFetch, ApiError } from "@/lib/api";
import type { RenewalKind } from "@/lib/renewals";

// Server action for the renew flow (ADR-0049 F5): POSTs the atomic renew to
// the F3 endpoint and revalidates the vehicle page (the compliance badge and
// the renewal history both change in the same commit server-side, so one
// revalidate shows both). Errors reshape into the house structured result.

export interface RenewalActionError {
  ok: false;
  message: string;
  status: number;
}

export interface RecordRenewalInput {
  kind: RenewalKind;
  newExpiresAt: string;
  renewedAt?: string;
  bluebookNumber?: string;
  insurer?: string;
  insurancePolicyNumber?: string;
  insuranceType?: string;
  routePermitNumber?: string;
  documentId?: string;
  expenseLogId?: string;
  notes?: string;
}

export type RecordRenewalResult = { ok: true } | RenewalActionError;

export async function recordRenewalAction(
  vehicleId: string,
  input: RecordRenewalInput,
): Promise<RecordRenewalResult> {
  try {
    await apiFetch(`/api/v1/vehicles/${encodeURIComponent(vehicleId)}/renewals`, {
      method: "POST",
      json: input,
    });
    revalidatePath(`/vehicles/${vehicleId}`);
    return { ok: true };
  } catch (error) {
    if (error instanceof ApiError) {
      return { ok: false, message: error.message, status: error.status };
    }
    return { ok: false, message: "Something went wrong. Try again.", status: 500 };
  }
}
