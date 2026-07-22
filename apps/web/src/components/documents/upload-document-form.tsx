"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";

import { NepaliDatePicker } from "@/components/nepali-date-picker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DOCUMENT_CATEGORY_LABELS,
  ENTITY_DOCUMENT_CATEGORIES,
  ENTITY_FIELD,
  type DocumentEntityType,
} from "@/lib/documents";

import { uploadDocumentAction } from "./actions";

interface UploadDocumentFormProps {
  entityType: DocumentEntityType;
  entityId: string;
  /** The owning detail page path, e.g. `/vehicles/abc123` — the success
   * redirect target and the revalidated path. */
  entityPath: string;
}

const ACCEPT = "application/pdf,image/jpeg,image/png,image/webp";
const MAX_BYTES = 10 * 1024 * 1024;

// The fleet-document upload form (ADR-0049 F4, DESIGN.md §"Fleet documents &
// renewals"): native file input (PDF + photo formats, ≤ 10 MB — the API
// re-verifies by magic bytes and 400/413s surface inline), a category select
// narrowed to the entity's matrix, title (with the Tier-discipline helper
// copy), optional notes, and an optional BS expiry via NepaliDatePicker
// ("set an expiry to get reminder emails"). Plain controlled inputs — no RHF
// schema ceremony for a four-field form; the API's Zod layer is the
// validator of record and its messages render inline.
export function UploadDocumentForm({
  entityType,
  entityId,
  entityPath,
}: UploadDocumentFormProps): React.ReactElement {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const categories = ENTITY_DOCUMENT_CATEGORIES[entityType];

  const [category, setCategory] = useState<string>(categories[0]);
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleSubmit(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setError(null);

    const file = fileInputRef.current?.files?.[0];
    if (file === undefined) {
      setError("Choose a PDF or photo file to upload.");
      return;
    }
    if (file.size > MAX_BYTES) {
      setError("The file is larger than 10 MB.");
      return;
    }
    if (title.trim().length === 0) {
      setError("Title is required.");
      return;
    }

    const formData = new FormData();
    formData.append("file", file, file.name);
    formData.append(ENTITY_FIELD[entityType], entityId);
    formData.append("category", category);
    formData.append("title", title.trim());
    if (notes.trim().length > 0) formData.append("notes", notes.trim());
    if (expiresAt !== null) formData.append("expiresAt", expiresAt);

    startTransition(async () => {
      const result = await uploadDocumentAction(entityPath, formData);
      if (result.ok) {
        router.push(entityPath);
        return;
      }
      setError(result.message);
    });
  }

  return (
    <form onSubmit={handleSubmit} className="max-w-xl space-y-6">
      <div className="space-y-2">
        <label htmlFor="document-file" className="text-sm font-medium">
          File
        </label>
        <Input id="document-file" ref={fileInputRef} type="file" accept={ACCEPT} />
        <p className="text-text-muted text-xs">PDF, JPEG, PNG, or WEBP — up to 10 MB.</p>
      </div>

      <div className="space-y-2">
        <label htmlFor="document-category" className="text-sm font-medium">
          Category
        </label>
        <select
          id="document-category"
          value={category}
          onChange={(event) => setCategory(event.target.value)}
          className="border-border-subtle bg-surface-canvas h-9 w-full rounded border px-3 text-sm"
        >
          {categories.map((value) => (
            <option key={value} value={value}>
              {DOCUMENT_CATEGORY_LABELS[value]}
            </option>
          ))}
        </select>
      </div>

      <div className="space-y-2">
        <label htmlFor="document-title" className="text-sm font-medium">
          Title
        </label>
        <Input
          id="document-title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="e.g. 2083 insurance policy"
          maxLength={256}
        />
        <p className="text-text-muted text-xs">
          Don’t put license or ID numbers in titles — the file itself carries them.
        </p>
      </div>

      <div className="space-y-2">
        <label htmlFor="document-notes" className="text-sm font-medium">
          Notes <span className="text-text-muted font-normal">(optional)</span>
        </label>
        <Input
          id="document-notes"
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
          maxLength={2048}
        />
      </div>

      <div className="space-y-2">
        <span className="text-sm font-medium">
          Expires <span className="text-text-muted font-normal">(optional)</span>
        </span>
        <NepaliDatePicker value={expiresAt} onChange={(iso) => setExpiresAt(iso)} />
        <p className="text-text-muted text-xs">
          Set an expiry to get reminder emails for this document.
        </p>
      </div>

      {error === null ? null : <p className="text-status-error text-sm">{error}</p>}

      <div className="flex gap-3">
        <Button type="submit" disabled={isPending}>
          {isPending ? "Uploading…" : "Upload document"}
        </Button>
        <Button type="button" variant="outline" onClick={() => router.push(entityPath)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
