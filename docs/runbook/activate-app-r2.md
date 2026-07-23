# activate-app-r2

> **STATUS: ACTIVE.** First draft, written when the fleet-documents program (ADR-0049) made in-app R2 object storage a live operator step. The one-command path (`deploy/setup-app-r2.sh`) is committed and shellcheck-clean; its `Last verified` line stays empty until the first real activation on the box runs it end-to-end.

## When this procedure applies

The API stores invoice PDFs (ADR-0039), fleet documents (ADR-0049), and agent attachments (ADR-0044) in Cloudflare R2 through the `ObjectStorage` seam. It binds the **real** R2 store only when all four `R2_*` vars are set in `/opt/fleetco/.env`; while any is blank it runs the no-network `MockObjectStorage` — bytes do not survive a container restart and invoice `issue()` returns 422. This procedure sets the four vars so object storage is real and persistent. It is a post-deploy activation step (the box, the domain, and the backup R2 already exist).

## What you need first

Cloudflare **R2 S3 API credentials** — an **Access Key ID + Secret Access Key** and the S3 endpoint. The app talks to R2 over the S3 API, which is a different credential from the rclone remote the backups use, so either:

- **Reuse the backup's S3 credentials** if it uses them (check `~/.config/rclone/rclone.conf` and `/opt/fleetco/deploy/backup.env` on the box for an `access_key_id` / `secret_access_key`), or
- **Mint an app-scoped token** in the Cloudflare dashboard → **R2 → Manage R2 API Tokens → Create API Token**, permission **Object Read & Write**, scoped to the `fleetco-backups` bucket. A distinct app token limits blast radius — a leaked app key then cannot read or delete the encrypted backups (your disaster-recovery lifeline).

The endpoint is `https://<account-id>.r2.cloudflarestorage.com` (no bucket in the path). The Secret Access Key is a **Tier-1 credential** (ADR-0013): it goes Cloudflare → the box directly, entered by the operator into a silent prompt — never pasted into chat, a ticket, or a command line.

## The shared bucket (why `R2_BUCKET = fleetco-backups`)

The app shares the single R2 backup bucket rather than taking a second one (ADR-0014 §6 shared-bucket annotation, PO decision 2026-07-23). The app writes only under the `invoices/`, `documents/`, and `agent-attachments/` key **prefixes**; the backups sit at the bucket **root** as `fleetco-<date>.sql.gz.age`. The nightly retention prune in `deploy/backup.sh` is filename-scoped (`--include "/fleetco-*.sql.gz.age"`) so it can never delete an app object. Set `R2_BUCKET` to the same value the backup uses.

## Procedure — one command (recommended)

On the box, as root (so it can read/write the `chmod 600` `.env`):

```bash
sudo bash /opt/fleetco/deploy/setup-app-r2.sh
```

It prompts for the four values (the secret hidden), backs up `.env`, writes the vars idempotently (mode 600), recreates the api container (postgres/redis/web untouched — no image rebuild; the R2 vars are server-side runtime config), and prints the verification. Pass `R2_NO_RESTART=1` to write `.env` but recreate the container yourself later.

## Procedure — manual (equivalent)

If you prefer to edit by hand:

```bash
sudo nano /opt/fleetco/.env          # set the four vars below (do NOT use a piped heredoc — the no-TTY empty-value trap)
```
```
R2_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
R2_ACCESS_KEY_ID=<access key id>
R2_SECRET_ACCESS_KEY=<secret access key>
R2_BUCKET=fleetco-backups
```
```bash
cd /opt/fleetco && docker compose -f docker-compose.prod.yml up -d api
```

Any one of the four left blank silently keeps the mock store — double-check none is empty.

## Verify it is real R2, not the mock

The definitive check is restart persistence (the mock loses bytes on restart; R2 does not):

1. In the web app, upload a document on any vehicle/driver/customer, then click **Open** — it should stream back.
2. Confirm the object landed in R2 (uses your working backup rclone remote): `rclone lsf r2:fleetco-backups/documents/`.
3. Recreate the api once more (`docker compose -f docker-compose.prod.yml up -d api`) and re-open the same document — if it **still** streams, it is genuinely persisted to R2.

## Then: the shared-bucket restore confirmation

With app objects now in the bucket, run one backup and confirm a fresh `fleetco-<date>.sql.gz.age` lands **and** your uploaded document is still present afterward — proving the scoped prune leaves app objects alone (ADR-0014 §6):

```bash
bash /opt/fleetco/deploy/backup.sh
```

## Related — invoices need one more variable

Documents and agent attachments work with just the four `R2_*` vars. Invoice **issue** additionally requires `INVOICE_SUPPLIER_PAN` (your company's own PAN/VAT number, accountant-verified — ADR-0039 c9) in the same `.env`, or it 422s. Set it in the same edit if you plan to issue invoices.

## Last verified

- _(not yet run on the box — fill in with the date + outcome the first time this procedure is executed in production, per the runbook README's "an untested procedure does not exist" rule)_
