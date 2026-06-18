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

import { createCreditNoteAction } from "../actions";

// Create-credit-note confirmation — a client island. A credit note is the ONLY
// correction path for an ISSUED invoice (ADR-0039 c5): it is a separate document
// with its own gapless series that copies the original's lines. This island posts
// /:id/credit-notes and (on success) the action redirects to the new credit note's
// edit surface so the operator can adjust + issue it. The 409 (original not an
// ISSUED INVOICE) is surfaced inline. The numbers' sign convention + full-vs-partial
// reversal are accountant-verified details the operator refines on the draft
// (ADR-0039 c9).

interface CreateCreditNoteButtonProps {
  id: string;
  /** The original invoice's number for the confirmation copy. */
  label: string;
}

export function CreateCreditNoteButton({
  id,
  label,
}: CreateCreditNoteButtonProps): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleConfirm(event: React.MouseEvent<HTMLButtonElement>): void {
    event.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await createCreditNoteAction(id);
      if (result && result.ok === false) {
        setError(result.message);
      }
    });
  }

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <Button variant="outline">Create credit note</Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Create a credit note for {label}?</AlertDialogTitle>
          <AlertDialogDescription>
            A new credit-note draft is created with this invoice’s lines copied in. You can adjust
            it and issue it as the correction. The original issued invoice is never edited or
            deleted.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error ? (
          <div role="alert" className="text-status-error text-sm">
            <p>{error}</p>
          </div>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Back</AlertDialogCancel>
          <AlertDialogAction disabled={isPending} onClick={handleConfirm}>
            {isPending ? "Creating…" : "Create credit note"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
