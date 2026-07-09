import { randomUUID } from "node:crypto";

import { ForbiddenException } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import { UserRole } from "@prisma/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { PrismaService } from "../src/modules/prisma/prisma.service";
import { WhatsAppIdentityService } from "../src/modules/whatsapp/whatsapp-identity.service";
import { resetDb } from "./db";

// Integration tests for the WhatsApp inbound identity resolver (ADR-0046 c4/c9B)
// — the channel's AUTHORIZATION CHOKEPOINT. runTurn trusts its actor, so this is
// the wall the RolesGuard used to be. Every unhappy path must fail closed (403
// ForbiddenException); ONLY an active link to a user holding agent:use (ADMIN in
// v1) resolves to an Actor. Real Postgres because the point is the DB-backed
// lookup and the live-role re-check.
describe("WhatsAppIdentityService.resolveSenderToActor (integration, real Postgres)", () => {
  let module: TestingModule;
  let prisma: PrismaService;
  let service: WhatsAppIdentityService;

  // A stable number reused across tests — resetDb() truncates between each, so
  // there is never more than one link for it at a time.
  const PHONE = "+9779812345678";

  beforeAll(async () => {
    module = await Test.createTestingModule({ providers: [PrismaService] }).compile();
    await module.init();
    prisma = module.get(PrismaService);
    service = new WhatsAppIdentityService(prisma);
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await resetDb(prisma);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function seedUser(role: UserRole): Promise<string> {
    const id = randomUUID();
    await prisma.user.create({
      data: {
        id,
        email: `${role.toLowerCase()}-${id}@fleetco.test`,
        name: "Test",
        role,
        emailVerified: true,
      },
    });
    return id;
  }

  async function linkPhone(userId: string, phoneE164: string, active = true): Promise<void> {
    await prisma.agentPhoneLink.create({
      data: { phoneE164, userId, active, verifiedAt: new Date() },
    });
  }

  test("resolves an ADMIN with an active link to that user's Actor", async () => {
    const userId = await seedUser(UserRole.ADMIN);
    await linkPhone(userId, PHONE);

    const actor = await service.resolveSenderToActor(`whatsapp:${PHONE}`);
    expect(actor).toEqual({ userId, role: UserRole.ADMIN });
  });

  test("resolves whether or not the inbound From carries the whatsapp: prefix (DB-layer coherence)", async () => {
    const userId = await seedUser(UserRole.ADMIN);
    await linkPhone(userId, PHONE); // stored bare, exactly as the provisioning script writes it

    await expect(service.resolveSenderToActor(`whatsapp:${PHONE}`)).resolves.toEqual({
      userId,
      role: UserRole.ADMIN,
    });
    await expect(service.resolveSenderToActor(PHONE)).resolves.toEqual({
      userId,
      role: UserRole.ADMIN,
    });
  });

  test("resolves each number to ITS OWN linked user (c9C exact-match / correct-row selection)", async () => {
    // The chokepoint's defining property: THIS number resolves to the user linked
    // to THIS number — never to some other link's owner. Two links prove the
    // resolver keys on the sender's number, not "any active link" (an open-relay
    // mutant that dropped the phoneE164 filter would return the wrong owner here).
    const OTHER = "+9779800000000";
    const userA = await seedUser(UserRole.ADMIN);
    const userB = await seedUser(UserRole.ADMIN);
    await linkPhone(userA, PHONE);
    await linkPhone(userB, OTHER);

    await expect(service.resolveSenderToActor(`whatsapp:${PHONE}`)).resolves.toEqual({
      userId: userA,
      role: UserRole.ADMIN,
    });
    await expect(service.resolveSenderToActor(`whatsapp:${OTHER}`)).resolves.toEqual({
      userId: userB,
      role: UserRole.ADMIN,
    });
  });

  test("fails closed (403) for a valid but unlinked number while ANOTHER number IS linked (open-relay guard, c9C)", async () => {
    // The worst channel failure: a stranger's un-linked number must NOT resolve to
    // the owner's Actor just because some link exists.
    const owner = await seedUser(UserRole.ADMIN);
    await linkPhone(owner, PHONE);
    await expect(service.resolveSenderToActor("whatsapp:+9779800000000")).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  test("fails closed (403) when the number is unmapped", async () => {
    await seedUser(UserRole.ADMIN); // a user exists, but no link for PHONE
    await expect(service.resolveSenderToActor(`whatsapp:${PHONE}`)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  test("fails closed (403) when the link is deactivated (opt-out)", async () => {
    const userId = await seedUser(UserRole.ADMIN);
    await linkPhone(userId, PHONE, false);
    await expect(service.resolveSenderToActor(`whatsapp:${PHONE}`)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  test("fails closed (403) when the linked user lacks agent:use — OFFICE_STAFF demoted after linking (turn-time re-check, c9B)", async () => {
    // The provisioning script would refuse to CREATE this link, but a role can
    // change AFTER a link is made; the resolver re-checks the LIVE role, so an
    // active link to a non-ADMIN user must still fail closed.
    const userId = await seedUser(UserRole.OFFICE_STAFF);
    await linkPhone(userId, PHONE);
    await expect(service.resolveSenderToActor(`whatsapp:${PHONE}`)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  test("fails closed (403) when the linked user is a DRIVER (no agent:use)", async () => {
    const userId = await seedUser(UserRole.DRIVER);
    await linkPhone(userId, PHONE);
    await expect(service.resolveSenderToActor(`whatsapp:${PHONE}`)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  test("fails closed (403) on an unparseable From, without a DB lookup", async () => {
    // The "without a DB lookup" half is a real property: garbage short-circuits in
    // normalizeE164 before any query — fail-closed AND no DB load from junk input.
    const lookup = vi.spyOn(prisma.agentPhoneLink, "findUnique");
    await expect(service.resolveSenderToActor("whatsapp:not-a-number")).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(lookup).not.toHaveBeenCalled();
  });
});
