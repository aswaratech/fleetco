# traccar

> **STATUS: DRAFT — written from ADR-0042 (hardware GPS trackers + live map, ticket M6), not yet executed.** Promote to `STATUS: ACTIVE` with a real "Last verified" date once the gateway has been brought up on the production box and a real device's position has flowed end-to-end (device → Traccar → API → `/map`); until then treat every step as unverified. See `docs/runbook/README.md` for the runbook discipline and `docs/architecture/decisions/0042-hardware-gps-trackers-and-live-map.md` for the architecture this implements.

## When this procedure applies

- **Bringing up the GPS gateway** for the first time (the one-time §Database creation + §Bring-up steps).
- **Onboarding a tracker device**: registering a new Teltonika unit's IMEI in the gateway, pointing the device's SIM at the box, and mapping it to a vehicle in FleetCo (§Device registration → §The FleetCo mapping step).
- **Operating the gateway**: verifying positions flow, troubleshooting silent devices, retention and backup checks.

The moving parts, all committed: the `traccar` service in `docker-compose.prod.yml` (version-pinned official image, device TCP port 5027, loopback-only web UI on 8082), the non-secret config `deploy/traccar.xml` (secrets ride in as env overrides — see `.env.production.example`), the retention prune `deploy/traccar-prune.sh`, the extended nightly dump in `deploy/backup.sh`, and the API-side ingest adapter from M5 (`apps/api/src/modules/telematics/traccar-ingest.service.ts` behind `apps/api/src/modules/telematics/ingest-key.guard.ts`).

Placeholders — replace with real values, never commit them: `<vps-host>`, `<imei>` (the unit's 15-digit IMEI), `<sim-number>` (the SIM's MSISDN).

## Prerequisites

- [ ] The first production deploy has run (`docs/runbook/deploy.md`) — postgres is up and healthy on the box.
- [ ] `/opt/fleetco/.env` carries real values for **`INGEST_API_KEY`** and **`TRACCAR_DB_PASSWORD`** (both `openssl rand -hex 32`; see `.env.production.example`). The API answers 503 on the ingest route while `INGEST_API_KEY` is unset — fails closed.
- [ ] The credential-less gateway system user is seeded ONCE per environment (it stamps `createdById` on every hardware ping; without it every forward fails its FK):

  ```
  docker compose -f docker-compose.prod.yml run --rm api \
    pnpm --filter @fleetco/api exec tsx scripts/seed-gateway-user.ts
  ```

- [ ] The VPS firewall / provider security group allows inbound **TCP 5027** (the device port). Port 8082 must NOT be opened — it is bound to loopback on purpose.
- [ ] Device IMEIs collected (printed on each unit's label; cross-check with the SMS command in §Device registration) and SIMs provisioned with data (NTC or Ncell, <50 MB/month per device — ADR-0042 c1).

## One-time: create the `traccar` database and role

The postgres entrypoint creates only `POSTGRES_DB` on FIRST volume init, so the separate `traccar` database (ADR-0042 c3) is created explicitly — an initdb-mounted script would silently not run on the already-initialized production volume, which is why this is a runbook step and not an init script. The snippet is idempotent (safe to re-run) and doubles as the **password-rotation** procedure (the `ALTER ROLE` line). The `traccar` role must OWN the database: Postgres 15+ revoked public-schema `CREATE` from non-owners, and Traccar's first boot runs a Liquibase migration that creates ~40 tables as the connecting user.

On the box, from `/opt/fleetco` (reads `TRACCAR_DB_PASSWORD` from the on-box `.env`; the password reaches psql as a variable, never on a command line):

```
set -a; . ./.env; set +a
docker compose -f docker-compose.prod.yml exec -T -e TRACCAR_DB_PASSWORD postgres \
  sh -c 'exec psql -v ON_ERROR_STOP=1 -v pw="$TRACCAR_DB_PASSWORD" -U "$POSTGRES_USER" -d postgres -f -' <<'SQL'
SELECT 'CREATE ROLE traccar LOGIN'
 WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'traccar')\gexec
ALTER ROLE traccar WITH LOGIN PASSWORD :'pw';
SELECT 'CREATE DATABASE traccar OWNER traccar'
 WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'traccar')\gexec
ALTER DATABASE traccar OWNER TO traccar;
SQL
```

Verify: `docker compose -f docker-compose.prod.yml exec -T postgres psql -U "$POSTGRES_USER" -d postgres -c '\l traccar'` lists the database with owner `traccar`.

## Bring-up

```
# from /opt/fleetco
docker compose -f docker-compose.prod.yml up -d traccar
docker compose -f docker-compose.prod.yml ps            # traccar: starting -> healthy
docker compose -f docker-compose.prod.yml logs traccar  # first boot runs Liquibase (can take ~2 min;
                                                        # the healthcheck's start_period allows for it)
```

Confirm the port posture — only 5027 public and 8082 loopback-only:

```
ss -tlnp | grep -E '5027|8082'
# expect: 0.0.0.0:5027 (and/or [::]:5027), 127.0.0.1:8082 — NEVER 0.0.0.0:8082
```

## Web UI access and first-login hardening

The UI is loopback-only; reach it via an SSH tunnel from your machine:

```
ssh -L 8082:127.0.0.1:8082 <vps-host>
# then browse http://localhost:8082
```

- [ ] First login is Traccar's default **`admin` / `admin`** — change the password IMMEDIATELY (top-right → Account).
- [ ] Settings → Server: disable user **registration** (the gateway has exactly one human account; FleetCo users never log in here).

## Device registration (known-IMEI-only)

`deploy/traccar.xml` pins `database.registerUnknown=false` (ADR-0042 c9): a device whose IMEI is not registered here is dropped by Traccar itself — nothing is decoded, nothing is forwarded. This is the first of the two registries a unit must be in (the second is FleetCo's — next section).

In the tunneled UI: **Devices → + → Name** (use the FleetCo label, e.g. `FMC920 unit 1`) and **Identifier = the unit's 15-digit IMEI**, exactly as printed. Nothing else is required.

To read the IMEI off a powered unit (or verify a label), SMS it `  getinfo` (see the SMS format note below) — the reply includes the IMEI.

## SIM / APN and pointing the device at the box (Teltonika, SMS)

Teltonika FMB/FMC-family units are configured by SMS `setparam` commands. **SMS format:** `<login> <password> <command>` — when no SMS login/password is set on the device (factory state), send **two leading spaces** before the command, e.g. `␣␣setparam 2001:ntnet`. Send from any phone to `<sim-number>`.

1. **APN** (parameter 2001; username/password 2002/2003 — both empty for NTC and Ncell):
   - NTC (Nepal Telecom) SIM: `  setparam 2001:ntnet`
   - Ncell SIM: `  setparam 2001:web`
2. **Server host + port + protocol** (parameters 2004 / 2005 / 2006). Protocol MUST be TCP (`2006:0`) — compose publishes 5027/tcp only; a UDP-configured device transmits into a closed port and never appears:
   ```
     setparam 2004:<vps-host>;2005:5027;2006:0
   ```
   (`<vps-host>` = the box's public IP or DNS name; combining ids with `;` in one SMS is supported.)
3. **Verify**: `  getstatus` — the reply shows GPRS/link state; the device should show a green (online) dot in the tunneled Traccar UI within a minute or two of ignition-on.

Record the SIM's MSISDN on the FleetCo tracker row (`simMsisdn`) — it is where these commands go and what gets topped up monthly.

## The FleetCo mapping step (the second registry)

Traccar knowing the IMEI makes positions decode; **FleetCo knowing the IMEI makes them land on a vehicle**. The M5 adapter resolves every forward against the tracker register and maps it ONLY when the register row is `ACTIVE` **and** assigned to a vehicle — anything else is dropped fail-safe (a 202 with a drop reason; unknown IMEIs appear in the API's warn log).

In the FleetCo admin at `/trackers`: **New tracker** → the same 15-digit IMEI → assign the vehicle → status **Active** (→ install date). Registered-but-unmounted units stay **Spare**; end-of-life units are unassigned then **Retired** (there is deliberately no delete).

## Verification (end-to-end)

- [ ] Device shows online (green) in the tunneled Traccar UI and its position updates there.
- [ ] The API accepted a forward: the api log shows no `traccar-ingest` warns for this IMEI (drops log at warn with the IMEI, never coordinates), and the vehicle's latest fix moves: `GET /api/v1/telematics/positions/latest` (or the `/map` page once M9 ships) shows a fresh `fixAgeSeconds`.
- [ ] `docker compose -f docker-compose.prod.yml exec -T postgres psql -U "$POSTGRES_USER" -d traccar -tAc 'SELECT count(*) FROM tc_positions'` grows while the vehicle moves.

## Retention and backup (Tier-5 discipline, ADR-0042 c8)

Traccar's own store and log carry raw coordinates, so the ADR-0027 controls extend to them:

- [ ] **Nightly prune** — install the cron line from the header of `deploy/traccar-prune.sh` (runs right after the backup, so each night's dump holds the pre-prune state). It enforces the ≤90-day window on `tc_positions`/`tc_events` with plain SQL; Traccar 6.x has NO built-in retention (`database.positionsHistoryDays` no longer exists in current source), so this script is the ONLY mechanism. Run it once by hand and check the before/after counts it logs.
- [ ] **Nightly dump** — `deploy/backup.sh` now also dumps the `traccar` database (object `fleetco-traccar-<date>.sql.gz.age`); it skips with a loud NOTE until the database exists. Confirm the object lands in the bucket the morning after bring-up — an untested backup does not exist (`docs/runbook/restore-from-backup.md`).
- [ ] **Logs** — the committed log level is `warning` (no coordinate lines); stdout is capped by the compose `logging:` limits. For onboarding, raise temporarily WITHOUT editing any file:

  ```
  # env override beats deploy/traccar.xml (CONFIG_USE_ENVIRONMENT_VARIABLES)
  LOGGER_LEVEL=info docker compose -f docker-compose.prod.yml up -d traccar   # raise
  docker compose -f docker-compose.prod.yml logs -f traccar                   # watch "id: <imei> ... lat ... lon" lines
  docker compose -f docker-compose.prod.yml up -d traccar                     # revert (re-reads the XML default)
  ```

  The INFO lines are Tier 5 — revert as soon as onboarding is done; the json-file caps bound the exposure either way.

## What can go wrong

- **Device online in Traccar, nothing in FleetCo** → the second registry is missing or inert: no `/trackers` row for the IMEI, or the row is not `ACTIVE`, or no vehicle is assigned. The API warn log names the drop reason (`unknown-device`) and the IMEI.
- **Nothing in Traccar at all** → APN wrong for the carrier, device configured for UDP (must be TCP — `2006:0`), firewall not passing 5027, or the IMEI was never registered (registerUnknown is off; Traccar drops silently by design). `  getstatus` by SMS shows the device's own link state.
- **API answers 503 on the forward** → `INGEST_API_KEY` unset on the api side (fails closed). **401** → the key in `FORWARD_HEADER` and the api's differ, or the env value grew a stray newline/space (the header line is parsed as `Name: value` — regenerate cleanly).
- **Forward retries exhausted during a long API outage** → those positions are dropped from forwarding but retained in the `traccar` database; the reconciliation/backfill job is a named tech-debt entry (`docs/tech-debt.md`) — until it exists, a gap after an outage longer than ~17 minutes is expected and the data is manually recoverable from `tc_positions`.
- **First boot loops on migration errors** → the `traccar` role does not own the database (the Liquibase CREATEs fail on PG15+'s public-schema default). Re-run the §Database creation snippet — the `ALTER DATABASE ... OWNER` line repairs ownership.
- **The TimescaleDB trap (future-proofing)**: Traccar's schema 6.8+ converts `tc_positions`/`tc_events` to hypertables IF the `timescaledb` extension is available in postgres. On `postgis/postgis:16-3.5` it is absent, so the changeset is skipped (`MARK_RAN`) and plain tables remain. Never swap the postgres image for a timescale-bundling one without re-reading this — the next Traccar boot would repartition the gateway store.
- **Gateway version bumps**: the image is pinned to a full `x.y.z` tag because the M5 adapter's contract test (`apps/api/test/traccar-ingest.test.ts`) pins the `{position, device}` forward payload. Bump the tag only after re-running that test against the new version's payload (ADR-0042 "Revisit when").

## Last verified

Never — **DRAFT**, written from ADR-0042 M6 ahead of the first gateway bring-up (which itself waits on the first production deploy, ticket M1). Promote after the first end-to-end device → `/map` position.
