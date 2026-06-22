"use client";

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

import { deleteJobAction } from "../actions";

// Delete-job confirmation — small client island wrapping shadcn's
// AlertDialog primitive (apps/web/src/components/ui/alert-dialog.tsx).
// DESIGN.md §"Modals and drawers" commits us to AlertDialog for
// destructive actions with named action/cancel labels and no backdrop-
// dismissal. The action label is "Delete job"; the cancel label is
// "Keep job". Never "Are you sure?".
//
// Mirror of apps/web/src/app/customers/[id]/delete-customer-dialog.tsx
// and the equivalent Drivers / Vehicles dialogs.
//
// 404 from the API is treated as a soft success-with-warning: the row
// was already gone, so the list is going to be correct after a
// revalidate. We still surface the message inline so the operator sees
// what happened, but the dialog stays open.
//
// 409: no inbound FKs to Job exist today (no Trip→Job FK in Phase 1);
// when a future iteration adds one this branch will surface the API's
// blocker message verbatim — same path the Customers dialog uses for
// its iter-18 Jobs blocker. The generic banner is sufficient for the
// pre-FK state; no special "View related records" affordance is added
// until there is a relationship surface to deep-link to.

interface DeleteJobDialogProps {
  id: string;
  jobNumber: string;
}

export function DeleteJobDialog({ id, jobNumber }: DeleteJobDialogProps): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleConfirm(event: React.MouseEvent<HTMLButtonElement>): void {
    // Prevent the default close-on-action so we can keep the dialog
    // open while the action is in flight and re-open it if the call
    // returns an error. Radix's AlertDialogAction defaults to closing
    // on click. Same pattern the Customers / Drivers / Vehicles
    // dialogs use.
    event.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await deleteJobAction(id);
      // On success the action throws NEXT_REDIRECT; control never
      // returns here. If we did get a result back, it's an error.
      if (result && result.ok === false) {
        setError(result.message);
      }
    });
  }

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <Button variant="destructive">Delete</Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {jobNumber}?</AlertDialogTitle>
          <AlertDialogDescription>This cannot be undone.</AlertDialogDescription>
        </AlertDialogHeader>
        {error ? (
          <div role="alert" className="text-status-error text-sm">
            <p>{error}</p>
          </div>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Keep job</AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={isPending} onClick={handleConfirm}>
            {isPending ? "Deleting…" : "Delete job"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
