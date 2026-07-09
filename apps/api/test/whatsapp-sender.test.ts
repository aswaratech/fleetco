import { describe, expect, test } from "vitest";

import { MockWhatsAppSender } from "../src/modules/whatsapp/mock.whatsapp-sender";
import {
  TwilioWhatsAppSender,
  TWILIO_API_BASE_URL,
} from "../src/modules/whatsapp/twilio.whatsapp-sender";
import { createWhatsAppSender } from "../src/modules/whatsapp/whatsapp-sender.factory";
import {
  WhatsAppSender,
  WhatsAppSenderNotConfiguredError,
  WhatsAppSendError,
} from "../src/modules/whatsapp/whatsapp-sender";

// Pure tests for the WhatsAppSender seam (ADR-0046 c5) — no DB, no network:
// the Twilio wire mapping, timeout, and error discipline run against an
// injected fetch (the llm-client.test.ts idiom), and the factory's selection
// runs against explicit config objects (never the frozen typed env).

const SID = "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const TOKEN = "test-auth-token";
const FROM = "whatsapp:+14155238886";
const TO = "+9779812345678";

interface CapturedRequest {
  input: string;
  init: RequestInit;
}

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A sender wired to a fetch that records the request and returns `response`. */
function makeSender(
  response: Response | (() => Response),
  opts?: ConstructorParameters<typeof TwilioWhatsAppSender>[0],
): { sender: TwilioWhatsAppSender; captured: CapturedRequest[] } {
  const captured: CapturedRequest[] = [];
  const fetchFn: typeof fetch = (input, init) => {
    captured.push({ input: String(input), init: init ?? {} });
    return Promise.resolve(typeof response === "function" ? response() : response);
  };
  const sender = new TwilioWhatsAppSender({
    accountSid: SID,
    authToken: TOKEN,
    from: FROM,
    fetchFn,
    ...opts,
  });
  return { sender, captured };
}

describe("MockWhatsAppSender", () => {
  test("records every send in call order and mints mock-<n> sids", async () => {
    const mock = new MockWhatsAppSender();
    await expect(mock.send({ to: TO, body: "first" })).resolves.toEqual({ sid: "mock-1" });
    await expect(mock.send({ to: TO, body: "second" })).resolves.toEqual({ sid: "mock-2" });
    expect(mock.sent).toEqual([
      { to: TO, body: "first" },
      { to: TO, body: "second" },
    ]);
  });

  test("can be configured to reject — the send-failure path with no network", async () => {
    const boom = new Error("provider down");
    const mock = new MockWhatsAppSender({ throwError: boom });
    await expect(mock.send({ to: TO, body: "x" })).rejects.toBe(boom);
    expect(mock.sent).toHaveLength(1);
  });
});

describe("TwilioWhatsAppSender (injected fetch)", () => {
  test("throws WhatsAppSenderNotConfiguredError before any fetch when credentials are absent", async () => {
    const captured: CapturedRequest[] = [];
    const fetchFn: typeof fetch = (input, init) => {
      captured.push({ input: String(input), init: init ?? {} });
      return Promise.resolve(jsonResponse(201, { sid: "SM1" }));
    };
    const sender = new TwilioWhatsAppSender({
      accountSid: undefined,
      authToken: undefined,
      from: undefined,
      fetchFn,
    });
    await expect(sender.send({ to: TO, body: "x" })).rejects.toBeInstanceOf(
      WhatsAppSenderNotConfiguredError,
    );
    expect(captured).toHaveLength(0);
  });

  test("POSTs the documented wire shape: URL, Basic auth, form body, whatsapp: prefixes", async () => {
    const { sender, captured } = makeSender(jsonResponse(201, { sid: "SM123" }));
    const result = await sender.send({ to: TO, body: "hello from the agent" });

    expect(result).toEqual({ sid: "SM123" });
    expect(captured).toHaveLength(1);
    const request = captured[0];
    if (request === undefined) throw new Error("no request captured");

    expect(request.input).toBe(`${TWILIO_API_BASE_URL}/2010-04-01/Accounts/${SID}/Messages.json`);
    expect(request.init.method).toBe("POST");
    const headers = request.init.headers as Record<string, string>;
    expect(headers.authorization).toBe(
      `Basic ${Buffer.from(`${SID}:${TOKEN}`).toString("base64")}`,
    );
    expect(headers["content-type"]).toBe("application/x-www-form-urlencoded");

    const params = new URLSearchParams(String(request.init.body));
    expect(params.get("To")).toBe(`whatsapp:${TO}`); // bare E.164 in, prefixed on the wire
    expect(params.get("From")).toBe(FROM); // already-prefixed From passes through
    expect(params.get("Body")).toBe("hello from the agent");
    // Tier-2 discipline: the recipient and body ride the form body, never the URL.
    expect(request.input).not.toContain(TO.slice(1));
  });

  test("prefixes a bare From and never double-prefixes an already-prefixed To", async () => {
    const { sender, captured } = makeSender(jsonResponse(201, { sid: "SM1" }), {
      from: "+14155238886",
    });
    await sender.send({ to: `whatsapp:${TO}`, body: "x" });
    const params = new URLSearchParams(String(captured[0]?.init.body));
    expect(params.get("From")).toBe("whatsapp:+14155238886");
    expect(params.get("To")).toBe(`whatsapp:${TO}`);
  });

  test("maps a provider rejection to http_<status> + the PII-free Twilio code", async () => {
    const { sender } = makeSender(
      jsonResponse(401, { code: 20003, message: `Authenticate — to ${TO}`, status: 401 }),
    );
    const error = await sender.send({ to: TO, body: "secret body text" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WhatsAppSendError);
    const sendError = error as WhatsAppSendError;
    expect(sendError.category).toBe("http_401");
    expect(sendError.twilioCode).toBe(20003);
    // The error must never echo the recipient or the body (Tier-2, ADR-0046 c8).
    expect(sendError.message).not.toContain(TO.slice(1));
    expect(sendError.message).not.toContain("secret body");
  });

  test("a non-JSON error body still maps to the status category (code null)", async () => {
    const { sender } = makeSender(new Response("<html>gateway timeout</html>", { status: 502 }));
    const error = await sender.send({ to: TO, body: "x" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WhatsAppSendError);
    expect((error as WhatsAppSendError).category).toBe("http_502");
    expect((error as WhatsAppSendError).twilioCode).toBeNull();
  });

  test("a fetch failure maps to the 'network' category with the cause attached", async () => {
    const boom = new TypeError("fetch failed");
    const fetchFn: typeof fetch = () => Promise.reject(boom);
    const sender = new TwilioWhatsAppSender({
      accountSid: SID,
      authToken: TOKEN,
      from: FROM,
      fetchFn,
    });
    const error = await sender.send({ to: TO, body: "x" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WhatsAppSendError);
    expect((error as WhatsAppSendError).category).toBe("network");
    expect((error as WhatsAppSendError).cause).toBe(boom);
  });

  test("a hung send aborts at timeoutMs and maps to the 'timeout' category", async () => {
    const fetchFn: typeof fetch = (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(init.signal?.reason ?? new Error("aborted"));
        });
      });
    const sender = new TwilioWhatsAppSender({
      accountSid: SID,
      authToken: TOKEN,
      from: FROM,
      fetchFn,
      timeoutMs: 5,
    });
    const error = await sender.send({ to: TO, body: "x" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WhatsAppSendError);
    expect((error as WhatsAppSendError).category).toBe("timeout");
  });

  test("a 2xx without a readable sid is still an accepted send (sid undefined)", async () => {
    const noSid = makeSender(jsonResponse(201, { status: "queued" }));
    await expect(noSid.sender.send({ to: TO, body: "x" })).resolves.toEqual({ sid: undefined });

    const notJson = makeSender(new Response("created", { status: 201 }));
    await expect(notJson.sender.send({ to: TO, body: "x" })).resolves.toEqual({ sid: undefined });
  });
});

describe("createWhatsAppSender (the W4 useFactory selection)", () => {
  test("binds the Twilio sender only when the full outbound group is present", () => {
    const sender = createWhatsAppSender({ accountSid: SID, authToken: TOKEN, from: FROM });
    expect(sender).toBeInstanceOf(TwilioWhatsAppSender);
    expect(sender).toBeInstanceOf(WhatsAppSender);
  });

  test.each([
    ["accountSid missing", { accountSid: undefined, authToken: TOKEN, from: FROM }],
    ["authToken missing", { accountSid: SID, authToken: undefined, from: FROM }],
    ["from missing", { accountSid: SID, authToken: TOKEN, from: undefined }],
    ["accountSid empty", { accountSid: "", authToken: TOKEN, from: FROM }],
    [
      "all missing (the kill switch)",
      { accountSid: undefined, authToken: undefined, from: undefined },
    ],
  ])("binds the no-network mock when %s", (_label, config) => {
    expect(createWhatsAppSender(config)).toBeInstanceOf(MockWhatsAppSender);
  });
});
