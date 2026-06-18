import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

import { env } from "../../config/env";
import {
  ObjectStorage,
  ObjectStorageNotConfiguredError,
  ObjectStorageObjectNotFoundError,
  type PutObjectInput,
} from "./object-storage";

// The Cloudflare R2 implementation of the FleetCo {@link ObjectStorage} seam
// (Program D / ADR-0039 commitment 7 — the FIRST in-app R2 use). This is the ONLY
// file in the API that imports `@aws-sdk/client-s3` (or names R2 / S3):
// everything upstream depends on the vendor-free `ObjectStorage` contract, so
// swapping to a lighter S3 client (e.g. `aws4fetch`) or promoting this into a
// shared storage module later means rewriting this one file (the seam guarantee,
// c7). R2 is S3-compatible, so the AWS S3 v3 client drives it with a custom
// endpoint + region "auto". Not @Injectable(): the module factory constructs it
// (the ResendMailer precedent).
//
// ⚠️ R2 CREDENTIALS ARE OPERATOR-SUPPLIED (ADR-0039 c7) — endpoint, access key,
// secret, and bucket are env config, empty until the operator fills them (exactly
// like RESEND_API_KEY and INVOICE_SUPPLIER_PAN). The access key + secret are Tier
// 1 per ADR-0013: they live ONLY in the production secret store, are NEVER
// committed, and are NEVER logged. NEVER hardcode a credential. When unset, the
// app boots and the module wires the no-network MockObjectStorage instead, so the
// API never reaches R2 outside production.

/** The S3 region R2 expects (it is region-agnostic; "auto" is the documented
 * value). */
const R2_REGION = "auto";

export class R2ObjectStorage extends ObjectStorage {
  // Typed as the minimal slice of S3Client we use (`send`), so a test can inject a
  // no-network fake — the real S3Client satisfies it structurally. `null` when no
  // creds are configured (the app boots; put/get then throw NotConfigured).
  private readonly client: Pick<S3Client, "send"> | null;
  private readonly bucket: string | null;

  /**
   * @param opts.endpoint/accessKeyId/secretAccessKey/bucket  Override the typed
   *        env (tests pass explicit values, or omit to read env). An explicitly
   *        passed key (even `undefined`) wins, so a test can force the
   *        no-creds path deterministically.
   * @param opts.client  Injects an S3-shaped client (a fake) so put/get mapping is
   *        exercised with no network. When omitted, a real `S3Client` is built iff
   *        all four config values are present.
   */
  constructor(opts?: {
    endpoint?: string;
    accessKeyId?: string;
    secretAccessKey?: string;
    bucket?: string;
    client?: Pick<S3Client, "send">;
  }) {
    super();
    const endpoint = opts && "endpoint" in opts ? opts.endpoint : env.R2_ENDPOINT;
    const accessKeyId = opts && "accessKeyId" in opts ? opts.accessKeyId : env.R2_ACCESS_KEY_ID;
    const secretAccessKey =
      opts && "secretAccessKey" in opts ? opts.secretAccessKey : env.R2_SECRET_ACCESS_KEY;
    const bucket = opts && "bucket" in opts ? opts.bucket : env.R2_BUCKET;
    this.bucket = bucket !== undefined && bucket !== "" ? bucket : null;

    if (opts?.client !== undefined) {
      this.client = opts.client;
      return;
    }

    // Build the real client only when every config value is present (the
    // ResendMailer "construct iff a key exists" guard) so the app boots without
    // creds in dev / test / CI.
    const configured =
      endpoint !== undefined &&
      endpoint !== "" &&
      accessKeyId !== undefined &&
      accessKeyId !== "" &&
      secretAccessKey !== undefined &&
      secretAccessKey !== "" &&
      this.bucket !== null;
    this.client = configured
      ? new S3Client({
          region: R2_REGION,
          endpoint,
          credentials: { accessKeyId, secretAccessKey },
          // R2 with a custom endpoint serves path-style addressing; explicit so a
          // bucket name never becomes a vhost subdomain of the R2 endpoint.
          forcePathStyle: true,
        })
      : null;
  }

  isConfigured(): boolean {
    return this.client !== null && this.bucket !== null;
  }

  async put(input: PutObjectInput): Promise<void> {
    const { client, bucket } = this.requireConfigured();
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: input.key,
        Body: input.body,
        ContentType: input.contentType,
      }),
    );
  }

  async get(key: string): Promise<Buffer> {
    const { client, bucket } = this.requireConfigured();
    const result = await client
      .send(new GetObjectCommand({ Bucket: bucket, Key: key }))
      .catch((error: unknown) => {
        if (isNoSuchKey(error)) {
          throw new ObjectStorageObjectNotFoundError(key);
        }
        throw error;
      });
    if (!result.Body) {
      throw new ObjectStorageObjectNotFoundError(key);
    }
    // The Node SdkStream body exposes transformToByteArray() — buffer it (an
    // invoice PDF is tens of KB) and hand back a Buffer the controller streams.
    const bytes = await result.Body.transformToByteArray();
    return Buffer.from(bytes);
  }

  private requireConfigured(): { client: Pick<S3Client, "send">; bucket: string } {
    if (this.client === null || this.bucket === null) {
      throw new ObjectStorageNotConfiguredError(
        "Cloudflare R2 is not configured (R2_ENDPOINT / R2_ACCESS_KEY_ID / " +
          "R2_SECRET_ACCESS_KEY / R2_BUCKET). These are operator-supplied and only present " +
          "from production (ADR-0039 c7).",
      );
    }
    return { client: this.client, bucket: this.bucket };
  }
}

/** Whether an S3 error signals a missing key (R2 returns NoSuchKey / 404). */
function isNoSuchKey(error: unknown): boolean {
  if (error instanceof Error && (error.name === "NoSuchKey" || error.name === "NotFound")) {
    return true;
  }
  const status = (error as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata
    ?.httpStatusCode;
  return status === 404;
}
