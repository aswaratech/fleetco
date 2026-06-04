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

import { deleteGeofenceAction } from "../actions";

// Delete-geofence confirmation — small client island wrapping shadcn's
// AlertDialog primitive (apps/web/src/components/ui/alert-dialog.tsx).
// DESIGN.md §"Modals and drawers" commits us to AlertDialog for destructive
// actions with named action/cancel labels and no backdrop-dismissal. The
// action label is "Delete geofence"; the cancel label is "Keep geofence".
// Never "Are you sure?".
//
// Mirror of apps/web/src/app/customers/[id]/delete-customer-dialog.tsx,
// minus the "referenced by other records" affordance: a Geofence is a leaf
// aggregate (nothing FKs into it), so DELETE never returns a 409 delete-
// blocker — only a 404 if the row already vanished, which we surface inline.
//
// 404 from the API is treated as a soft success-with-warning: the row was
// already gone, so the list is correct after a revalidate. We surface the
// message inline so the operator sees what happened, but the dialog stays
// closed (no second click required).

interface DeleteGeofenceDialogProps {
  id: string;
  name: string;
}

export function DeleteGeofenceDialog({ id, name }: DeleteGeofenceDialogProps): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleConfirm(event: React.MouseEvent<HTMLButtonElement>): void {
    // Prevent the default close-on-action so the dialog stays open while the
    // action is in flight and can re-open with an error. Radix's
    // AlertDialogAction defaults to closing on click. Same pattern the other
    // delete dialogs use.
    event.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await deleteGeofenceAction(id);
      // On success the action throws NEXT_REDIRECT; control never returns
      // here. If we did get a result back, it's an error.
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
          <AlertDialogTitle>Delete {name}?</AlertDialogTitle>
          <AlertDialogDescription>This cannot be undone.</AlertDialogDescription>
        </AlertDialogHeader>
        {error ? (
          <div role="alert" className="text-status-error space-y-1 text-sm">
            <p>{error}</p>
          </div>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Keep geofence</AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={isPending} onClick={handleConfirm}>
            {isPending ? "Deleting…" : "Delete geofence"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
