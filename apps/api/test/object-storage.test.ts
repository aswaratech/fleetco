import type { S3Client } from "@aws-sdk/client-s3";
import { describe, expect, test, vi } from "vitest";

import { MockObjectStorage } from "../src/modules/invoices/mock.object-storage";
import {
  ObjectStorageNotConfiguredError,
  ObjectStorageObjectNotFoundError,
} from "../src/modules/invoices/object-storage";
import { R2ObjectStorage } from "../src/modules/invoices/r2.object-storage";

// The ObjectStorage seam tests (Program D / ADR-0039 c7, D5). PURE — no network,
// no real R2. R2ObjectStorage is exercised with a no-network fake `send` (the
// ResendMailer client-injection precedent); the @aws-sdk/client-s3 import stays
// confined to r2.object-storage.ts — this test recognizes commands by their
// constructor name and uses only a type-only S3Client import for the cast.

/** A minimal command shape the fake inspects without importing the SDK. */
interface FakeCommand {
  constructor: { name: string };
  input: { Bucket?: string; Key?: string; Body?: unknown; ContentType?: string };
}

function makeFakeS3(getBytes: Uint8Array | null) {
  const sent: FakeCommand[] = [];
  const send = vi.fn((command: FakeCommand) => {
    sent.push(command);
    if (command.constructor.name === "GetObjectCommand") {
      if (getBytes === null) {
        const err = new Error("not found");
        err.name = "NoSuchKey";
        return Promise.reject(err);
      }
      return Promise.resolve({
        Body: { transformToByteArray: () => Promise.resolve(getBytes) },
      });
    }
    return Promise.resolve({});
  });
  return { sent, client: { send } as unknown as Pick<S3Client, "send"> };
}

describe("R2ObjectStorage (fake S3 send, no network)", () => {
  test("isConfigured() is true when a client + bucket are present", () => {
    const { client } = makeFakeS3(new Uint8Array());
    const storage = new R2ObjectStorage({ client, bucket: "invoices" });
    expect(storage.isConfigured()).toBe(true);
  });

  test("put() sends a PutObjectCommand with the bucket, key, body, and content type", async () => {
    const { sent, client } = makeFakeS3(new Uint8Array());
    const storage = new R2ObjectStorage({ client, bucket: "invoices" });
    const body = Buffer.from("%PDF-1.3 fake");
    await storage.put({ key: "invoices/abc.pdf", body, contentType: "application/pdf" });

    expect(sent).toHaveLength(1);
    expect(sent[0]?.constructor.name).toBe("PutObjectCommand");
    expect(sent[0]?.input).toMatchObject({
      Bucket: "invoices",
      Key: "invoices/abc.pdf",
      ContentType: "application/pdf",
    });
    expect(sent[0]?.input.Body).toBe(body);
  });

  test("get() reads the object body into a Buffer", async () => {
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // "%PDF"
    const { sent, client } = makeFakeS3(bytes);
    const storage = new R2ObjectStorage({ client, bucket: "invoices" });
    const out = await storage.get("invoices/abc.pdf");

    expect(Buffer.isBuffer(out)).toBe(true);
    expect(out.equals(Buffer.from(bytes))).toBe(true);
    expect(sent[0]?.constructor.name).toBe("GetObjectCommand");
    expect(sent[0]?.input).toMatchObject({ Bucket: "invoices", Key: "invoices/abc.pdf" });
  });

  test("get() maps a NoSuchKey error to ObjectStorageObjectNotFoundError", async () => {
    const { client } = makeFakeS3(null);
    const storage = new R2ObjectStorage({ client, bucket: "invoices" });
    await expect(storage.get("invoices/missing.pdf")).rejects.toBeInstanceOf(
      ObjectStorageObjectNotFoundError,
    );
  });

  test("with no creds: isConfigured() is false and put/get throw NotConfigured", async () => {
    // Explicit undefined for each config value forces the no-creds path
    // regardless of ambient env (the ResendMailer "force no-key" pattern).
    const storage = new R2ObjectStorage({
      endpoint: undefined,
      accessKeyId: undefined,
      secretAccessKey: undefined,
      bucket: undefined,
    });
    expect(storage.isConfigured()).toBe(false);
    await expect(
      storage.put({ key: "k", body: Buffer.from("x"), contentType: "application/pdf" }),
    ).rejects.toBeInstanceOf(ObjectStorageNotConfiguredError);
    await expect(storage.get("k")).rejects.toBeInstanceOf(ObjectStorageNotConfiguredError);
  });
});

describe("MockObjectStorage (in-memory dev/test/CI default + test double)", () => {
  test("records puts and serves them back via get", async () => {
    const storage = new MockObjectStorage();
    expect(storage.isConfigured()).toBe(true);
    const body = Buffer.from("%PDF- mock");
    await storage.put({ key: "invoices/x.pdf", body, contentType: "application/pdf" });

    expect(storage.puts).toHaveLength(1);
    expect(storage.puts[0]?.key).toBe("invoices/x.pdf");
    const out = await storage.get("invoices/x.pdf");
    expect(out.equals(body)).toBe(true);
  });

  test("get() on a missing key rejects with ObjectStorageObjectNotFoundError", async () => {
    const storage = new MockObjectStorage();
    await expect(storage.get("nope")).rejects.toBeInstanceOf(ObjectStorageObjectNotFoundError);
  });

  test("configured:false makes isConfigured() report false", () => {
    expect(new MockObjectStorage({ configured: false }).isConfigured()).toBe(false);
  });

  test("putError rejects the put and retains no object (a later get misses)", async () => {
    const storage = new MockObjectStorage({ putError: new Error("store down") });
    await expect(
      storage.put({ key: "k", body: Buffer.from("x"), contentType: "application/pdf" }),
    ).rejects.toThrow("store down");
    // The call was still recorded, but nothing was stored.
    expect(storage.puts).toHaveLength(1);
    await expect(storage.get("k")).rejects.toBeInstanceOf(ObjectStorageObjectNotFoundError);
  });
});
