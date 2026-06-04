import { InjectQueue } from "@nestjs/bullmq";
import { Injectable } from "@nestjs/common";
import { type Prisma } from "@prisma/client";
import { type Queue } from "bullmq";

import { type GpsPingInput } from "./telematics.schemas";

// PrismaService is injected by NestJS via emitDecoratorMetadata (see
// apps/api/tsconfig.json); the class reference must remain a value import at
// runtime so the DI container can resolve it. Same eslint override as every
// other vertical-slice service.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { PrismaService } from "../prisma/prisma.service";

// The named queue this feature owns (ADR-0029 commitment 2: per-feature queue
// ownership — the root config lives in the @Global() QueueModule from T1, but
// the `gps-ingest` queue is registered and owned HERE, by the telematics
// feature that produces and consumes it). Exported so the producer
// (@InjectQueue), the worker (@Processor in gps-ingest.processor.ts), and the
// module (BullModule.registerQueue) all name the SAME string — a typo would
// otherwise wire a producer to one queue and a worker to another with no
// compile error.
export const GPS_INGEST_QUEUE = "gps-ingest";

// The job name within the queue. One job = one batch (ADR-0026 commitment 4:
// the batch is the unit, not the ping).
export const GPS_INGEST_JOB_NAME = "ingest-batch";

// Worker concurrency for the ingest queue (ADR-0029 commitment 5: "the ingest
// worker tuned to its batch size"). Each job is a single bulk `createMany`, so
// a handful of concurrent jobs gives throughput without flooding the Prisma
// connection pool with parallel large inserts. 4 is a deliberate, modest
// default that is overridable per the ADR's "Revisit when" once real fleet
// volume is measured — it is sized against assumption, not load (ADR-0029
// "Costs we accept").
export const GPS_INGEST_CONCURRENCY = 4;

// The job payload that travels through Redis from the producer (the endpoint)
// to the consumer (the worker). It carries the validated batch plus the
// `createdById` resolved from the authenticated session (ADR-0021) — the body
// never supplies `createdById` (the schema's `.strict()` rejects it), so it
// rides alongside the pings here rather than inside each one. Note `pings`
// carry `timestamp` as the validated ISO STRING (not a Date): BullMQ
// JSON-serializes this object into Redis, so a Date would be a string on the
// other side anyway — the worker maps it to `new Date(...)` at insert time.
export interface GpsIngestJobData {
  createdById: string;
  pings: GpsPingInput[];
}

@Injectable()
export class TelematicsService {
  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(GPS_INGEST_QUEUE) private readonly queue: Queue<GpsIngestJobData>,
  ) {}

  /**
   * Producer half of the ingestion path (ADR-0029 commitment 10). Enqueue the
   * validated batch onto `gps-ingest` and RETURN FAST — the API thread does
   * NOT block on the database write; the worker (insertBatch, below) does the
   * bulk insert asynchronously. `createdById` comes from the authenticated
   * principal (the controller reads `request.session.user.id`), never from the
   * body. Returns a small acknowledgement (the BullMQ job id for correlation
   * and the count accepted) — the endpoint replies 202 with it; it does not
   * echo the rows, which do not exist yet.
   */
  async enqueueBatch(
    pings: GpsPingInput[],
    createdById: string,
  ): Promise<{ jobId: string | null; accepted: number }> {
    const job = await this.queue.add(GPS_INGEST_JOB_NAME, { createdById, pings });
    return { jobId: job.id ?? null, accepted: pings.length };
  }

  /**
   * Consumer half (ADR-0029 commitment 10), called by the `gps-ingest`
   * worker. Bulk-insert the batch via a single `createMany`.
   *
   * The insert supplies ONLY the native Float columns + FKs + timestamp. The
   * `geometry` column is `GENERATED ALWAYS … STORED` (T2), so the database
   * derives it from latitude/longitude and Prisma must never write it — which
   * it satisfies for free because the Unsupported `geometry` column is absent
   * from `GpsPingCreateManyInput` entirely. `tripId` / `altitude` / `speed` /
   * `heading` default to null when the ping omitted them. `timestamp` is the
   * validated ISO string mapped to a `Date` here.
   *
   * `createMany` issues one all-or-nothing INSERT: if any row violates an FK
   * (a stale `vehicleId` / `tripId` / `createdById`), Postgres rejects the
   * whole batch and the job fails. That is the intended posture for a batch
   * from one device (a consistent set of fixes), and the failure rides
   * BullMQ's bounded retry → `failed`-set dead-letter (the T1 default job
   * options) rather than a synchronous 4xx — the 202 was already sent.
   */
  async insertBatch(data: GpsIngestJobData): Promise<{ count: number }> {
    const rows: Prisma.GpsPingCreateManyInput[] = data.pings.map((ping) => ({
      vehicleId: ping.vehicleId,
      tripId: ping.tripId ?? null,
      latitude: ping.latitude,
      longitude: ping.longitude,
      altitude: ping.altitude ?? null,
      speed: ping.speed ?? null,
      heading: ping.heading ?? null,
      timestamp: new Date(ping.timestamp),
      createdById: data.createdById,
    }));

    return this.prisma.gpsPing.createMany({ data: rows });
  }
}
