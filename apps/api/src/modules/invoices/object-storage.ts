// The FleetCo-owned object-storage seam — the FIRST in-app use of Cloudflare R2
// (Program D / ADR-0039 commitment 7; ADR-0014 c6 deferred in-app R2 uploads to
// Phase 2, ADR-0013 commits R2 AES-256 at rest). This is the ONE place the rest
// of the API talks to "store / fetch an object by key": the issue flow persists
// the frozen invoice PDF here, the download path streams it back. Everything
// upstream depends only on this `ObjectStorage` contract — never on the R2 / S3
// SDK — so the vendor lives in exactly one implementation file
// (`r2.object-storage.ts`), the wrap-the-vendor discipline of `mailer.ts`,
// `common/wkt.ts`, and `@fleetco/shared` `nepali-date.ts`.
//
// GENERIC ON PURPOSE: this is a key→bytes store, not invoice-specific. It lands
// in the invoices module as its first user, but is written so ADR-0039's "Revisit
// when" (promote the first-use R2 wiring into a shared storage module as more R2
// features land — Bluebook scans, receipt images) is a MOVE, not a rewrite.
//
// WHY AN ABSTRACT CLASS, NOT A BARE `interface` (the Mailer rationale): NestJS
// resolves providers by a runtime token and a TS `interface` has no runtime
// existence. An abstract class is BOTH the compile-time contract AND the DI
// token, so the module wires `{ provide: ObjectStorage, useFactory: … }`
// (R2ObjectStorage in production where the operator supplies the creds, the
// no-network MockObjectStorage everywhere they are absent) and the service
// injects `constructor(private readonly storage: ObjectStorage)`.

/** One object to store: an opaque key, the bytes, and the MIME type R2 records as
 * the object's Content-Type (so a later presigned/streamed read serves it
 * correctly). For invoices the body is a PDF buffer and the type is
 * `application/pdf`. */
export interface PutObjectInput {
  key: string;
  body: Buffer;
  contentType: string;
}

/**
 * The object-storage port. Three methods. The invoice issue + download paths
 * depend on this — not on R2 / the S3 SDK. See the file header for why this is an
 * abstract class (a runtime DI token), not a bare `interface`.
 */
export abstract class ObjectStorage {
  /**
   * Whether a real backing store is configured (R2 creds + bucket present). The
   * issue flow checks this BEFORE rendering/numbering so an unconfigured store
   * surfaces a clear precondition (a 422, like the supplier-PAN gate) rather than
   * burning work — the same fail-fast posture as the supplier PAN. The
   * MockObjectStorage reports `true` (it is always usable in dev/test/CI).
   */
  abstract isConfigured(): boolean;

  /**
   * Store an object by key (overwriting any object already at that key). REJECTS
   * (never silently no-ops) on failure, so the issue transaction rolls back
   * rather than committing an ISSUED row that points at a missing object
   * (ADR-0039 c7). Throws {@link ObjectStorageNotConfiguredError} when no store is
   * configured.
   */
  abstract put(input: PutObjectInput): Promise<void>;

  /**
   * Fetch an object's bytes by key. Used by the download path to stream a stored,
   * frozen ISSUED invoice PDF back to the operator — NEVER re-rendered (the
   * anti-tamper freeze, ADR-0039 c7). Throws
   * {@link ObjectStorageObjectNotFoundError} when the key is absent and
   * {@link ObjectStorageNotConfiguredError} when no store is configured.
   */
  abstract get(key: string): Promise<Buffer>;
}

/**
 * Thrown when a store operation is attempted but no backing store is configured
 * (R2 creds / bucket unset). The dev/test/CI guard, mirroring
 * `MailerNotConfiguredError`: construction is tolerated so the app boots without
 * creds, but an actual put/get surfaces a clear, loud error rather than silently
 * reaching a half-configured network client. In production the creds are always
 * present, so this never fires there. The issue flow's pre-check (via
 * {@link ObjectStorage.isConfigured}) means this is defense-in-depth.
 */
export class ObjectStorageNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ObjectStorageNotConfiguredError";
  }
}

/**
 * Thrown by {@link ObjectStorage.get} when the requested key has no object. For
 * an ISSUED invoice this should never happen (issue stores the PDF atomically
 * with the number); if it does, it signals an internal storage inconsistency the
 * caller surfaces loudly rather than serving an empty body.
 */
export class ObjectStorageObjectNotFoundError extends Error {
  constructor(readonly key: string) {
    super(`Object not found at key: ${key}`);
    this.name = "ObjectStorageObjectNotFoundError";
  }
}
