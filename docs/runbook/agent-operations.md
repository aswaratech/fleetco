# agent operations

> **STATUS: DRAFT — written from ADR-0043 (the AI chat agent, tickets A1–A8), not yet executed against a production system.** Promote to `STATUS: ACTIVE` with a real "Last verified" date once the first production deploy exists (ADR-0042 M1 / `docs/runbook/deploy.md`), a real `DEEPSEEK_API_KEY` has been set, and each procedure below has been run once. See `docs/runbook/README.md` for the runbook discipline and `docs/architecture/decisions/0043-ai-chat-agent.md` for the architecture this operates.

## When this procedure applies

- **Rotating or revoking the DeepSeek API key** (scheduled hygiene, or a suspected leak).
- **Disabling the agent** — the kill switch (taking the agent off the hosted provider entirely).
- **Undoing an agent update** — restoring a record from the pre-image the agent captured before changing it.
- **Reviewing agent behavior** or investigating a suspected prompt-injection incident.
- **Requesting the DeepSeek training opt-out** for the API account (one-time, best-effort).

The moving parts, all committed: the LLM-client factory (`apps/api/src/modules/agent/agent.module.ts` — binds the real `DeepSeekClient` when `DEEPSEEK_API_KEY` is set, the no-network `MockLlmClient` when it is not), the tool registry and its redaction choke point (`apps/api/src/modules/agent/tools/tool-registry.ts`, `apps/api/src/modules/agent/redact-for-model.ts`), the turn loop and audit writes (`apps/api/src/modules/agent/agent.service.ts`), the `DEEPSEEK_API_KEY` block in `.env.production.example`, and the two web surfaces (`/chat`, `/agent/activity`).

## Prerequisites

- [ ] The production stack is running per `docs/runbook/deploy.md` (compose project at `/opt/fleetco/`, env at `/opt/fleetco/.env`).
- [ ] Shell access to the box and permission to edit `/opt/fleetco/.env` (root; the file is `chmod 600`).
- [ ] An ADMIN account (only ADMIN holds `agent:use` in v1 — ADR-0043 c1).
- [ ] For the undo procedure: access to the affected record's edit form in the app (or an authenticated session for a manual `PATCH`).

## Rotating DEEPSEEK_API_KEY

`DEEPSEEK_API_KEY` is a Tier-1 secret (ADR-0013): it lives only in the production secret store / `/opt/fleetco/.env`, never in a repo file, never on a command line where shell history would capture it, never in a log.

1. Create the new key in the DeepSeek platform console (the account that carries the training opt-out request — see below).
2. **If rotating because of a suspected leak**, treat this as a security incident FIRST: follow `docs/runbook/security-incident-response.md` (contain before assessing — rotate immediately, then scope the exposure).
3. Edit `/opt/fleetco/.env` and replace the `DEEPSEEK_API_KEY` value (use an editor, not `echo`/`sed` on the command line).
4. Recreate the api container so the new env loads: `docker compose -f docker-compose.prod.yml up -d api` (from `/opt/fleetco/`).
5. Verify per §Verification below.
6. Revoke the OLD key in the DeepSeek console, and confirm a request with the old key now fails.

## Kill switch — taking the agent off the network

Unsetting the key IS the kill switch (ADR-0043 c2, the `RESEND_API_KEY` pattern):

1. Edit `/opt/fleetco/.env` and set `DEEPSEEK_API_KEY=` (empty value; the env schema treats empty as unset).
2. Recreate the api container: `docker compose -f docker-compose.prod.yml up -d api`.
3. The DI factory now binds `MockLlmClient`: `/chat` and `/agent/activity` stay up, turns complete instantly with the mock's fixed reply naming the missing key, and **nothing egresses to the provider**. No tool executes from mock turns (the mock never emits tool calls).
4. Re-enable by restoring the key and recreating the container.

Honest limit: the kill switch stops NEW turns from reaching the provider. It cannot recall content already sent — per ADR-0043 c6 the working assumption is that prompt content already transmitted may be retained by the provider.

## Verification (after a rotation, kill, or re-enable)

1. Sign in as ADMIN, open `/chat`, send one short turn ("how many vehicles do I have?").
2. **Real key**: a substantive answer arrives (tool calls visible as action cards) and the new `AgentMessage` rows carry non-zero `promptTokens` (visible in the DB; the mock reports zeros).
3. **Kill switch**: the reply is the fixed MockLlmClient text naming the missing key — that exact reply in production means the key is unset or typo'd in `/opt/fleetco/.env`.
4. Open `/agent/activity` and confirm the turn's dispatches (if any) are listed.

> **Run once against a LOCAL stack (2026-07-05):** with a real key in the dev `apps/api/.env`, the real client bound and a two-call turn succeeded end-to-end — `fleet_snapshot` dispatched (34 ms, `succeeded`), a substantive and accurate answer, non-zero token usage on both `AgentMessage` rows, and the dispatch listed on `/agent/activity`. The PRODUCTION run of this procedure — and this file's DRAFT→ACTIVE promotion — still awaits the M1 deploy.

## Undoing an agent update (the pre-image procedure)

Every agent UPDATE captures the prior row into `AgentAction.previousJson` before executing (ADR-0043 c4b). Undo is **manual in v1 — there is no undo button**; the pre-image is the source, a normal edit is the mechanism.

1. **Locate the action row** on `/agent/activity`: filter by tool (`update_vehicle` / `update_driver` / `update_trip`), status `succeeded`, and the date; the Entity column links to the affected record.
   - SQL alternative (on the box): `docker compose -f docker-compose.prod.yml exec postgres psql -U fleetco -c 'SELECT "toolName", "argsJson", "previousJson", "resultEntityType", "resultEntityId", "createdAt" FROM agent_action WHERE "toolName" LIKE $$update_%$$ ORDER BY "createdAt" DESC LIMIT 20;'`
2. **Read the pre-image** from the row's Details disclosure (`previousJson` — the raw prior row, dates as ISO strings). It is **Tier 2**: never paste it into logs, chat (including the agent's own chat), issues, or any LLM.
3. **Restore via a normal edit**: open the record's edit form in the app and re-enter the prior values from the pre-image (preferred), or send an authenticated `PATCH /api/v1/vehicles/:id` (or `/drivers/:id`, `/trips/:id`) carrying ONLY the fields to revert. The corrective edit is ordinary manual editing — it does not write an `AgentAction` row.
4. **Caveats — read before restoring:**
   - **Trip meter bumps are one-way.** An `IN_PROGRESS → COMPLETED` transition bumped the vehicle's odometer/engine-hours monotonically in the same transaction. Reverting the trip does NOT roll the vehicle back — correct the Vehicle's meter by hand if it matters.
   - **Terminal statuses do not reverse.** `COMPLETED`/`CANCELLED` trips accept no reverse transition; restore the other fields and leave the status.
   - **Derived stamps re-derive.** Restoring `status` can re-stamp `retiredAt`/`terminatedAt`; send the explicit prior value from the pre-image in the same PATCH.
   - **Uniqueness can collide.** Restoring an old `registrationNumber`/`licenseNumber`/`panNumber` that another row has since taken fails with a 409 — resolve the collision first.
5. **Verify** on the record's detail page that the restored values match the pre-image.

## Prompt-injection posture

v1 executes creates and updates **without a human confirmation gate — by explicit PO decision** (ADR-0043 c3/c4 and its Alternatives section): a misread instruction, or an injection riding a free-text field the agent reads (a note, a customer name), can mutate records without a human check. The compensating bounds, all structural:

- **Exclusions**: no delete tools, no invoice operations, no raw GPS access, no user/role management — the worst possible action is a reversible create/update.
- **Pre-image undo** (above) for every update; creates are corrected or retired through the normal surfaces.
- **The indefinite ledger**: every dispatch — succeeded, failed, denied — is an `AgentAction` row on `/agent/activity`; there are no silent paths.
- **Loop budgets** (8 rounds / 15 executions / 90 s per turn) bound how much one turn can do.
- **Rendering discipline**: assistant text is untrusted — the web linkifies only allowlisted app routes; action cards render from the server's records, never model text.

Operational watch: skim `/agent/activity` after heavy use. A wrong-entity write is THE signal — the documented fallback is the ADR's confirm-before-write alternative ("Revisit when"), designed and ready to reinstate. A `status: "flagged"` row is a DIFFERENT signal, distinct from a wrong-entity write: it means the model's final reply claimed a create/update that its own tool calls this turn don't back up — the **ungrounded-claim guard** (`docs/glossary.md`, ADR-0043's 2026-07-05 annotation) caught a fabricated confirmation before the user could mistake it for a real one. Open the row's `argsJson` (rule A/B + the matched excerpt) and the flagged message in the transcript; a rising rate of these is the signal named in the ADR's "Revisit when" for tightening the guard or reconsidering the no-confirmation-gate design. A SUSPECTED INJECTION (the agent acted on instructions embedded in data, not typed by the user) is a security incident: capture the conversation id + action rows, then follow `docs/runbook/security-incident-response.md`.

## DeepSeek training opt-out request (one-time, best-effort)

Per ADR-0043 c6: DeepSeek processes and stores data in the PRC and may use inputs/outputs for training; an opt-out exists under their privacy policy's rights section but is jurisdiction-dependent, so it is requested and then treated as **best-effort** — the working assumption stays "prompt content may be retained and used for training" regardless of the outcome.

1. From the account owner's email, submit the training opt-out for the API account via DeepSeek's privacy contact / console privacy settings (whichever their current policy names).
2. Record the request date and any response below in this section (append, do not overwrite).
3. This request precedes first production use: the key stays unset until it has been sent (the sequencing ADR-0043's phase-mismatch section commits to).

- Requested: **2026-07-05** (submitted by the account owner via DeepSeek's console privacy settings / privacy contact, before the first real prompt egress). · Response: _none yet — best-effort per ADR-0043 c6; append any reply here._

## What can go wrong

- **Key leaked** → rotate (above) + `docs/runbook/security-incident-response.md`; the old key must be revoked, not just replaced.
- **The agent updated the wrong record** → the undo procedure; mind the caveats (meters, terminal statuses, derived stamps, uniqueness).
- **Provider outage / persistent 429s** → turns end with a system-role notice in the transcript (the loop's degraded path); self-heals when the provider recovers; the kill switch is optional if spend or noise matters.
- **Mock-style replies in production** ("MockLlmClient reply…") → `DEEPSEEK_API_KEY` is unset or typo'd in `/opt/fleetco/.env`; fix and recreate the api container.
- **An undo PATCH returns 409** → a uniqueness collision with a row created since (see caveats).
- **An action row with no conversation link** → its transcript aged past the 180-day prune (`conversationId` is null by design); the row's denormalized fields (tool, args, entity, user, time) are still the complete audit record.
- **A `status: "flagged"` row on `/agent/activity`** → the ungrounded-claim guard caught the model claiming a write its own tool calls this turn don't support (see the Operational watch paragraph above); the message it flagged is preserved verbatim in the transcript with a system notice appended underneath it. No data was written — that is exactly what the guard verified before flagging.

## The OCR sidecar — image extraction (ADR-0044)

Photo attachments in `/chat` are processed in two local-first stages (ADR-0044 Box B): the image transcribes on a **self-hosted OCR sidecar** (`AGENT_OCR_URL`, an OpenAI-compatible llama.cpp endpoint serving the pinned GGUF — Docker Model Runner in local dev, a compose sidecar in production), and the transcription structures into typed fields via the existing DeepSeek text client. **Pixels never leave FleetCo infrastructure**; extracted text enters the turn as Tier-2 conversation, like dictation.

- **Kill switch:** unset `AGENT_OCR_URL` (empty value) and recreate the api container — the DI factory binds the unconfigured mock, `/chat` keeps working, and an attachment turn degrades to the honest notice "Image extraction is not configured." Text chat and all tools are unaffected.
- **Local dev:** `AGENT_OCR_URL=http://localhost:12434/engines/llama.cpp/v1` with Docker Model Runner serving `huggingface.co/sahilchachra/unlimited-ocr-gguf:Q4_K_M` (the V0-pinned quant; verify with `docker model status` / `docker model ls`).
- **Sizing note (production):** the model needs ~5 GB resident for vision inference (the V0 measurement recorded in ADR-0044 Box B) — the sidecar decision interacts with the VPS size; read the ADR before enabling on the box.
- **Health:** a failing sidecar surfaces per-turn as "Document extraction failed (ocr_…)" system notices — check the sidecar container/model, not the api. Extraction failures never block text chat.
- **Verification (after enabling or changing the sidecar):** attach a real receipt photo in `/chat` with no caption → expect the extraction system line, a field-by-field proposal that ASKS before writing, and — after your confirming reply — the created record's action card. The V0 eval checklist (Devanagari quality, per-class verdicts) lives with ADR-0044's Box B annotation.
