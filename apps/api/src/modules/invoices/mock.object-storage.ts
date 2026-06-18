import {
  ObjectStorage,
  ObjectStorageObjectNotFoundError,
  type PutObjectInput,
} from "./object-storage";

/**
 * An in-memory, no-network {@link ObjectStorage} — the dev/test/CI default of
 * ADR-0039 commitment 7 (the MockMailer counterpart). It never imports the S3 SDK
 * and never opens a socket, so it has two roles:
 *
 *   1. The dev / test / CI default the module wires when no R2 creds are
 *      configured, so the API never reaches R2 outside production (R2 only stores
 *      from a deployed system with operator-supplied creds).
 *   2. A test double: it RECORDS every put in {@link puts} (assert against it) and
 *      serves them back from an in-memory map via {@link get}, and can be
 *      configured to report "not configured" (so the issue flow's R2 precondition
 *      can be exercised) or to throw on put (the store-failure path).
 */
export class MockObjectStorage extends ObjectStorage {
  /** Every object passed to {@link put}, in call order. Assert against this. */
  readonly puts: PutObjectInput[] = [];
  private readonly store = new Map<string, Buffer>();

  /**
   * @param behavior.configured  What {@link isConfigured} reports (default
   *                             `true`). Set `false` to exercise the issue flow's
   *                             "R2 not configured" precondition with no creds.
   * @param behavior.putError    If set, {@link put} records the call and then
   *                             rejects with it — the store-failure path, with no
   *                             object retained (so a later get misses).
   */
  constructor(private readonly behavior: { configured?: boolean; putError?: Error } = {}) {
    super();
  }

  isConfigured(): boolean {
    return this.behavior.configured ?? true;
  }

  put(input: PutObjectInput): Promise<void> {
    this.puts.push(input);
    if (this.behavior.putError !== undefined) {
      return Promise.reject(this.behavior.putError);
    }
    this.store.set(input.key, input.body);
    return Promise.resolve();
  }

  get(key: string): Promise<Buffer> {
    const bytes = this.store.get(key);
    if (bytes === undefined) {
      return Promise.reject(new ObjectStorageObjectNotFoundError(key));
    }
    return Promise.resolve(bytes);
  }
}
