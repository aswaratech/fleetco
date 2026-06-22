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

import { deleteTripAction } from "../actions";

interface DeleteTripDialogProps {
  id: string;
  // Short summary used in the dialog title. The detail page passes
  // `<vehicle reg> · <driver name>` so the dialog speaks to a concrete
  // record rather than a generic "this trip".
  summary: string;
}

// Delete-trip confirmation — mirrors apps/web/src/app/drivers/[id]/
// delete-driver-dialog.tsx in structure. DESIGN.md §"Modals and
// drawers" commits us to AlertDialog for destructive actions with
// named action / cancel labels and no backdrop-dismissal. Action
// label is "Delete trip"; cancel label is "Keep trip".
//
// Phase 1 policy: hard delete. The iter-9 service-side comments on
// `TripsService.delete` carry the same plan (no referencing slice
// yet; revisit when fuel logs / GPS pings land in Phase 2).
export function DeleteTripDialog({ id, summary }: DeleteTripDialogProps): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleConfirm(event: React.MouseEvent<HTMLButtonElement>): void {
    // Prevent the default close-on-action so we can keep the dialog
    // open while the action is in flight and re-open it if the call
    // returns an error.
    event.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await deleteTripAction(id);
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
          <AlertDialogTitle>Delete trip · {summary}?</AlertDialogTitle>
          <AlertDialogDescription>
            This permanently removes the trip record. This cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error ? (
          <p role="alert" className="text-status-error text-sm">
            {error}
          </p>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Keep trip</AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={isPending} onClick={handleConfirm}>
            {isPending ? "Deleting…" : "Delete trip"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
