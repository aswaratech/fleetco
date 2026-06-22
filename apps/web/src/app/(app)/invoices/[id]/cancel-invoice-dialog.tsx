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

import { cancelInvoiceAction } from "../actions";

// Cancel-draft confirmation — a client island wrapping the AlertDialog primitive
// (DESIGN.md §"Modals and drawers": a destructive transition gets named
// action/cancel labels, never "Are you sure?"). Only a DRAFT can be cancelled
// (DRAFT → CANCELLED); an ISSUED invoice's number is permanent and is corrected by
// a credit note, never cancelled in place (ADR-0039 c5) — the API answers 409 for
// a non-DRAFT, surfaced inline. On success the action throws NEXT_REDIRECT to the
// (now CANCELLED) detail page.

interface CancelInvoiceDialogProps {
  id: string;
  /** The invoice number or a short label for the confirmation copy. */
  label: string;
}

export function CancelInvoiceDialog({ id, label }: CancelInvoiceDialogProps): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleConfirm(event: React.MouseEvent<HTMLButtonElement>): void {
    event.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await cancelInvoiceAction(id);
      if (result && result.ok === false) {
        setError(result.message);
      }
    });
  }

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <Button variant="destructive">Cancel draft</Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Cancel {label}?</AlertDialogTitle>
          <AlertDialogDescription>
            The draft is marked cancelled and kept for the record. It cannot be issued afterwards.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error ? (
          <div role="alert" className="text-status-error text-sm">
            <p>{error}</p>
          </div>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Keep draft</AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={isPending} onClick={handleConfirm}>
            {isPending ? "Cancelling…" : "Cancel draft"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
