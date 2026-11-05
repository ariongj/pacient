# GitHub Pages frontend + VPS API

This is a controlled pilot, not an approved clinical production system. Do not enter real patient data.
Deploy only the compiled frontend to Pages. Database contents, server settings, secrets and backend
runtime stay on the VPS. The source repository's existing visibility is not changed by this workflow.

## Routing and authentication

- Use HTTPS sibling domains for the frontend and API, e.g. `pacienti.itdks.tech` and
  `pacienti-api.itdks.tech`. The frontend remains hosted by GitHub Pages using its custom domain.
- Do not use `ariongj.github.io` with an `itdks.tech` API for this deployment: these are different
  sites and the Strict refresh cookie will not work. Do not relax the cookie to solve this.
- Set `VITE_API_BASE_URL` at build time. Credentialed fetch, SSE and CORS support separate origins.
- `WEB_APP_URL` is the frontend's full HTTPS URL; `CORS_ORIGINS` is its exact origin.
- The public artifact includes a GitHub Pages `404.html` fallback for direct SPA links. Those
  deep links render the application but retain GitHub's HTTP 404 status.
- Source maps are disabled. `prepare-pages.mjs` restricts artifact file types and checks for
  common secret/source-map markers; this is not a substitute for a complete secret scan.

## Isolated verification on the VPS

Run from `/home/codex/Pacienti`:

```sh
VERIFY_UID=$(id -u) VERIFY_GID=$(id -g) docker compose -f deploy/compose.verify.yml up --abort-on-container-exit --exit-code-from verify
docker compose -f deploy/compose.verify.yml down
```

The test PostgreSQL database is temporary, has no published port and is separate from every app.
Tests recreate only its schema. Never point these tests at a production database.

## VPS deployment

Check port 18840 and existing service state before deploying. Do not start the root development
Compose file: use this isolated deployment instead.

```sh
python3 deploy/init-env.py --web-url https://pacienti.itdks.tech
docker compose --env-file .env.vps -f deploy/compose.vps.yml build migrate
docker compose --env-file .env.vps -f deploy/compose.vps.yml up -d
curl --fail http://127.0.0.1:18840/health/ready
```

`init-env.py` creates fresh private secrets with permissions 0600 and refuses to replace an
existing file. Do not print, commit, upload or include `.env.vps` in a public package. Keep a
separately protected recovery copy of the database password, JWT secret and MFA encryption key.

The API initially binds only to localhost. PostgreSQL is on an internal Docker network and has
no host port. Resource limits and log rotation apply only to Pacienti's new services. After
the approved API DNS record resolves, add a dedicated HTTPS route to the existing proxy using
its verified network path, validate it, and perform a graceful reload (not a service restart).
Preserve all existing routes and keep a protected copy of the prior proxy configuration.

Create the first Ministry account only for the owner's confirmed email and with a private
activation handoff. Do not seed the published development passwords or disable staff MFA.
The included `dist/ops/bootstrap-admin.js EMAIL PRIVATE_OUTPUT_PATH` command refuses if any
account already exists, creates a single-use 72-hour invitation, and writes its URL only to a
new 0600 file. Run it inside the API image with a temporary private bind mount; do not expose
that directory through HTTP. The owner chooses their password through the activation page.
Email delivery (activation, password reset and notification emails) uses an SMTP relay: add
`SMTP_URL` (e.g. `smtps://user:password@smtp.example.org:465`) and `EMAIL_FROM` to `.env.vps`,
keeping the credentials as private as the other secrets. Without `SMTP_URL` the API starts but holds
all email in its outbox (visible to the Ministry under email delivery health) and delivers it once SMTP
is configured; activation links expire after 72 hours, so issue new invitations if delivery was
delayed. Emails never contain clinical information.

## Pages deployment

Only after the API is reachable over trusted HTTPS and CORS/session behavior is verified:

1. Enable GitHub Pages with GitHub Actions as the publishing source.
2. Set repository variables `PACIENTI_API_BASE_URL` (HTTPS URL ending `/api/v1`) and
   `PACIENTI_WEB_DOMAIN` (approved frontend hostname).
3. Set the DNS CNAME for that hostname to `ariongj.github.io` and configure the Pages custom domain.
4. Set `PACIENTI_DEPLOY_ENABLED=true` and run **Pacient frontend**.
5. Verify HTTPS, login, MFA, session restoration, role boundaries, SSE, direct-route reload,
   exports, logout and mobile layout on the actual frontend domain.

The workflow is deliberately disabled until the enable variable is set. It publishes only
`apps/web/dist`, never the repository root, API code or operational configuration.

## Recovery and rollback

Before a later database migration, take a consistent `pg_dump` and verify a restore in an
isolated test database; also preserve the exact image/commit and private configuration. Database
volume `pacienti_pacienti-db` is persistent. Never use `docker compose down -v` on this deployment.
Reverting an image does not revert a database migration. Do not assume the server's existing
backup job includes this new PostgreSQL service until that coverage and off-server restore are
explicitly verified; no backup schedule is changed by this deployment preparation. Use
`deploy/backup.sh` and `deploy/restore-verify.sh` (below) for both.

## Backups and restore verification

`deploy/backup.sh` takes a consistent `pg_dump` (custom format, one snapshot, safe while the API
runs), encrypts it with [age](https://age-encryption.org) to a public key, writes a SHA-256
checksum and deletes dumps older than `BACKUP_RETENTION_DAYS` (default 14). It refuses to write an
unencrypted dump of health data. Keep the private key off the server, so a compromised server
cannot read old backups.

```bash
age-keygen -o backup-key.txt        # on an offline/admin machine; keep it safe
PACIENT_COMPOSE=deploy/compose.vps.yml BACKUP_DIR=/var/backups/pacient \
  BACKUP_AGE_RECIPIENT=age1… deploy/backup.sh
```

Schedule it (for example a nightly systemd timer or cron entry) and copy the files off-server. The
script exits non-zero on any failure so the scheduler can alert.

`deploy/restore-verify.sh` proves a backup is usable: it checks the checksum, decrypts, restores
into a throw-away database, checks the migration history, row counts of key tables and that the
audit log is still append-only, prints the recovery point (newest audit entry) and drops the
scratch database. Run it on a separate verification server at least monthly and after every
schema migration:

```bash
ADMIN_DATABASE_URL=postgres://postgres@verify-host/postgres BACKUP_AGE_IDENTITY=backup-key.txt \
  deploy/restore-verify.sh /var/backups/pacient/pacient-20261102T020000Z.dump.age
```

## Radiology images (PACS)

Pacient shows radiology images through an authorised proxy: browsers only talk to the Pacient
API, which checks the same access rules as for the report (care team, radiology unit, patient only
after release), audits each viewing session and fetches images from the archive over DICOMweb
(QIDO-RS search, WADO-RS `/rendered`). The archive address and credentials never reach a browser.

| Variable            | Meaning                                                                             |
| ------------------- | ----------------------------------------------------------------------------------- |
| `PACS_MODE`         | `dicomweb` (real archive), `off`, or `demo` (synthetic images, never in production) |
| `PACS_DICOMWEB_URL` | DICOMweb root, e.g. `http://orthanc:8042/dicom-web`                                 |
| `PACS_AUTH_HEADER`  | Optional `Authorization` value for the archive, e.g. `Basic …`                      |
| `PACS_TIMEOUT_MS`   | Request timeout (default 8000)                                                      |

Connecting Orthanc: enable its DICOMweb plugin, make sure modalities send studies with the
**accession number** of the Pacient order (the `IMG…` number, from the modality worklist or
entered at the scanner), then radiology staff press _Link images → Find by accession number_ (or
paste the Study Instance UID). Keep the archive on a private network reachable only by the API.
The viewer is for review; diagnosis belongs on a certified diagnostic workstation.

## Object storage for documents

By default document contents are stored encrypted in PostgreSQL. At national scale (scanned
letters, photos, signed forms) set `STORAGE_BACKEND=s3` to keep them in S3-compatible object
storage instead – a national/managed S3 service, Ceph RGW or MinIO. The API encrypts every file
(AES-256-GCM, key derived from `MFA_ENCRYPTION_KEY`) **before** upload, so the object store only
ever holds ciphertext, and object keys carry no patient identifiers
(`documents/<yyyy>/<mm>/<document id>`). Every read is checked against the hash taken at upload, so
a swapped, truncated or altered object is never served. Documents already in the database keep
working; both backends coexist.

| Variable                       | Meaning                                                                   |
| ------------------------------ | ------------------------------------------------------------------------- |
| `STORAGE_BACKEND`              | `db` (default) or `s3` – where **new** documents go                       |
| `STORAGE_S3_ENDPOINT`          | e.g. `https://s3.eu-central-1.amazonaws.com`; must be https in production |
| `STORAGE_S3_REGION`            | Signing region (default `us-east-1`; MinIO accepts any)                   |
| `STORAGE_S3_BUCKET`            | Bucket name                                                               |
| `STORAGE_S3_ACCESS_KEY_ID`     | Access key of a dedicated user for this bucket only                       |
| `STORAGE_S3_SECRET_ACCESS_KEY` | Its secret                                                                |
| `STORAGE_S3_FORCE_PATH_STYLE`  | `true` for MinIO/Ceph (`endpoint/bucket/key`), `false` for AWS            |
| `STORAGE_S3_SSE`               | Optional server-side encryption on top: `AES256` or `aws:kms`             |
| `STORAGE_S3_TIMEOUT_MS`        | Request timeout (default 15000)                                           |

Requests are signed with AWS Signature Version 4 including the payload hash (never
`UNSIGNED-PAYLOAD`). The API only needs `s3:PutObject`, `s3:GetObject` and `s3:HeadObject` (no
delete, no list) on `arn:aws:s3:::<bucket>/documents/*`.

**Bucket policy** (documents are part of the legal record and are never deleted):

- Private: block all public access; no anonymous or cross-account access; TLS only
  (`aws:SecureTransport`).
- **Versioning on**, so an overwrite or deletion by mistake can be undone; optionally
  **Object Lock** (compliance mode) for the retention period of medical records.
- **No lifecycle rule that expires or deletes objects**; transitions to a colder storage class
  are fine.
- Encryption at rest on the storage side as well (SSE-S3/SSE-KMS, or encrypted disks for MinIO),
  and replication or backups to a second site – the nightly `pg_dump` does **not** include
  object-stored documents.

Self-hosted MinIO: `deploy/compose.storage.yml` adds a MinIO service on an internal network
(TLS certificates in `deploy/minio-certs/`); for development uncomment the MinIO block in
`docker-compose.dev.yml`. Create the bucket with versioning (`mc mb`, `mc version enable`).

**Moving existing documents** (safe to stop and re-run; database copies are kept by default):

```bash
npm run documents:migrate-to-s3 -w apps/api -- --dry-run
npm run documents:migrate-to-s3 -w apps/api
npm run documents:migrate-to-s3 -w apps/api -- --delete-db-copies
```

Each document is uploaded, read back and verified (same ciphertext, decrypts to the recorded hash)
before its row is switched to S3; `--delete-db-copies` removes database copies only after the same
verification. In containers run `node dist/db/migrate-documents-to-s3.js` in the API image.

## SMS and laboratory connections

SMS alerts use Twilio when `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` and `SMS_FROM` are set;
otherwise the API starts and keeps texts in its outbox (visible to the Ministry under operations).
Laboratory systems connect over HTTPS to `/api/v1/integrations/lab` with an API key that the
facility director creates under **Lab connections**; no inbound connection into the laboratory
network is needed.

## Downtime and point-in-time recovery

Two layers keep care going and data recoverable when the system is unavailable (hazard H42 in
`docs/CLINICAL-SAFETY.md`; procedures for staff in `docs/DOWNTIME.md`).

**Downtime packs.** Every hour the API writes, per facility, a self-contained printable HTML
document (ward lists with beds, identifiers, allergies, medicines due in the next 12 hours, last
observations and early-warning score, diet/nil by mouth, blood group; ED board; today's theatre
list and outpatient appointments). Packs are encrypted at rest and the last 48 are kept.

| Variable                 | Meaning                                                                                         |
| ------------------------ | ----------------------------------------------------------------------------------------------- |
| `DOWNTIME_DIR`           | Pack directory (default `./downtime-packs`). The vps api container is read-only: mount a volume |
| `DOWNTIME_AGE_RECIPIENT` | Optional `age1…` public key(s), comma-separated: also writes `.html.age` for offline ward PCs   |
| `DOWNTIME_SYNC_KEYS`     | `<facility code>:<sha256>` pairs for the ward PCs' sync keys (only hashes on the server)        |
| `DOWNTIME_WORKER`        | `false` disables the hourly generation in this process (e.g. on a second replica)               |

The `.html.enc` copy is sealed with AES-256-GCM under a key derived from `MFA_ENCRYPTION_KEY` and
can only be opened through the API (staff download, audited). The `.html.age` copy can only be
opened with the private key on the ward PC; the server never has it. The api image needs the `age`
binary for that copy (without it, only the AES copy is written and an error is logged).

Ward downtime PC, set up once per ward (a locked-down, disk-encrypted facility computer):

```bash
age-keygen -o /etc/pacient/downtime-identity.txt     # on the ward PC; note the public key
node scripts/downtime-sync.mjs new-key KOS-UCCK      # prints the PC's key and the server entry
```

Put the public key in `DOWNTIME_AGE_RECIPIENT` and the printed `KOS-UCCK:<sha256>` entry in
`DOWNTIME_SYNC_KEYS` on the server; store the `dts_…` key in a file readable only by the sync
account on the PC. Then schedule the sync hourly (cron or Task Scheduler) and monitor freshness:

```bash
PACIENT_URL=https://api.pacient.example DOWNTIME_SYNC_KEY_FILE=/etc/pacient/sync.key \
  DOWNTIME_OUT_DIR=/var/lib/pacient-downtime node scripts/downtime-sync.mjs sync
DOWNTIME_OUT_DIR=/var/lib/pacient-downtime node scripts/downtime-sync.mjs check --max-age-minutes 90
```

During an outage: `node scripts/downtime-sync.mjs open --identity /etc/pacient/downtime-identity.txt`
decrypts the newest pack, checks it against the server's SHA-256 and prints the file to open and
print. A sync key can fetch nothing but its own facility's latest encrypted pack; revoke one by
removing its entry. `DOWNTIME_AGE_RECIPIENT` takes several comma-separated public keys, so
each ward PC can keep its own identity; remove a PC's key when it is decommissioned (packs written
from then on are no longer readable with it).

**Point-in-time recovery (PITR).** The nightly `pg_dump` (`deploy/backup.sh`) can only go back to
the last dump. For recovery to any moment – for example just before a faulty import or an
accidental bulk change – enable continuous WAL archiving with
[pgBackRest](https://pgbackrest.org) through the optional override `deploy/compose.pitr.yml`:

- `deploy/pitr/Dockerfile.postgres`: the stock `postgres:16-alpine` plus pgBackRest (same data
  volume, no migration).
- `deploy/pitr/pgbackrest.conf`: encrypted repository (`aes-256-cbc`, passphrase in
  `PGBACKREST_REPO1_CIPHER_PASS`), two full backups retained, zstd compression, asynchronous
  archiving with a bounded queue; an off-site S3 repository is prepared as `repo2` (commented).
- `archive_timeout=60`: recovery point objective about **1 minute**. Recovery time objective with
  a local repository: roughly 15–60 minutes depending on database size and WAL since the last
  backup – measure it in the rehearsal.

```bash
export PGBACKREST_REPO1_CIPHER_PASS=…   # from the password manager; keep a copy off the server
docker compose -f deploy/compose.vps.yml -f deploy/compose.pitr.yml up -d --build db
deploy/pitr/pitr.sh init                 # stanza, archive check, first full backup
```

Schedule on the host (UTC):

```
15 1 * * 0    deploy/pitr/pitr.sh backup full
15 1 * * 1-6  deploy/pitr/pitr.sh backup diff
*/30 * * * *  deploy/pitr/pitr.sh check      # alerts if WAL archiving stalls
```

Restoring:

```bash
deploy/pitr/pitr.sh info                                    # recovery window
deploy/pitr/pitr.sh verify-restore "2026-11-04 14:30:00+01" # restores a COPY and checks it
PITR_CONFIRM=RESTORE-LIVE deploy/pitr/pitr.sh restore-to-time "2026-11-04 14:30:00+01"
```

`verify-restore` never touches the live database: it restores into a scratch volume, starts it
read-only paused at the target, checks migrations, row counts and that no audit entry is newer than
the target, then removes it. Run it monthly as the restore rehearsal. `restore-to-time` first
archives the present state and takes an incremental backup (so you can go forward again), stops
api and db, does a delta restore, promotes a new timeline, takes a full backup and starts the api.
Everything after the target time is gone from the live database: declare downtime first
(Downtime kit → _Start downtime procedures_) and back-enter the paper records of that period
afterwards. Never remove the `pacienti-pgbackrest` volume.
