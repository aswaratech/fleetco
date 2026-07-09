# whatsapp channel operations

> **STATUS: DRAFT — written from ADR-0046 (the WhatsApp agent channel), and the mechanism it operates does not fully exist yet.** This skeleton lands with W1 (the ADR); the code it references is built across W2–W5 (`AgentPhoneLink` + the provisioning script in W2, the `WhatsAppSender` seam in W3, the inbound webhook + worker in W4, the inert photo path in W5). It is fleshed out and promoted to `STATUS: ACTIVE` — with a real "Last verified" date — in W5, once the first production deploy exists (ADR-0042 M1 / `docs/runbook/deploy.md`), a real Twilio WhatsApp sender is registered, the `TWILIO_*` secrets are set, the PO's phone link is provisioned, and each procedure below has been run once. See `docs/runbook/README.md` for the runbook discipline and `docs/architecture/decisions/0046-whatsapp-agent-channel.md` for the architecture this operates.

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

## Handling opt-out (`STOP`)

WhatsApp Business policy requires honoring opt-out. When a user sends `STOP`, the processor deactivates their `AgentPhoneLink` and the number thereafter resolves as unmapped (fail closed). `[W4: exact keyword handling + re-activation path to be filled in when the processor lands.]`

## Investigating an incident

- Every WhatsApp-driven action lands on the same `AgentAction` ledger as the web agent — review it on `/agent/activity` (filter by user/tool/status; a `flagged` row is the ungrounded-claim guard, a `denied` row is a capability refusal).
- The `WhatsAppMessageLog` records inbound/outbound wire facts (direction, provider SID, status) keyed for idempotency — use it to confirm whether a message was received once or retried.
- For undo and the prompt-injection posture, follow `docs/runbook/agent-operations.md` — the compensations (pre-image undo, the exclusions) are the agent's, inherited.

## Verification

Not yet verified — this procedure is `DRAFT` (written from ADR-0046, mechanism built across W2–W5, not executed against production). Replace with the date + `STATUS: ACTIVE` after the first real inbound message is accepted (signature verified), runs a turn as the resolved ADMIN, and the reply is delivered — with the `WhatsAppMessageLog` and `/agent/activity` rows confirming it.
