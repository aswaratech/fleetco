import { z } from "zod";

// The LOOSE boundary schema for one inbound Twilio message webhook (ADR-0046
// c2: loose-boundary-then-canonical — the Traccar TraccarForwardSchema
// posture). Twilio posts dozens of parameters (AccountSid, ProfileName,
// WaId, SmsStatus, …); this schema picks exactly what the job needs and lets
// Zod's default strip the rest. It is deliberately TOLERANT about content —
// the canonical revalidation happens in the worker (normalizeE164 + the
// resolver's fail-closed authz), where a bad value becomes an audited drop
// rather than a webhook 400 that would make Twilio retry something a retry
// cannot fix. Only a payload that is not a message at all (no MessageSid /
// From) 400s from the pipe.
export const TwilioInboundWebhookSchema = z.object({
  /** Twilio's message SID — the dedup/replay key (ADR-0046 c7). */
  MessageSid: z.string().min(1).max(64),
  /** The sender, in Twilio's `whatsapp:+<E164>` form (normalized in the worker). */
  From: z.string().min(1).max(128),
  /** The text body. Optional on the wire (a media-only message has none —
   * the W5 photo path reads NumMedia/MediaUrl0; W4 treats it as empty text). */
  Body: z.string().max(10_000).optional().default(""),
});

export type TwilioInboundWebhook = z.infer<typeof TwilioInboundWebhookSchema>;

/** The `whatsapp-inbound` job payload — exactly the boundary slice the worker
 * consumes (data minimization: no ProfileName, no WaId; the phone is the only
 * Tier-2 value carried, and Redis job payloads are transient). */
export interface WhatsAppInboundJobData {
  messageSid: string;
  from: string;
  body: string;
}
