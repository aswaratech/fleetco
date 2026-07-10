# whatsapp channel operations

> **STATUS: DRAFT — the mechanism is fully built (W1–W5 complete, 2026-07-10) but has never run in production.** Every procedure below now has real code behind it: `AgentPhoneLink` + the provisioning script (W2), the `WhatsAppSender` seam (W3), the signature-guarded inbound webhook + worker (W4), and the photo path (W5, inert behind the standing image-intake pause). The one thing this file still awaits is the M1 first production deploy (ADR-0042 / `docs/runbook/deploy.md`): promotion to `STATUS: ACTIVE` — with a real "Last verified" date — happens when the operator has registered a real Twilio WhatsApp sender, set the `TWILIO_*` secrets, provisioned the PO's phone link, and run §Verification once against the deployed system. See `docs/runbook/README.md` for the runbook discipline and `docs/architecture/decisions/0046-whatsapp-agent-channel.md` for the architecture this operates.

## When this procedure applies

- **First-time setup** — registering a Twilio WhatsApp sender + the inbound webhook URL and turning the channel on (operator, M1-gated).
- **Provisioning / deprovisioning a phone link** — mapping a verified phone number to an ADMIN user (or removing one).
- **Disabling the channel** — the kill switch (taking the channel entirely off Twilio).
- **Rotating `TWILIO_AUTH_TOKEN`** (scheduled hygiene, or a suspected leak).
- **Handling opt-out** — a user sends `STOP`; deactivating their link.
- **Investigating an incident** — a suspected prompt-injection, an unexpected autonomous write, or inbound abuse.

The moving parts, all in the new `whatsapp` API module once built: the inbound webhook + `TwilioSignatureGuard` (W4), the `whatsapp-inbound` queue + `WhatsAppInboundProcessor` (W4), the phone→user resolver + `AgentPhoneLink` model + the provisioning script (W2), the `WhatsAppSender` seam that binds `TwilioWhatsAppSender` when `TWILIO_*` is set and `MockWhatsAppSender` when it is not (W3), the `WhatsAppMessageLog` delivery/idempotency ledger (W2), and the `TWILIO_*` / `WEB_PUBLIC_URL` block in `apps/api/src/config/env.ts` (W1). The channel drives the existing agent, so `docs/runbook/agent-operations.md` (undo, prompt-injection posture, the DeepSeek kill switch) applies unchanged to every WhatsApp-driven turn.

## Prerequisites

- [ ] The production stack is running per `docs/runbook/deploy.md` (compose project at `/opt/fleetco/`, env at `/opt/fleetco/.env`). The inbound webhook needs a publicly reachable 24/7 HTTPS endpoint — this channel cannot function before M1.
- [ ] A Twilio account with a WhatsApp sender (the sandbox for testing, or an approved WhatsApp Business number for production) and its Account SID + Auth Token.
- [ ] Shell access to the box and permission to edit `/opt/fleetco/.env` (root; the file is `chmod 600`).
- [ ] An ADMIN account (only ADMIN holds `agent:use` — ADR-0043 c1; a phone link may only point at an ADMIN user).

## First-time setup (operator, M1-gated)

1. In the Twilio console, register the WhatsApp sender and note the `whatsapp:+<E164>` From number.
2. Set the inbound webhook to `https://<deploy-host>/api/v1/whatsapp/inbound` (HTTP POST). This exact URL is what the signature is verified against — it must equal `TWILIO_WEBHOOK_URL` byte-for-byte (trailing slash, scheme, host).
3. Edit `/opt/fleetco/.env` (an editor, not `echo`/`sed` — shell history must not capture the token) and set: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` (Tier-1 secrets), `TWILIO_WHATSAPP_FROM`, `TWILIO_WEBHOOK_URL` (the URL from step 2), and `WEB_PUBLIC_URL` (the admin web's public base, for reply deep-links).
4. Recreate the api container so the new env loads: `docker compose -f docker-compose.prod.yml up -d api` (from `/opt/fleetco/`).
5. Provision the PO's phone link (below), then send a test message and verify per §Verification.

## Provisioning a phone link

A phone link maps a verified E.164 number to an ADMIN user. It is created only by the privileged script (`apps/api/scripts/link-whatsapp-number.ts`) — there is no public endpoint — and the script **refuses to link a non-ADMIN user** (only ADMIN holds `agent:use` in v1). Run it from the repo root (or on the box, against `/opt/fleetco/.env`):

`pnpm --filter @fleetco/api exec tsx scripts/link-whatsapp-number.ts <email> <phone>`

- `<email>` is an existing ADMIN user's login email; `<phone>` is the number in E.164 (e.g. `+9779812345678`). A `whatsapp:` prefix and surrounding whitespace are tolerated; internal separators (spaces, dashes) are **rejected** — type the canonical form.
- The number is stored canonical E.164 (`@unique`); the **same** normalization runs at link-write and inbound-resolve, so a stored key and an inbound number are byte-identical (the lookup cannot miss on formatting).
- Idempotent on the number: a re-run for the same number → the same user is a no-op; the same number → a **different** user is refused (deactivate/remove the existing link first — a phone identity is not silently reassigned).
- Authorization is re-checked at **turn time** (ADR-0046 c9B): the link is an identity pointer, not a stored grant, so demoting the user later closes the channel for them automatically (the resolver fails closed on a non-`agent:use` role exactly as on an unmapped number).
- Day-1 this is a single row: the PO's number → the PO's ADMIN user.

## Disabling the channel (kill switch)

- **Whole channel off:** clear the `TWILIO_*` values in `/opt/fleetco/.env` and recreate the api container. The `WhatsAppSender` factory then binds `MockWhatsAppSender` and `TwilioSignatureGuard` fails closed (503) — no inbound turn runs, no outbound message is sent (the `RESEND_API_KEY` / `DEEPSEEK_API_KEY` kill-switch idiom).
- **One user off:** deactivate that `AgentPhoneLink` (opt-out, below) — the rest of the channel keeps working.

## Rotating `TWILIO_AUTH_TOKEN`

`TWILIO_AUTH_TOKEN` is a Tier-1 secret (ADR-0013): production secret store / `/opt/fleetco/.env` only, never a repo file, never a command line, never a log. It is dual-purpose — it both verifies the inbound signature **and** Basic-auths the outbound send — so a rotation must keep Twilio's console and the env in agreement or inbound verification breaks.

1. If rotating because of a suspected leak, treat this as a security incident FIRST: `docs/runbook/security-incident-response.md` (contain before assessing).
2. Rotate the auth token in the Twilio console (Twilio supports a primary/secondary token rotation — use it to avoid a verification gap).
3. Edit `/opt/fleetco/.env`, replace `TWILIO_AUTH_TOKEN`, and recreate the api container.
4. Verify inbound (a test message is accepted, not 403'd) and outbound (a reply arrives) per §Verification.

## Photo messages (the receipt path — currently paused)

A photo sent to the company number is downloaded from Twilio (Basic-auth, host-allowlisted to `api.twilio.com` only), magic-byte-sniffed (JPEG/PNG/WEBP, 10 MB cap — the declared content type is never trusted), stored as a first-class agent attachment, and attached to the turn exactly like a web-composer photo. **The image-intake pipeline is PAUSED** (`AGENT_OCR_URL` unset — the ADR-0044 V0 decision of 2026-07-06), so today the turn degrades to the honest "image extraction is not configured" notice: the photo is stored and auditable, but nothing is extracted from it. Un-pausing is the agent's own procedure (`docs/runbook/agent-operations.md` — the OCR sidecar + `AGENT_OCR_URL`), not a WhatsApp change; the moment it un-pauses, WhatsApp photos feed the extract→propose→confirm flow with no code change here.

- A photo that cannot be downloaded or fails the sniff/cap drops the **whole** message (caption included) with a server-authored "photo could not be received" reply, audited as `media_failed` — a caption-only turn would answer as if the photo had arrived.
- A message with neither text nor a supported media item (a sticker, location, reaction) is dropped as `ignored_empty` with no reply and no LLM cost.

## Handling opt-out (`STOP`) and re-activation (`START`)

WhatsApp Business policy requires honoring opt-out. The worker handles both keywords before any agent turn (trimmed, case-insensitive, exact match — `stop`, ` STOP `, and `Stop` all count):

- **`STOP`** deactivates the sender's `AgentPhoneLink` (idempotent — an already-inactive link stays inactive), audited as an `opt_out` row in the `WhatsAppMessageLog`. **No reply is sent** (answering an opt-out violates the policy). Every later message from the number fails closed as unauthorized until re-activation.
- **`START`** re-activates a deactivated link (idempotent), audited as `opt_in`, also with no reply (a courtesy confirmation is a billed message carrying no information). Re-activation is **user-recoverable opt-in to an operator-provisioned link only** — it creates nothing, and every subsequent message still passes the turn-time `agent:use` check, so START grants nothing the user's live role does not hold.
- **Permanent removal** (the operator revoking a number, not the user pausing it): delete the link row — `DELETE FROM agent_phone_link WHERE "phoneE164" = '+977…';` via psql on the box. A deleted number cannot self-reactivate with START; re-linking requires the provisioning script.
- Keywords from an unmapped number change nothing (audited as `dropped_unmapped`, no reply — the open-relay posture).

## Investigating an incident

- Every WhatsApp-driven action lands on the same `AgentAction` ledger as the web agent — review it on `/agent/activity` (filter by user/tool/status; a `flagged` row is the ungrounded-claim guard, a `denied` row is a capability refusal).
- The `WhatsAppMessageLog` records inbound/outbound wire facts (direction, provider SID, status) keyed for idempotency — use it to confirm whether a message was received once or retried.
- For undo and the prompt-injection posture, follow `docs/runbook/agent-operations.md` — the compensations (pre-image undo, the exclusions) are the agent's, inherited.

## Verification

Not yet verified — this procedure is `DRAFT` (mechanism complete as of W5, never executed against production). The first-run checklist, post-M1, after §First-time setup and provisioning the PO's link:

1. **Text round-trip:** WhatsApp "how many vehicles are active" to the company number → a reply arrives in-thread; the `WhatsAppMessageLog` shows the inbound row `processed` + outbound row(s) `sent` with provider SIDs, and the conversation appears in the web chat list.
2. **A write with an action card:** "log 40 litres of diesel for <vehicle> at 180 per litre" → the reply carries the ✓ action card with the changed fields and a deep-link; `/agent/activity` shows the action; the deep-link opens the record.
3. **Photo (paused-state):** send any photo → the reply is the honest "image extraction is not configured" degradation; the attachment row exists.
4. **Fail-closed:** a message from an unlinked number gets NO reply and a `dropped_unmapped` row.
5. **Opt-out round-trip:** `STOP` → no reply, link deactivated, next message dropped; `START` → link reactivated, messages flow.
6. **The kill switch:** clear `TWILIO_*`, recreate the api container, confirm the webhook answers 503; restore.

Replace this section's first line with the run date + flip the header to `STATUS: ACTIVE` when all six pass.
