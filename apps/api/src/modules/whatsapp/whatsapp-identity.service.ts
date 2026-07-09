import { ForbiddenException, Injectable } from "@nestjs/common";

import type { Actor } from "../auth/driver-scope.service";
import { roleHasCapability } from "../auth/permissions";
// PrismaService is injected by NestJS via emitDecoratorMetadata; the class
// reference must remain a value import at runtime so the DI container can resolve
// it. The same eslint override the domain services use.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { PrismaService } from "../prisma/prisma.service";
import { normalizeE164 } from "./phone-e164";

// The WhatsApp inbound identity resolver (ADR-0046 c4/c9B) — the channel's
// AUTHORIZATION CHOKEPOINT. AgentService.runTurn TRUSTS its caller-supplied
// actor and does NOT itself re-check agent:use (the HTTP RolesGuard did that);
// the webhook has no RolesGuard, so THIS service is the wall the guard used to
// be. It is the single place that turns "a number sent a WhatsApp message" into
// "the authorized human the agent runs as", and it fails closed on every unhappy
// path — exactly as DriverScopeService fails closed for an unlinked driver.
//
// It lives in the whatsapp module directory but is NOT registered in a Nest
// module until W4 wires the WhatsAppModule (the ADR's W2/W4 boundary — W4 owns
// the inbound webhook, worker, and outbound sender that consume it). W2
// unit-tests it by direct instantiation (the create-user.ts precedent).
@Injectable()
export class WhatsAppIdentityService {
  constructor(private readonly prisma: PrismaService) {}

  // Resolve a raw inbound `From` (Twilio delivers `whatsapp:+<E164>`) to the
  // Actor the agent runs as, or throw ForbiddenException (403) — the uniform
  // fail-closed contract (the DriverScopeService posture). THREE fail-closed
  // gates, in order:
  //   1. an unparseable / loose number      -> 403 (never a partial match)
  //   2. no ACTIVE link for the number       -> 403 (unmapped or deactivated;
  //      ADR-0046 c9C open-relay invariant — an unknown number gets nothing)
  //   3. the linked user lacks agent:use      -> 403 (turn-time authorization on
  //      the LIVE role, ADR-0046 c9B — a demotion after linking is honored, so a
  //      link never becomes a latent grant)
  // Success returns { userId, role } read from the live user row.
  async resolveSenderToActor(rawFrom: string): Promise<Actor> {
    let phoneE164: string;
    try {
      phoneE164 = normalizeE164(rawFrom);
    } catch {
      // Unparseable/loose input never falls through to a lookup — fail closed.
      throw new ForbiddenException();
    }

    const link = await this.prisma.agentPhoneLink.findUnique({
      where: { phoneE164 },
      select: { active: true, user: { select: { id: true, role: true } } },
    });
    if (!link || !link.active) {
      throw new ForbiddenException();
    }

    const { id: userId, role } = link.user;
    // Turn-time authorization (ADR-0046 c9B): re-check agent:use against the LIVE
    // role, not the role frozen at link time. agent:use is ADMIN-only in v1
    // (ADR-0043 c1); widening it is ADR-0043's separate decision and would take
    // effect here automatically (the capability indirection).
    if (!roleHasCapability(role, "agent:use")) {
      throw new ForbiddenException();
    }

    return { userId, role };
  }
}
