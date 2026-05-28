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

import { deleteFuelLogAction } from "../actions";

// Delete-fuel-log confirmation — small client island wrapping shadcn's
// AlertDialog primitive. DESIGN.md §"Modals and drawers" commits us to
// AlertDialog for destructive actions with named action/cancel labels
// and no backdrop-dismissal. The action label is "Delete fuel log";
// the cancel label is "Keep fuel log". Never "Are you sure?".
//
// Mirror of apps/web/src/app/jobs/[id]/delete-job-dialog.tsx and the
// equivalent Customers / Drivers / Vehicles dialogs.
//
// 404 is treated as a soft success-with-warning: the row was already
// gone, so the list is going to be correct after a revalidate. We
// surface the message inline so the operator sees what happened, but
// the dialog stays open until they dismiss it.
//
// 409: no inbound FKs to FuelLog exist today (FuelLog is a leaf
// aggregate); the branch is kept for symmetry but is effectively
// unreachable. The generic banner handles it identically.

interface DeleteFuelLogDialogProps {
  id: string;
  dateLabel: string;
}

export function DeleteFuelLogDialog({
  id,
  dateLabel,
}: DeleteFuelLogDialogProps): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleConfirm(event: React.MouseEvent<HTMLButtonElement>): void {
    // Prevent the default close-on-action so we can keep the dialog
    // open while the action is in flight and re-open it if the call
    // returns an error. Radix's AlertDialogAction defaults to closing
    // on click. Same pattern the Jobs / Customers / Drivers /
    // Vehicles dialogs use.
    event.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await deleteFuelLogAction(id);
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
          <AlertDialogTitle>Delete fuel log from {dateLabel}?</AlertDialogTitle>
          <AlertDialogDescription>This cannot be undone.</AlertDialogDescription>
        </AlertDialogHeader>
        {error ? (
          <div role="alert" className="text-status-error text-sm">
            <p>{error}</p>
          </div>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Keep fuel log</AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={isPending} onClick={handleConfirm}>
            {isPending ? "Deleting…" : "Delete fuel log"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
