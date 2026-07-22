import { describe, expect, test } from "vitest";

import {
  Mailer,
  MailerNotConfiguredError,
  MailerSendError,
  type MailMessage,
} from "../src/modules/notifications/mailer";
import { MockMailer } from "../src/modules/notifications/mock.mailer";
import { DEFAULT_FROM_ADDRESS, ResendMailer } from "../src/modules/notifications/resend.mailer";

// Unit tests for the FleetCo Mailer seam (ADR-0038 C1). Pure and network-free
// by construction: the no-key path throws BEFORE any SDK call, and the
// send-mapping path uses an injected fake client — so no test ever reaches
// Resend. There is no API key and no verified sending domain yet; a real smoke
// send is a post-deploy operator step, never a test/CI dependency (ADR-0038 c1).

// A fake, Resend-shaped client that records the payloads it is handed and
// returns a canned response — so ResendMailer's success/error mapping is
// exercised with no network. Its shape is checked for compatibility with
// ResendMailer's `client` option where it is passed to the constructor.
interface FakeSendPayload {
  from: string;
  to: string[];
  subject: string;
  text: string;
  html?: string;
}
interface FakeResponse {
  data: { id: string } | null;
  error: { name: string; message: string } | null;
}
function fakeClient(response: FakeResponse): {
  emails: { send(payload: FakeSendPayload): Promise<FakeResponse> };
  calls: FakeSendPayload[];
} {
  const calls: FakeSendPayload[] = [];
  return {
    calls,
    emails: {
      send(payload: FakeSendPayload): Promise<FakeResponse> {
        calls.push(payload);
        return Promise.resolve(response);
      },
    },
  };
}

const MESSAGE: MailMessage = {
  to: ["operator@fleetco.example"],
  subject: "FleetCo — 2 items need attention",
  text: "Bluebook for BA 1 KHA 2345 expires 2083 Jestha 6 (2026-05-20).",
};

describe("Mailer contract", () => {
  test("ResendMailer and MockMailer both implement the Mailer port", () => {
    // The abstract class is the DI token C2 will inject; both implementations
    // are real subtypes (so `{ provide: Mailer, useClass: ... }` resolves).
    expect(new ResendMailer({ apiKey: undefined })).toBeInstanceOf(Mailer);
    expect(new MockMailer()).toBeInstanceOf(Mailer);
    expect(typeof new MockMailer().send).toBe("function");
  });
});

describe("ResendMailer construction", () => {
  test("constructs with an explicit key without throwing (no send happens at construction)", () => {
    expect(() => new ResendMailer({ apiKey: "re_test_key_not_real" })).not.toThrow();
  });

  test("constructs with no key — the app boots keyless in dev/test/CI", () => {
    // The env path (RESEND_API_KEY is unset in tests) and the explicit no-key
    // path both tolerate construction; the channel simply cannot send.
    expect(() => new ResendMailer()).not.toThrow();
    expect(() => new ResendMailer({ apiKey: undefined })).not.toThrow();
  });
});

describe("ResendMailer.send without a configured key", () => {
  test("throws MailerNotConfiguredError and never reaches the network", async () => {
    // Forced no-key (independent of ambient env): the null-client guard runs
    // before any SDK construction or call, so this is provably network-free.
    const mailer = new ResendMailer({ apiKey: undefined });
    await expect(mailer.send(MESSAGE)).rejects.toBeInstanceOf(MailerNotConfiguredError);
  });
});

describe("ResendMailer.send mapping (injected fake client — no network)", () => {
  test("maps a provider success to { id } and forwards the message with the default from", async () => {
    const fake = fakeClient({ data: { id: "resend-id-123" }, error: null });
    const mailer = new ResendMailer({ client: fake });

    const result = await mailer.send(MESSAGE);

    expect(result).toEqual({ id: "resend-id-123" });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toMatchObject({
      from: DEFAULT_FROM_ADDRESS,
      to: MESSAGE.to,
      subject: MESSAGE.subject,
      text: MESSAGE.text,
    });
  });

  test("forwards an HTML body and an overridden from address", async () => {
    const fake = fakeClient({ data: { id: "resend-id-456" }, error: null });
    const mailer = new ResendMailer({ client: fake, from: "ops@fleetco.example" });
    const htmlMessage: MailMessage = { ...MESSAGE, html: "<p>Bluebook expires soon.</p>" };

    await mailer.send(htmlMessage);

    expect(fake.calls[0].from).toBe("ops@fleetco.example");
    expect(fake.calls[0].html).toBe("<p>Bluebook expires soon.</p>");
  });

  test("an explicitly-undefined from falls back to the placeholder — the module wiring's env-unset path", async () => {
    // NotificationModule passes `{ from: env.RESEND_FROM }` unconditionally, so
    // when the operator has not set RESEND_FROM the constructor must land on
    // DEFAULT_FROM_ADDRESS, not a broken undefined sender.
    const fake = fakeClient({ data: { id: "resend-id-789" }, error: null });
    const mailer = new ResendMailer({ client: fake, from: undefined });

    await mailer.send(MESSAGE);

    expect(fake.calls[0].from).toBe(DEFAULT_FROM_ADDRESS);
  });

  test("throws MailerSendError on a provider error, carrying the PII-free category — not the recipient", async () => {
    // A provider error whose raw message embeds the recipient address (Tier-2
    // PII). The thrown error must carry only the provider's error CATEGORY, so a
    // downstream log (C3's SLI logs the class name only) cannot leak the address.
    const leakedRecipient = "driver-private@example.com";
    const fake = fakeClient({
      data: null,
      error: { name: "validation_error", message: `Invalid \`to\` field: ${leakedRecipient}` },
    });
    const mailer = new ResendMailer({ client: fake });

    let caught: unknown;
    try {
      await mailer.send(MESSAGE);
    } catch (error) {
      caught = error;
    }

    // It did NOT swallow the error (C3's SLI needs the throw to count a failure).
    expect(caught).toBeInstanceOf(MailerSendError);
    if (caught instanceof MailerSendError) {
      expect(caught.providerErrorName).toBe("validation_error");
      expect(caught.message).toContain("validation_error");
      expect(caught.message).not.toContain(leakedRecipient);
    }
  });
});

describe("MockMailer", () => {
  test("records each send in order and returns a default mock id", async () => {
    const mock = new MockMailer();

    const first = await mock.send(MESSAGE);
    const second = await mock.send({ ...MESSAGE, subject: "Second digest" });

    expect(mock.sent).toHaveLength(2);
    expect(mock.sent[0]).toEqual(MESSAGE);
    expect(mock.sent[1].subject).toBe("Second digest");
    expect(first).toEqual({ id: "mock-1" });
    expect(second).toEqual({ id: "mock-2" });
  });

  test("returns a configured result", async () => {
    const mock = new MockMailer({ result: { id: "configured-id" } });
    await expect(mock.send(MESSAGE)).resolves.toEqual({ id: "configured-id" });
  });

  test("throws a configured error but still records the attempt (C3 failure path)", async () => {
    const boom = new Error("provider down");
    const mock = new MockMailer({ throwError: boom });

    await expect(mock.send(MESSAGE)).rejects.toBe(boom);
    expect(mock.sent).toHaveLength(1);
  });
});
