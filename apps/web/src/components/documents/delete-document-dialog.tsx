"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

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

import { deleteDocumentAction } from "./actions";

interface DeleteDocumentDialogProps {
  documentId: string;
  title: string;
  entityPath: string;
}

// Delete-document confirmation (ADR-0049 F4) — the house AlertDialog island
// with named action/cancel labels. Rendered ONLY for ADMIN (the section
// checks the /me role); the API's documents:delete gate is the real wall.
// A 409 (the document is a renewal record's linked proof) surfaces inline
// as the API's plain-fact message — the paper cannot be deleted while a
// renewal references it.
export function DeleteDocumentDialog({
  documentId,
  title,
  entityPath,
}: DeleteDocumentDialogProps): React.ReactElement {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleConfirm(event: React.MouseEvent<HTMLButtonElement>): void {
    event.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await deleteDocumentAction(documentId, entityPath);
      if (result.ok) {
        setOpen(false);
        router.refresh();
        return;
      }
      setError(result.message);
    });
  }

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <Button variant="ghost" size="sm" className="text-status-error hover:text-status-error">
          Delete
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete document</AlertDialogTitle>
          <AlertDialogDescription>
            This permanently removes “{title}” and its stored file. A document referenced by a
            renewal record cannot be deleted.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error === null ? null : <p className="text-status-error text-sm">{error}</p>}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Keep document</AlertDialogCancel>
          <AlertDialogAction onClick={handleConfirm} disabled={isPending}>
            {isPending ? "Deleting…" : "Delete document"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
