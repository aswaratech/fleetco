import { randomUUID } from "node:crypto";

import { Test, type TestingModule } from "@nestjs/testing";
import { UserRole } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { linkWhatsAppNumber } from "../scripts/link-whatsapp-number";
import { InvalidPhoneNumberError } from "../src/modules/whatsapp/phone-e164";
import { PrismaService } from "../src/modules/prisma/prisma.service";
import { resetDb } from "./db";

// Integration tests for the privileged phone-link provisioner (ADR-0046 c4). The
// load-bearing guarantees: it REFUSES a non-agent:use (non-ADMIN) user, stores
// the canonical E.164 key the inbound resolver looks up, is idempotent on the
// number, and never silently reassigns a number to a different user. Real
// Postgres + the real @unique constraint, since idempotence and the reassign
// refusal are DB-backed.
describe("linkWhatsAppNumber (integration, real Postgres)", () => {
  let module: TestingModule;
  let prisma: PrismaService;

  const PHONE = "+9779812345678";

  beforeAll(async () => {
    module = await Test.createTestingModule({ providers: [PrismaService] }).compile();
    await module.init();
    prisma = module.get(PrismaService);
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await resetDb(prisma);
  });

  async function seedUser(role: UserRole): Promise<string> {
    const email = `${role.toLowerCase()}-${randomUUID()}@fleetco.test`;
    await prisma.user.create({
      data: { id: randomUUID(), email, name: "Test", role, emailVerified: true },
    });
    return email;
  }

  test("links an ADMIN user, stores the canonical E.164 key, and marks it verified + active", async () => {
    const email = await seedUser(UserRole.ADMIN);

    const result = await linkWhatsAppNumber(prisma, { email, phone: PHONE });
    expect(result.created).toBe(true);
    expect(result.phoneE164).toBe(PHONE);
    expect(result.userRole).toBe(UserRole.ADMIN);

    const link = await prisma.agentPhoneLink.findUniqueOrThrow({ where: { phoneE164: PHONE } });
    expect(link.active).toBe(true);
    expect(link.verifiedAt).not.toBeNull();
  });

  test("normalizes a whatsapp:-prefixed input to the same key the resolver looks up", async () => {
    const email = await seedUser(UserRole.ADMIN);
    const result = await linkWhatsAppNumber(prisma, { email, phone: `whatsapp:${PHONE}` });
    expect(result.phoneE164).toBe(PHONE);
    expect(await prisma.agentPhoneLink.count({ where: { phoneE164: PHONE } })).toBe(1);
  });

  test("REFUSES to link an OFFICE_STAFF user (no agent:use)", async () => {
    const email = await seedUser(UserRole.OFFICE_STAFF);
    await expect(linkWhatsAppNumber(prisma, { email, phone: PHONE })).rejects.toThrow(/agent:use/);
    expect(await prisma.agentPhoneLink.count()).toBe(0);
  });

  test("REFUSES to link a DRIVER user (no agent:use)", async () => {
    const email = await seedUser(UserRole.DRIVER);
    await expect(linkWhatsAppNumber(prisma, { email, phone: PHONE })).rejects.toThrow(/agent:use/);
    expect(await prisma.agentPhoneLink.count()).toBe(0);
  });

  test("is idempotent — re-linking the same number to the same user is a no-op", async () => {
    const email = await seedUser(UserRole.ADMIN);

    const first = await linkWhatsAppNumber(prisma, { email, phone: PHONE });
    expect(first.created).toBe(true);

    const second = await linkWhatsAppNumber(prisma, { email, phone: `whatsapp:${PHONE}` });
    expect(second.created).toBe(false);
    expect(second.id).toBe(first.id);
    expect(await prisma.agentPhoneLink.count()).toBe(1);
  });

  test("REFUSES to reassign a number already linked to a different user", async () => {
    const emailA = await seedUser(UserRole.ADMIN);
    const emailB = await seedUser(UserRole.ADMIN);

    await linkWhatsAppNumber(prisma, { email: emailA, phone: PHONE });
    await expect(linkWhatsAppNumber(prisma, { email: emailB, phone: PHONE })).rejects.toThrow(
      /different user/,
    );

    // The original link is untouched.
    const link = await prisma.agentPhoneLink.findUniqueOrThrow({
      where: { phoneE164: PHONE },
      select: { user: { select: { email: true } } },
    });
    expect(link.user.email).toBe(emailA);
  });

  test("throws on a non-canonical number before touching the database", async () => {
    const email = await seedUser(UserRole.ADMIN);
    await expect(linkWhatsAppNumber(prisma, { email, phone: "+977 981" })).rejects.toBeInstanceOf(
      InvalidPhoneNumberError,
    );
  });

  test("throws when no user has the given email", async () => {
    await expect(
      linkWhatsAppNumber(prisma, { email: "nobody@fleetco.test", phone: PHONE }),
    ).rejects.toThrow(/No user/);
  });
});
