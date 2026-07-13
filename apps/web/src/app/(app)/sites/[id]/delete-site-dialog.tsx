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

import { deleteSiteAction } from "../actions";

// Delete-site confirmation — small client island wrapping shadcn's AlertDialog
// primitive. DESIGN.md §"Modals and drawers" commits us to AlertDialog for
// destructive actions with named action/cancel labels and no backdrop-dismissal.
// The action label is "Delete site"; the cancel label is "Keep site". Never
// "Are you sure?".
//
// THE DELETE-BLOCKER (ADR-0047 c4, DESIGN.md §Sites): unlike a Geofence, a Site
// is NOT a leaf aggregate — Trip.pickupSiteId / Trip.dropoffSiteId reference it
// under onDelete: Restrict. The API maps that P2003 to HTTP 409 with the plain
// fact "Cannot delete site: N trips reference this site."; the dialog surfaces
// that message inline (the vehicle / driver / customer delete-blocker pattern).
//
// A "View trips using this site" deep-link (DESIGN.md §Sites) is DEFERRED to W6:
// the trips list does not yet accept a `?pickupSiteId=` / `?dropoffSiteId=`
// filter, so a link would land on an unfiltered list — misleading. W6 (the
// dispatch web UI) adds that filter and the link. For now the count in the
// message is the actionable signal.
//
// 404 from the API is treated as a soft success-with-warning: the row was
// already gone, so the list is correct after a revalidate. We surface the
// message inline but the dialog stays open with the note (no second click).

interface DeleteSiteDialogProps {
  id: string;
  name: string;
}

export function DeleteSiteDialog({ id, name }: DeleteSiteDialogProps): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleConfirm(event: React.MouseEvent<HTMLButtonElement>): void {
    // Prevent the default close-on-action so the dialog stays open while the
    // action is in flight and can re-open with an error (notably the 409
    // delete-blocker). Radix's AlertDialogAction defaults to closing on click.
    event.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await deleteSiteAction(id);
      // On success the action throws NEXT_REDIRECT; control never returns here.
      // If we did get a result back, it's an error (409 blocker, 404, network).
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
          <AlertDialogCancel disabled={isPending}>Keep site</AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={isPending} onClick={handleConfirm}>
            {isPending ? "Deleting…" : "Delete site"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
