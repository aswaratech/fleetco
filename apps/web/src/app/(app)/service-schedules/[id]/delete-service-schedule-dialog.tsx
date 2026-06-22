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

import { deleteServiceScheduleAction } from "../actions";

// Delete-service-schedule confirmation — a small client island wrapping shadcn's
// AlertDialog primitive. DESIGN.md §"Modals and drawers" commits us to
// AlertDialog for destructive actions with named action/cancel labels and no
// backdrop-dismissal. The action label is "Delete schedule"; the cancel label is
// "Keep schedule". Never "Are you sure?".
//
// Mirror of apps/web/src/app/geofences/[id]/delete-geofence-dialog.tsx, but the
// schedule is NOT a leaf aggregate: a ServiceRecord references it (onDelete:
// Restrict), so DELETE can return a 409 "Cannot delete service schedule: it is
// referenced by other records." We surface either a 409 (still-referenced) or a
// 404 (already gone) inline; on success the action throws NEXT_REDIRECT and the
// framework navigates to /service-schedules.

interface DeleteServiceScheduleDialogProps {
  id: string;
  name: string;
}

export function DeleteServiceScheduleDialog({
  id,
  name,
}: DeleteServiceScheduleDialogProps): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleConfirm(event: React.MouseEvent<HTMLButtonElement>): void {
    // Prevent the default close-on-action so the dialog stays open while the
    // action is in flight and can re-open with an error. Same pattern the other
    // delete dialogs use.
    event.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await deleteServiceScheduleAction(id);
      // On success the action throws NEXT_REDIRECT; control never returns here.
      // A returned result is an error (409 delete-block or 404 already-gone).
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
          <AlertDialogDescription>
            This cannot be undone. A schedule with recorded service history cannot be deleted.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error ? (
          <div role="alert" className="text-status-error space-y-1 text-sm">
            <p>{error}</p>
          </div>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Keep schedule</AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={isPending} onClick={handleConfirm}>
            {isPending ? "Deleting…" : "Delete schedule"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
