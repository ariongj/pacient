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

## SMS and laboratory connections

SMS alerts use Twilio when `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` and `SMS_FROM` are set;
otherwise the API starts and keeps texts in its outbox (visible to the Ministry under operations).
Laboratory systems connect over HTTPS to `/api/v1/integrations/lab` with an API key that the
facility director creates under **Lab connections**; no inbound connection into the laboratory
network is needed.
