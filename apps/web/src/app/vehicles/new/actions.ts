"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { apiFetch, ApiError } from "@/lib/api";
import { CreateVehicleFormSchema, type CreateVehicleFormValues } from "@/lib/vehicles-schema";

export interface CreateVehicleActionResult {
  ok: true;
}

export interface CreateVehicleActionError {
  ok: false;
  message: string;
  // The status code helps the client distinguish validation errors
  // (400) from conflicts (409) from auth failures (401), even though
  // the user-facing message is the same string in iter 2.
  status: number;
}

// Server action invoked by the create-vehicle form. The form is a
// client component (for RHF integration); the action is server-only so
// it can call apiFetch (which reads cookies via next/headers). On
// success the function calls Next.js's redirect, which throws a
// special NEXT_REDIRECT error; the client form treats a thrown
// NEXT_REDIRECT as the success path. On failure, returns a structured
// error so the client renders the message inline.
//
// Why a server action rather than a Route Handler at /api/vehicles:
// (a) co-locates with the form, no second URL surface to maintain;
// (b) the redirect on success flows through Next.js's built-in
// router rather than a manual window.location; (c) cookies forward
// automatically — we never write CORS or fetch options.
export async function createVehicleAction(
  values: CreateVehicleFormValues,
): Promise<CreateVehicleActionError | never> {
  // Re-validate server-side: the client-side resolver runs in the
  // browser and a determined attacker could submit malformed data
  // directly. The API enforces validation too (CreateVehicleSchema),
  // but parsing here lets us surface field-level errors before the
  // round-trip when the action is misused.
  const parsed = CreateVehicleFormSchema.safeParse(values);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "form"}: ${issue.message}`)
      .join("; ");
    return { ok: false, message: issues, status: 400 };
  }

  // Compliance metadata (iter 14): include only the fields the operator
  // actually filled in. Empty strings are omitted so the API's schema
  // sees `undefined` (the "not set" branch) rather than "" (which its
  // ComplianceString min(1) would reject) — the same omit-empties
  // convention the Drivers / Trips create actions use.
  const compliance: Record<string, string> = {};
  const complianceFields = [
    "bluebookNumber",
    "bluebookExpiresAt",
    "insurer",
    "insurancePolicyNumber",
    "insuranceType",
    "insuranceExpiresAt",
    "routePermitNumber",
    "routePermitExpiresAt",
  ] as const;
  for (const key of complianceFields) {
    const value = parsed.data[key];
    if (typeof value === "string" && value.length > 0) {
      compliance[key] = value;
    }
  }

  try {
    await apiFetch<unknown>("/api/v1/vehicles", {
      method: "POST",
      json: {
        registrationNumber: parsed.data.registrationNumber,
        kind: parsed.data.kind,
        make: parsed.data.make,
        model: parsed.data.model,
        year: parsed.data.year,
        status: parsed.data.status,
        odometerStartKm: parsed.data.odometerStartKm,
        // odometerCurrentKm is deliberately omitted: the API service
        // defaults it to odometerStartKm when absent, which matches
        // the kickoff rule and keeps the form one field shorter for
        // the common case of a vehicle joining the fleet at a known
        // odometer reading.
        acquiredAt: parsed.data.acquiredAt,
        ...compliance,
      },
    });
  } catch (error) {
    if (error instanceof ApiError) {
      return { ok: false, message: error.message, status: error.status };
    }
    // Network or unexpected error. Surface a generic message; the
    // underlying error is logged by Next.js automatically.
    return {
      ok: false,
      message: "Could not reach the FleetCo API. Try again.",
      status: 0,
    };
  }

  // Invalidate the list page so the new vehicle appears on next render.
  revalidatePath("/vehicles");
  // redirect() throws NEXT_REDIRECT; the form treats this as success.
  redirect("/vehicles");
}
