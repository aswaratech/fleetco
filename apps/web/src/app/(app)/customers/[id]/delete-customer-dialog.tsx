"use client";

import Link from "next/link";
import { useState, useTransition } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";

import { deleteCustomerAction } from "../actions";

// The API surfaces a delete-block conflict as
//   "Cannot delete customer: it is referenced by other records."
// Iter 17 added Jobs.customerId (FK with onDelete: Restrict per
// ADR-0003), so this message now fires when an operator tries to
// delete a customer that has at least one job on file. Iter 18 wires
// the affordance to a live /jobs?customerId=<id> deep-link so the
// operator can pivot to the blocking jobs and decide what to do
// (cancel them, reassign — once a future iter introduces a
// reassignment surface — or delete them outright). A future iter
// will likely extend the API message with the job count, the same
// way the Drivers / Vehicles equivalents parse trip counts; the
// generic-phrase match below survives the extension because the
// "referenced by other records" tail does not change.
//
// Mirror of apps/web/src/app/drivers/[id]/delete-driver-dialog.tsx
// and apps/web/src/app/vehicles/[id]/delete-vehicle-dialog.tsx.

interface DeleteCustomerDialogProps {
  id: string;
  name: string;
}

// Delete-customer confirmation — small client island wrapping shadcn's
// AlertDialog primitive (apps/web/src/components/ui/alert-dialog.tsx).
// DESIGN.md §"Modals and drawers" commits us to AlertDialog for
// destructive actions with named action/cancel labels and no
// backdrop-dismissal. The action label is "Delete customer"; the
// cancel label is "Keep customer". Never "Are you sure?".
//
// 404 from the API is treated as a soft success-with-warning: the row
// was already gone, so the list is going to be correct after a
// revalidate. We still surface the message inline so the operator sees
// what happened, but the dialog stays closed (no second click required).
export function DeleteCustomerDialog({ id, name }: DeleteCustomerDialogProps): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleConfirm(event: React.MouseEvent<HTMLButtonElement>): void {
    // Prevent the default close-on-action so we can keep the dialog
    // open while the action is in flight and re-open it if the call
    // returns an error. Radix's AlertDialogAction defaults to closing
    // on click. Same pattern the Drivers / Vehicles dialogs use.
    event.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await deleteCustomerAction(id);
      // On success the action throws NEXT_REDIRECT; control never
      // returns here. If we did get a result back, it's an error.
      if (result && result.ok === false) {
        setError(result.message);
      }
    });
  }

  // Detect the delete-block phrasing so the dialog renders a "View
  // jobs for this customer" affordance alongside the message. The
  // phrasing is "Cannot delete customer: it is referenced by other
  // records." today; the tail substring survives any future per-FK
  // extension of the message (e.g. "referenced by N jobs and other
  // records"). Iter 17 added Jobs.customerId (the first inbound FK);
  // iter 18 wires this link to /jobs?customerId=<id> so the operator
  // can pivot to the blocking jobs.
  const isReferencedConflict =
    error !== null && error.toLowerCase().includes("referenced by other records");

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <Button variant="destructive">Delete</Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {name}?</AlertDialogTitle>
          <AlertDialogDescription>This cannot be undone.</AlertDialogDescription>
        </AlertDialogHeader>
        {error ? (
          <div role="alert" className="text-status-error space-y-1 text-sm">
            <p>{error}</p>
            {/* Iter 18 wires the affordance to a live /jobs deep-link
                with the customerId filter — the same pattern the
                Drivers / Vehicles dialogs use for /trips. The /jobs
                page consumes `customerId` from the URL and renders
                only that customer's jobs. A future iter may extend
                the API message to include a job count; the tail-
                substring match above keeps the link working through
                any such change. */}
            {isReferencedConflict ? (
              <p>
                <Link
                  href={`/jobs?customerId=${encodeURIComponent(id)}`}
                  className="underline underline-offset-4"
                >
                  View jobs for this customer
                </Link>
              </p>
            ) : null}
          </div>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Keep customer</AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={isPending} onClick={handleConfirm}>
            {isPending ? "Deleting…" : "Delete customer"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
