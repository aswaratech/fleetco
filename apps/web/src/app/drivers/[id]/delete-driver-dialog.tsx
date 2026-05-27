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

import { deleteDriverAction } from "../actions";

// The API formats the 409 message as
//   "Cannot delete driver: 3 trips reference this driver."
// (or "1 trip" in the singular case). We parse the count out so the
// link can read "View 3 trips" / "View 1 trip"; on no-match we fall
// back to "View trips" — the link is still useful without the count.
// See apps/api/src/modules/drivers/drivers.service.ts. Mirrors the
// helper in apps/web/src/app/vehicles/[id]/delete-vehicle-dialog.tsx.
function parseTripCount(message: string): number | null {
  const match = /(\d+) trips?\b/.exec(message);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) ? n : null;
}

interface DeleteDriverDialogProps {
  id: string;
  fullName: string;
}

// Delete-driver confirmation — small client island wrapping shadcn's
// AlertDialog primitive (apps/web/src/components/ui/alert-dialog.tsx).
// Mirrors apps/web/src/app/vehicles/[id]/delete-vehicle-dialog.tsx in
// structure and behavior. DESIGN.md §"Modals and drawers" commits us
// to AlertDialog for destructive actions with named action/cancel
// labels and no backdrop-dismissal. The action label is "Delete
// driver"; the cancel label is "Keep driver". Never "Are you sure?".
//
// 404 from the API is treated as a soft success-with-warning: the row
// was already gone, so the list is going to be correct after a
// revalidate. We still surface the message inline so the operator sees
// what happened, but the dialog stays closed (no second click required).
export function DeleteDriverDialog({ id, fullName }: DeleteDriverDialogProps): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleConfirm(event: React.MouseEvent<HTMLButtonElement>): void {
    // Prevent the default close-on-action so we can keep the dialog
    // open while the action is in flight and re-open it if the call
    // returns an error. Radix's AlertDialogAction defaults to closing
    // on click.
    event.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await deleteDriverAction(id);
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
          <AlertDialogTitle>Delete {fullName}?</AlertDialogTitle>
          <AlertDialogDescription>This cannot be undone.</AlertDialogDescription>
        </AlertDialogHeader>
        {error ? (
          <div role="alert" className="text-status-error space-y-1 text-sm">
            <p>{error}</p>
            {/* Iter 10 affordance — pivot from "I can't delete" to
                "what's blocking me?" without leaving the dialog. The
                link renders whenever there's an error message; see
                the matching comment in
                apps/web/src/app/vehicles/[id]/delete-vehicle-dialog.tsx. */}
            <p>
              <Link
                href={`/trips?driverId=${encodeURIComponent(id)}`}
                className="underline underline-offset-4"
              >
                {(() => {
                  const n = parseTripCount(error);
                  if (n === null) return "View trips";
                  return `View ${n} trip${n === 1 ? "" : "s"}`;
                })()}
              </Link>
            </p>
          </div>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Keep driver</AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={isPending} onClick={handleConfirm}>
            {isPending ? "Deleting…" : "Delete driver"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
