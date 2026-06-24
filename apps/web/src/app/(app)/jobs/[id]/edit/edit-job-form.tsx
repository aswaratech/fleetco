"use client";

import { useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { NepaliDatePicker } from "@/components/nepali-date-picker";
import { UpdateJobFormSchema, type UpdateJobFormValues } from "@/lib/jobs-schema";

import { updateJobAction } from "../../actions";
import { JOB_STATUS_OPTIONS, type JobDetail } from "../../types";

interface EditJobFormProps {
  job: JobDetail;
}

// Edit-job form (iter 18). Pre-fills every editable field from the
// server-fetched job. On submit it computes a diff against the initial
// values and only PATCHes the keys the user actually changed — see
// DESIGN.md §"Inputs and forms" "Diff-against-initial-values for PATCH"
// for the project-wide pattern. The diff-aware design also ensures
// cross-field validation re-runs server-side against the *merged* shape
// (the API re-fetches the stored values for any unsent date in a pair),
// so the form can let the operator change one half of a date pair
// without re-sending the unchanged half.
//
// `customerId` and `jobNumber` are intentionally excluded from the
// editable shape (the API's PATCH .strict() rejects them). They are
// rendered as read-only display rows so the operator can see what they
// are without being able to change them — the operator's mental model
// is that a job's customer is fixed, in line with the "jobs cannot be
// reassigned" rule the kickoff captures.
//
// `UpdateJobFormSchema` (the partial shape, every field optional) is
// used here. Unlike Customers / Drivers — which use the full required
// CustomerFormSchema for the edit form and rely on the partial only at
// the wire layer — Jobs uses the partial directly because the form's
// own date and notes inputs are genuinely optional (an empty `<input
// type="date">` is the "no date on file" state and must validate). The
// description + status fields stay required in practice via their
// `min(1)` / enum constraints on the schema; the resolver still rejects
// an empty description with a clear message.
export function EditJobForm({ job }: EditJobFormProps): React.ReactElement {
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Convert the ISO-string dates we got from the API into the YYYY-MM-DD
  // shape an `<input type="date">` accepts. Null becomes "" (the empty-
  // input state). Mirror of the Customers edit form's nullable-text
  // coercion at the same layer.
  const initialValues: UpdateJobFormValues = useMemo(
    () => ({
      description: job.description,
      status: job.status,
      scheduledStartDate: isoToDateString(job.scheduledStartDate),
      scheduledEndDate: isoToDateString(job.scheduledEndDate),
      actualStartDate: isoToDateString(job.actualStartDate),
      actualEndDate: isoToDateString(job.actualEndDate),
      notes: job.notes ?? "",
    }),
    [job],
  );

  const form = useForm<UpdateJobFormValues>({
    resolver: zodResolver(UpdateJobFormSchema),
    defaultValues: initialValues,
  });

  async function onSubmit(values: UpdateJobFormValues): Promise<void> {
    setSubmitError(null);
    form.clearErrors();

    // Compute the diff against the initial values. Only keys whose
    // value strictly differs from the initial value are included in
    // the PATCH payload. String comparison works for the dates
    // (YYYY-MM-DD is collation-safe) and for the enum.
    const changed: Partial<UpdateJobFormValues> = {};
    (Object.keys(values) as (keyof UpdateJobFormValues)[]).forEach((key) => {
      if (values[key] !== initialValues[key]) {
        assignChanged(changed, key, values[key]);
      }
    });

    const result = await updateJobAction(job.id, changed);
    if (result && result.ok === false) {
      setSubmitError(result.message);
    }
    // On success, updateJobAction throws NEXT_REDIRECT and the
    // framework navigates us to /jobs/<id> — control does not return
    // here.
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
        {/* Read-only identity rows — same visual treatment as the
            editable rows so the operator's eye sees the form as a
            single shape, but rendered with disabled inputs so they
            cannot be edited. The values still go nowhere on the wire
            (they're not part of UpdateJobFormValues). */}
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <span className="text-sm font-medium leading-none">Job number</span>
            <Input value={job.jobNumber} disabled readOnly className="font-mono" />
          </div>
          <div className="space-y-2">
            <span className="text-sm font-medium leading-none">Customer</span>
            <Input value={job.customer.name} disabled readOnly />
          </div>
        </div>

        <FormField
          control={form.control}
          name="description"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Description</FormLabel>
              <FormControl>
                <textarea
                  rows={3}
                  className="border-input focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 w-full rounded-md border bg-transparent px-3 py-2 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:ring-[3px]"
                  {...field}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="status"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Status</FormLabel>
              <FormControl>
                <select
                  className="border-input focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 h-9 w-full rounded-md border bg-transparent px-3 py-1 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:ring-[3px]"
                  {...field}
                >
                  {JOB_STATUS_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            control={form.control}
            name="scheduledStartDate"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Scheduled start (optional)</FormLabel>
                <FormControl>
                  <NepaliDatePicker
                    value={field.value || null}
                    onChange={(iso) => field.onChange(iso ?? "")}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="scheduledEndDate"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Scheduled end (optional)</FormLabel>
                <FormControl>
                  <NepaliDatePicker
                    value={field.value || null}
                    onChange={(iso) => field.onChange(iso ?? "")}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            control={form.control}
            name="actualStartDate"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Actual start (optional)</FormLabel>
                <FormControl>
                  <NepaliDatePicker
                    value={field.value || null}
                    onChange={(iso) => field.onChange(iso ?? "")}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="actualEndDate"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Actual end (optional)</FormLabel>
                <FormControl>
                  <NepaliDatePicker
                    value={field.value || null}
                    onChange={(iso) => field.onChange(iso ?? "")}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <FormField
          control={form.control}
          name="notes"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Notes (optional)</FormLabel>
              <FormControl>
                <textarea
                  rows={3}
                  className="border-input focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 w-full rounded-md border bg-transparent px-3 py-2 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:ring-[3px]"
                  {...field}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        {submitError ? (
          <p role="alert" className="text-status-error text-sm">
            {submitError}
          </p>
        ) : null}

        <div className="flex items-center justify-end gap-2 pt-2">
          <Button asChild variant="ghost" type="button">
            <Link href={`/jobs/${job.id}`}>Cancel</Link>
          </Button>
          <Button type="submit" disabled={form.formState.isSubmitting}>
            {form.formState.isSubmitting ? "Saving…" : "Save changes"}
          </Button>
        </div>
      </form>
    </Form>
  );
}

// Convert an ISO-8601 timestamp from the API into a YYYY-MM-DD string
// suitable for <input type="date">. Returns "" for null / invalid input
// so the input renders as empty (the "no date on file" state). UTC is
// the project-wide convention (CLAUDE.md §"Dates"), so we render the
// UTC calendar date — the same date the detail-page formatter uses.
function isoToDateString(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// Type-narrow helper for the diff assignment. UpdateJobFormValues is a
// struct of (mostly) string fields; indexed assignment otherwise widens
// to never. Keeping the helper local avoids polluting the schema module
// and keeps the form's intent legible. Mirror of the matching helper in
// the Customers / Drivers edit forms.
function assignChanged<K extends keyof UpdateJobFormValues>(
  target: Partial<UpdateJobFormValues>,
  key: K,
  value: UpdateJobFormValues[K],
): void {
  target[key] = value;
}
