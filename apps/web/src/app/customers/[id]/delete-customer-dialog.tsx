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

// The iter-16 API surfaces a delete-block conflict as
//   "Cannot delete customer: it is referenced by other records."
// Customer has no inbound FKs in iter 16, so this message is dead
// code today — the iter-17 Jobs slice will be the first reference
// that exercises it (Jobs.customerId FK with onDelete: Restrict per
// ADR-0003). When that lands, the API message will likely be
// extended with a job count and this helper will pick it up the same
// way the Drivers / Vehicles versions parse trip counts. For now we
// surface the message verbatim with a placeholder "View jobs" link
// disabled (the /jobs surface does not exist yet).
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

  // Detect the iter-16 delete-block phrasing so the dialog renders a
  // "View related records" affordance alongside the message. The
  // current phrasing is generic ("it is referenced by other records")
  // because the API ships forward-compatible 409 mapping ahead of the
  // first inbound FK (Jobs, iter 17). When that lands the link will
  // become a /jobs deep-link with a customer filter.
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
            {/* Jobs slice (iter 17) will replace this placeholder with
                a real /jobs?customerId=... deep-link the same way the
                Drivers / Vehicles dialogs link to /trips. For now we
                surface a /customers anchor — the message itself names
                what's blocking, and a future iteration will tighten
                the affordance once the relationship surface exists.
                Keeping the markup here (rather than under a feature
                flag) means iter 17 only needs to update one href and
                the label string. */}
            {isReferencedConflict ? (
              <p>
                <Link
                  href={`/customers/${encodeURIComponent(id)}`}
                  className="underline underline-offset-4"
                >
                  View related records
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
