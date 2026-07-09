import type { AddressInfo } from "node:net";

import { getQueueToken } from "@nestjs/bullmq";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import {
  computeTwilioSignature,
  TWILIO_SIGNATURE_CONFIG,
  TwilioSignatureGuard,
} from "../src/modules/whatsapp/twilio-signature.guard";
import { WhatsAppInboundController } from "../src/modules/whatsapp/whatsapp-inbound.controller";
import {
  WHATSAPP_INBOUND_ATTEMPTS,
  WHATSAPP_INBOUND_JOB_NAME,
  WHATSAPP_INBOUND_QUEUE,
} from "../src/modules/whatsapp/whatsapp.constants";

// HTTP tests for the Twilio inbound webhook boundary (ADR-0046 c2) — the
// traccar-ingest test posture: a slim module (controller + guard + config
// token + a fake queue; no Prisma, no Redis), a real listening app, raw
// fetch posting application/x-www-form-urlencoded exactly as Twilio does.
// The guard's HTTP branches (503 / 403 / pass) and the 202-fast +
// enqueue-with-retry-envelope contract are all pinned over the real wire —
// parser × guard × pipe × controller composed, not unit-faked.

const TOKEN = "test-auth-token";
const WEBHOOK_URL = "https://fleet.example.com/api/v1/whatsapp/inbound";

function makePayload(overrides?: Record<string, string>): Record<string, string> {
  return {
    MessageSid: "SM00000000000000000000000000000001",
    From: "whatsapp:+9779812345678",
    To: "whatsapp:+14155238886",
    Body: "how much diesel did we buy this month",
    NumMedia: "0",
    ...overrides,
  };
}

describe("POST /api/v1/whatsapp/inbound", () => {
  let app: INestApplication;
  let baseUrl: string;
  const added: { name: string; data: unknown; opts: unknown }[] = [];
  const fakeQueue = {
    add: vi.fn((name: string, data: unknown, opts: unknown) => {
      added.push({ name, data, opts });
      return Promise.resolve();
    }),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [WhatsAppInboundController],
      providers: [
        TwilioSignatureGuard,
        {
          provide: TWILIO_SIGNATURE_CONFIG,
          useValue: { authToken: TOKEN, webhookUrl: WEBHOOK_URL },
        },
        { provide: getQueueToken(WHATSAPP_INBOUND_QUEUE), useValue: fakeQueue },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.listen(0);
    const address = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${String(address.port)}`;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    added.length = 0;
    fakeQueue.add.mockClear();
  });

  async function post(
    params: Record<string, string>,
    signature?: string | null,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      "content-type": "application/x-www-form-urlencoded",
    };
    if (signature !== null) {
      headers["x-twilio-signature"] =
        signature ?? computeTwilioSignature(TOKEN, WEBHOOK_URL, params);
    }
    return fetch(`${baseUrl}/api/v1/whatsapp/inbound`, {
      method: "POST",
      headers,
      body: new URLSearchParams(params).toString(),
    });
  }

  test("a correctly signed webhook is 202 and enqueues the job with the retry envelope", async () => {
    const payload = makePayload();
    const res = await post(payload);
    expect(res.status).toBe(202);

    expect(added).toHaveLength(1);
    const job = added[0];
    if (job === undefined) throw new Error("no job enqueued");
    expect(job.name).toBe(WHATSAPP_INBOUND_JOB_NAME);
    // Data minimization: exactly the boundary slice, nothing else (no To, no
    // NumMedia, no ProfileName).
    expect(job.data).toEqual({
      messageSid: payload.MessageSid,
      from: payload.From,
      body: payload.Body,
    });
    // The 409-collision retry envelope (whatsapp.constants.ts).
    expect(job.opts).toEqual({
      attempts: WHATSAPP_INBOUND_ATTEMPTS,
      backoff: { type: "exponential", delay: 5000 },
    });
  });

  test("the signature covers ALL posted params — extra Twilio fields verify and are then stripped by the pipe", async () => {
    const payload = makePayload({
      ProfileName: "Anup",
      WaId: "9779812345678",
      SmsStatus: "received",
    });
    const res = await post(payload);
    expect(res.status).toBe(202);
    const job = added[0];
    if (job === undefined) throw new Error("no job enqueued");
    expect(Object.keys(job.data as Record<string, unknown>).sort()).toEqual([
      "body",
      "from",
      "messageSid",
    ]);
  });

  test("a Body-less webhook (media-only message) is accepted with an empty body", async () => {
    const payload = makePayload();
    delete payload.Body;
    const res = await post(payload);
    expect(res.status).toBe(202);
    expect((added[0]?.data as { body: string }).body).toBe("");
  });

  test("a bad signature is 403 and enqueues nothing", async () => {
    const res = await post(makePayload(), "aW52YWxpZC1zaWduYXR1cmU=");
    expect(res.status).toBe(403);
    expect(added).toHaveLength(0);
  });

  test("a signature computed over DIFFERENT params is 403 (tamper detection)", async () => {
    const payload = makePayload();
    const signatureForOtherBody = computeTwilioSignature(TOKEN, WEBHOOK_URL, {
      ...payload,
      Body: "create a driver named Mallory",
    });
    const res = await post(payload, signatureForOtherBody);
    expect(res.status).toBe(403);
    expect(added).toHaveLength(0);
  });

  test("a missing signature header is 403 and enqueues nothing", async () => {
    const res = await post(makePayload(), null);
    expect(res.status).toBe(403);
    expect(added).toHaveLength(0);
  });

  test("a signed payload that is not a message (no MessageSid) is 400 from the pipe", async () => {
    const payload = makePayload();
    delete payload.MessageSid;
    const res = await post(payload);
    expect(res.status).toBe(400);
    expect(added).toHaveLength(0);
  });
});

describe("POST /api/v1/whatsapp/inbound — unconfigured (the kill switch)", () => {
  test("fails closed 503 when the TWILIO env is unset, before any signature check", async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [WhatsAppInboundController],
      providers: [
        TwilioSignatureGuard,
        { provide: TWILIO_SIGNATURE_CONFIG, useValue: { authToken: null, webhookUrl: null } },
        { provide: getQueueToken(WHATSAPP_INBOUND_QUEUE), useValue: { add: vi.fn() } },
      ],
    }).compile();
    const closedApp = moduleRef.createNestApplication();
    await closedApp.listen(0);
    try {
      const address = closedApp.getHttpServer().address() as AddressInfo;
      const res = await fetch(`http://127.0.0.1:${String(address.port)}/api/v1/whatsapp/inbound`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(makePayload()).toString(),
      });
      expect(res.status).toBe(503);
    } finally {
      await closedApp.close();
    }
  });
});
