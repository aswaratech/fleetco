// Idempotent privileged WhatsApp phone-link provisioner (ADR-0046 c4). Maps a
// canonical E.164 phone number to an existing user so that inbound WhatsApp
// messages from that number run the agent AS that user. There is deliberately
// NO public endpoint (the create-user.ts / seed-* precedent): a phone link is a
// privileged identity grant, created only by an operator with shell access.
//
// It REFUSES to link a user who does not hold agent:use (ADMIN-only in v1,
// ADR-0043 c1) — a WhatsApp link may only point at a user the agent is allowed
// to run as (ADR-0046 c4). Authorization is NOT frozen at link time: the inbound
// resolver (WhatsAppIdentityService) re-checks agent:use against the live role on
// every turn (ADR-0046 c9B), so this check is a provisioning-time guardrail, not
// the security boundary.
//
// Idempotent on the canonical phoneE164 (the @unique key): the first run creates
// the link; a re-run for the same number → the same user is a no-op that reports
// the existing link; the same number → a DIFFERENT user is refused (a phone
// identity is not silently reassigned — deactivate/remove the old link first).
//
//   Usage:
//     pnpm --filter @fleetco/api exec tsx scripts/link-whatsapp-number.ts <email> <phone>
//
//   <phone> is canonical E.164 (e.g. +9779812345678); a `whatsapp:` prefix and
//   surrounding whitespace are tolerated, internal separators are not. The number
//   (Tier-2 PII) is echoed to stdout only, for operator confirmation on their own
//   machine (the create-user.ts email-echo posture) — never to a log channel.

import { fileURLToPath } from "node:url";

import { PrismaClient, type UserRole } from "@prisma/client";

import { roleHasCapability } from "../src/modules/auth/permissions";
import { normalizeE164 } from "../src/modules/whatsapp/phone-e164";

export interface LinkWhatsAppInput {
  email: string;
  phone: string;
}

export interface LinkWhatsAppResult {
  created: boolean;
  id: string;
  phoneE164: string;
  userEmail: string;
  userRole: UserRole;
}

// Link `phone` to the user identified by `email`, idempotently. Throws if (a) the
// number is not canonical E.164, (b) no user has that email, (c) the user does
// not hold agent:use, or (d) the number is already linked to a different user.
// The E.164 normalization is the SAME function the inbound resolver uses, so the
// stored key is byte-identical to what an inbound message resolves to.
export async function linkWhatsAppNumber(
  prisma: PrismaClient,
  input: LinkWhatsAppInput,
): Promise<LinkWhatsAppResult> {
  const phoneE164 = normalizeE164(input.phone);

  const user = await prisma.user.findUnique({
    where: { email: input.email },
    select: { id: true, email: true, role: true },
  });
  if (!user) {
    throw new Error(`No user with email "${input.email}".`);
  }
  if (!roleHasCapability(user.role, "agent:use")) {
    throw new Error(
      `User ${input.email} has role ${user.role}, which does not hold agent:use; ` +
        `a WhatsApp link may point only at an agent-authorized (ADMIN) user (ADR-0046 c4).`,
    );
  }

  const existing = await prisma.agentPhoneLink.findUnique({
    where: { phoneE164 },
    select: { id: true, userId: true },
  });
  if (existing) {
    if (existing.userId !== user.id) {
      throw new Error(
        "That number is already linked to a different user; deactivate or remove " +
          "the existing link before reassigning it.",
      );
    }
    return {
      created: false,
      id: existing.id,
      phoneE164,
      userEmail: user.email,
      userRole: user.role,
    };
  }

  const link = await prisma.agentPhoneLink.create({
    data: { phoneE164, userId: user.id, verifiedAt: new Date(), active: true },
    select: { id: true },
  });
  return {
    created: true,
    id: link.id,
    phoneE164,
    userEmail: user.email,
    userRole: user.role,
  };
}

async function main(): Promise<void> {
  const email = process.argv[2];
  const phone = process.argv[3];
  if (!email || !phone) {
    throw new Error(
      "Usage: pnpm --filter @fleetco/api exec tsx scripts/link-whatsapp-number.ts <email> <phone>",
    );
  }

  const prisma = new PrismaClient();
  try {
    const result = await linkWhatsAppNumber(prisma, { email, phone });
    if (result.created) {
      console.log(`Linked ${result.phoneE164} -> ${result.userEmail} (${result.userRole}).`);
    } else {
      console.log(
        `${result.phoneE164} is already linked to ${result.userEmail} (${result.userRole}); no change.`,
      );
    }
  } finally {
    await prisma.$disconnect();
  }
}

// Run main() ONLY when executed directly (tsx scripts/link-whatsapp-number.ts …),
// not when imported by a test. The test imports `linkWhatsAppNumber` and must not
// trigger the argv-reading, process-exiting CLI path (the create-user.ts guard).
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
