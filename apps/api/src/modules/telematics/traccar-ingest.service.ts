import { Injectable, Logger } from "@nestjs/common";
import { TrackerStatus } from "@prisma/client";

import { IngestBatchSchema } from "./telematics.schemas";
import { mapTraccarPosition, type TraccarForward } from "./traccar-ingest.schemas";

// PrismaService / TelematicsService are injected via emitDecoratorMetadata;
// the class references must remain value imports for DI. Same eslint override
// as every other service.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { PrismaService } from "../prisma/prisma.service";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { TelematicsService } from "./telematics.service";

// The credential-less gateway system user (ADR-0042 c5). GpsPing.createdById
// is a required FK (ADR-0021's authenticated-principal audit chain), but the
// Traccar gateway is a machine, not a session — so its pings are stamped with
// a SEEDED system user that has NO better-auth account row (it can never log
// in; see scripts/seed-gateway-user.ts, which creates this exact id). The id
// is a fixed constant, not a cuid, so the seed script and this adapter can
// never disagree (User.id has no @default, so an explicit id is required
// anyway). If the operator has not run the seed, the worker's insert fails on
// the FK and the batch lands in BullMQ's failed set — loud, recoverable, and
// documented in docs/runbook/traccar.md (M6).
export const GATEWAY_USER_ID = "user_gps_gateway";

// Why a forward was dropped (the ack tells Traccar's log a reason; Tier-3
// strings only — never coordinates).
export type TraccarDropReason = "invalid-fix" | "unknown-device" | "invalid-values";

export interface TraccarIngestAck {
  accepted: number;
  dropped: number;
  reason: TraccarDropReason | null;
  jobId: string | null;
}

// TraccarIngestService — the gateway adapter (ADR-0042 c4/c6, ticket M5): one
// Traccar position forward in, one house-shaped ping enqueued on the EXISTING
// gps-ingest pipeline out. A dedicated service (not more methods on
// TelematicsService) because the adapter owns a distinct concern — the
// foreign contract, the IMEI→vehicle resolution, and the drop taxonomy —
// while the queue/worker path stays exactly the T3 seam it always was.
//
// DELIVERY SHAPE (recorded expectation, ADR-0042 c4): forward.type=json sends
// ONE position per request, so every enqueue here is a batch-of-one — one
// BullMQ job per ping rather than the ≤1000-ping batches the queue was sized
// for. Fine at this fleet's scale (a few positions/second worst case); the
// fleet-size threshold at which adapter-side batching becomes worthwhile is
// named in ADR-0042 and revisited there, not silently engineered now.
//
// DROP SEMANTICS: every drop answers 202 (accepted upstream, discarded here)
// because a non-2xx makes Traccar RETRY, and retrying cannot fix an unmapped
// IMEI or an invalid fix — it would only wedge the forward queue. Drops warn-
// log the IMEI + reason ONLY (Tier 3; never coordinates — Tier-5 egress
// discipline holds even for rejects).
@Injectable()
export class TraccarIngestService {
  private readonly logger = new Logger(TraccarIngestService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly telematics: TelematicsService,
  ) {}

  async ingestForward(forward: TraccarForward): Promise<TraccarIngestAck> {
    const imei = forward.device.uniqueId;

    // Traccar's own GPS-validity flag: `valid: false` means the device itself
    // reported a non-fix (no satellite lock). Not a position; drop.
    if (forward.position.valid === false) {
      this.logger.warn(`dropped invalid fix (no GPS validity) from device ${imei}`);
      return { accepted: 0, dropped: 1, reason: "invalid-fix", jobId: null };
    }

    // IMEI → vehicle via the M3 TrackerDevice aggregate. Only an ACTIVE,
    // MOUNTED device maps: a SPARE/RETIRED unit (or one never registered)
    // produces positions FleetCo has no vehicle for. Registered-IMEIs-only is
    // also half of the ADR-0042 c9 spoofing mitigation (Traccar registers
    // known IMEIs only; unknowns that slip through drop here).
    const device = await this.prisma.trackerDevice.findUnique({ where: { imei } });
    if (!device || device.status !== TrackerStatus.ACTIVE || device.vehicleId === null) {
      this.logger.warn(`dropped ping from unmapped device ${imei} (register it on /trackers)`);
      return { accepted: 0, dropped: 1, reason: "unknown-device", jobId: null };
    }

    // Map the foreign shape to the house wire ping, then RE-VALIDATE through
    // the same IngestBatchSchema bounds every other producer passes (ADR-0042
    // c6): tolerance at the Traccar boundary must never become tolerance in
    // the pipeline. A failure here means corrupt coordinates/timestamp — drop
    // (a 4xx would only make Traccar retry the same corrupt value).
    const mapped = mapTraccarPosition(forward, device.vehicleId);
    const checked = IngestBatchSchema.safeParse({ pings: [mapped] });
    if (!checked.success) {
      this.logger.warn(`dropped out-of-bounds ping from device ${imei}`);
      return { accepted: 0, dropped: 1, reason: "invalid-values", jobId: null };
    }

    const { jobId, accepted } = await this.telematics.enqueueBatch(
      checked.data.pings,
      GATEWAY_USER_ID,
    );
    return { accepted, dropped: 0, reason: null, jobId };
  }
}
