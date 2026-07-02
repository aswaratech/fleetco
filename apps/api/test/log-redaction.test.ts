import { pino } from "pino";
import { describe, expect, test } from "vitest";

import { LOG_REDACT_CENSOR, LOG_REDACT_PATHS } from "../src/observability/log-redact";

// Regression guard for the Tier-2 PII log-redaction backstop (ADR-0013). The
// denylist previously named *.driverName / *.phoneNumber, but the real
// Driver/Customer fields are `fullName` / `phone`, so those paths were DEAD and
// the PII would have logged in cleartext the first time an object carrying them
// reached a logger. This test builds a pino logger with the real denylist and
// asserts a NESTED driver/customer object is masked — fast-redact's `*.<key>`
// matches one level under a wrapper object (not a top-level key), which is why
// the fixtures are nested under `driver` / `customer`.

function logLine(obj: Record<string, unknown>): string {
  const chunks: string[] = [];
  const stream = { write: (s: string) => void chunks.push(s) };
  const logger = pino(
    { redact: { paths: [...LOG_REDACT_PATHS], censor: LOG_REDACT_CENSOR } },
    stream,
  );
  logger.info(obj, "test");
  return chunks.join("");
}

describe("pino Tier-2 PII log redaction", () => {
  test("masks a nested driver's fullName, phone, licenseNumber, dateOfBirth", () => {
    const line = logLine({
      driver: {
        id: "drv_1",
        fullName: "Ram Bahadur",
        phone: "9800000000",
        licenseNumber: "12-345-6789",
        dateOfBirth: "1990-01-01",
        status: "ACTIVE",
      },
    });
    expect(line).not.toContain("Ram Bahadur");
    expect(line).not.toContain("9800000000");
    expect(line).not.toContain("12-345-6789");
    expect(line).not.toContain("1990-01-01");
    expect(line).toContain(LOG_REDACT_CENSOR);
    // A non-PII operational field on the same object is preserved.
    expect(line).toContain("ACTIVE");
  });

  test("masks a nested customer's contactPerson, phone, email (but not the business name)", () => {
    const line = logLine({
      customer: {
        id: "cus_1",
        name: "Acme Traders",
        contactPerson: "Sita Devi",
        phone: "9811111111",
        email: "sita@acme.example",
        status: "ACTIVE",
      },
    });
    expect(line).not.toContain("Sita Devi");
    expect(line).not.toContain("9811111111");
    expect(line).not.toContain("sita@acme.example");
    // The business name is Tier-3, deliberately not redacted.
    expect(line).toContain("Acme Traders");
  });

  test("names the real PII keys and no longer the dead ones", () => {
    expect(LOG_REDACT_PATHS).toContain("*.fullName");
    expect(LOG_REDACT_PATHS).toContain("*.phone");
    expect(LOG_REDACT_PATHS).not.toContain("*.driverName");
    expect(LOG_REDACT_PATHS).not.toContain("*.phoneNumber");
  });
});
