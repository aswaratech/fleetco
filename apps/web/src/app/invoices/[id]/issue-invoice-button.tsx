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

import { issueInvoiceAction } from "../actions";

// Issue-invoice confirmation — a client island wrapping the AlertDialog primitive.
// Issuing is a one-way, IRREVERSIBLE transition (DRAFT → ISSUED): it assigns the
// gapless fiscal-year number, freezes the tax snapshot, and renders + stores the
// PDF; after issue the invoice is immutable and corrected only by a credit note
// (ADR-0039 c4–5). That irreversibility is exactly what warrants a confirmation
// (DESIGN.md §"Modals and drawers"; §Voice "Confirmations are specific").
//
// The API enforces the preconditions and answers 422 with a clear, actionable
// message (supplier PAN not configured / R2 not configured / no service type / no
// lines / discount > subtotal); we surface that verbatim and keep the dialog open
// so the operator can read it and act. On success the action throws NEXT_REDIRECT
// and the framework navigates to the now-ISSUED detail — control never returns.

interface IssueInvoiceButtonProps {
  id: string;
}

export function IssueInvoiceButton({ id }: IssueInvoiceButtonProps): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleConfirm(event: React.MouseEvent<HTMLButtonElement>): void {
    event.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await issueInvoiceAction(id);
      if (result && result.ok === false) {
        setError(result.message);
      }
    });
  }

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <Button>Issue invoice</Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Issue this invoice?</AlertDialogTitle>
          <AlertDialogDescription>
            Issuing assigns the permanent invoice number, freezes the tax breakdown, and locks the
            invoice. After this it can only be corrected by a credit note — it cannot be edited or
            cancelled.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error ? (
          <div role="alert" className="text-status-error text-sm">
            <p>{error}</p>
          </div>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Keep as draft</AlertDialogCancel>
          <AlertDialogAction disabled={isPending} onClick={handleConfirm}>
            {isPending ? "Issuing…" : "Issue invoice"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
