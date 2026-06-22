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
import { formatNepaliDate } from "@/lib/nepali-date";

import { deleteServiceRecordAction } from "../actions";

// Delete-service-record confirmation — a small client island wrapping shadcn's
// AlertDialog. DESIGN.md §"Modals and drawers": named action/cancel labels, no
// backdrop-dismissal, never "Are you sure?". Mirror of the geofences delete
// dialog: a ServiceRecord is a leaf (nothing FKs INTO it), so DELETE never
// returns a 409 — only a 404 if the row already vanished, surfaced inline.
//
// formatNepaliDate (a pure function) renders the performed date BS for the
// confirmation copy without pulling the <NepaliDate> server component into this
// client island.

interface DeleteServiceRecordDialogProps {
  id: string;
  performedAt: string;
}

export function DeleteServiceRecordDialog({
  id,
  performedAt,
}: DeleteServiceRecordDialogProps): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const label = formatNepaliDate(performedAt, { format: "bs" });

  function handleConfirm(event: React.MouseEvent<HTMLButtonElement>): void {
    event.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await deleteServiceRecordAction(id);
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
          <AlertDialogTitle>Delete this service record?</AlertDialogTitle>
          <AlertDialogDescription>
            The service performed on {label} will be removed. This cannot be undone, and it does not
            roll back the schedule&apos;s last-service anchor.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error ? (
          <div role="alert" className="text-status-error space-y-1 text-sm">
            <p>{error}</p>
          </div>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Keep record</AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={isPending} onClick={handleConfirm}>
            {isPending ? "Deleting…" : "Delete record"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
