# Go-live checklist

Pacient goes live in two halves: the **API and database on your server** (Docker), and the
**frontend on GitHub Pages**. Every step below was rehearsed end to end on a production-like setup
(see [What was rehearsed](#what-was-rehearsed)). This is a controlled pilot: do not enter real
patient data until the conditions in [CLINICAL-SAFETY.md](CLINICAL-SAFETY.md) are met.

**You need:** a Linux server with Docker (Compose v2), git, python3 and curl; two names on the same
domain, e.g. `pacienti.itdks.tech` (the app) and `pacienti-api.itdks.tech` (the API); admin access
to the GitHub repository; the e-mail address of the first administrator.

## 1. Server – one command

```bash
git clone https://github.com/ariongj/pacient.git Pacienti
```

```bash
cd Pacienti && git checkout claude/practical-rubin-idyxdo
```

```bash
deploy/go-live.sh --web-url https://pacienti.itdks.tech --api-url https://pacienti-api.itdks.tech
```

It checks the server, creates the private settings (`.env.vps`, fresh secrets, owner-only), builds
the API, starts PostgreSQL, applies the migrations and waits until the API is ready on
`127.0.0.1:18840`. It stops with a clear message if anything is wrong, and it never replaces
`.env.vps` or deletes data, so it is safe to run again.

**Keep a protected copy of `.env.vps` off the server** (password manager): without it the database
and the two-step sign-in secrets cannot be recovered.

## 2. HTTPS for the API

1. DNS: an `A` record for `pacienti-api` pointing to the server.
2. Route it to the API with your web server – ready-made examples, tested with the rehearsal:
   - nginx: [`deploy/proxy/nginx-pacienti-api.conf`](../deploy/proxy/nginx-pacienti-api.conf)
     (certificate with `certbot`), or
   - Caddy: [`deploy/proxy/Caddyfile`](../deploy/proxy/Caddyfile) (certificate automatic).

Both keep live updates flowing, allow 10 MB documents and keep `/metrics` private. Reload, do not
restart, a proxy that serves other sites.

## 3. First administrator

```bash
deploy/first-admin.sh owner@example.org
```

The single-use activation link (valid 72 hours) is written only to
`~/pacienti-private/invite.txt` – never printed or e-mailed. Open it, choose a password, set up
two-step sign-in with an authenticator app and store the recovery codes. Then delete the file.
The administrator adds facilities and staff from the Ministry workspace.

## 4. Frontend on GitHub Pages

In the repository on GitHub:

1. **Settings › Pages** › Build and deployment › Source: **GitHub Actions**.
2. **Settings › Environments › github-pages** › Deployment branches and tags: add
   `claude/practical-rubin-idyxdo` (otherwise GitHub refuses the deploy).
3. **Settings › Secrets and variables › Actions › Variables**, three repository variables:

   | Name                      | Value                                    |
   | ------------------------- | ---------------------------------------- |
   | `PACIENTI_API_BASE_URL`   | `https://pacienti-api.itdks.tech/api/v1` |
   | `PACIENTI_WEB_DOMAIN`     | `pacienti.itdks.tech`                    |
   | `PACIENTI_DEPLOY_ENABLED` | `true`                                   |

4. DNS: `CNAME` record `pacienti` → `ariongj.github.io`; then **Settings › Pages** › Custom
   domain: `pacienti.itdks.tech`, and tick **Enforce HTTPS** once offered.
5. **Actions › Pacient frontend › Run workflow** on `claude/practical-rubin-idyxdo`. Later pushes to
   that branch publish automatically.

## 5. Check it

```bash
node deploy/smoke-test.mjs --web https://pacienti.itdks.tech --api https://pacienti-api.itdks.tech
```

Fourteen checks (HTTPS, CORS, security headers, sign-in and live updates through the proxy,
private metrics, the frontend built for this API, direct links, offline support, no source maps)
must end with **All checks passed**. Then sign in as the administrator, reload the page (you stay
signed in) and sign out.

## 6. Backups – the same day

1. On your own computer (not the server): `age-keygen -o backup-key.txt`. Keep this file safe; the
   server only gets the public key it prints.
2. Put the public key and paths into
   [`deploy/systemd/pacienti-backup.service`](../deploy/systemd/pacienti-backup.service) and enable
   the nightly timer (commands at the top of the file).
3. Once a month and after every upgrade, prove a backup restores on another machine:
   `deploy/restore-verify.sh` (see [deploy/README.md](../deploy/README.md#backups-and-restore-verification)).

## 7. Upgrades

```bash
git pull
```

```bash
BACKUP_AGE_RECIPIENT=age1… deploy/go-live.sh
```

With `BACKUP_AGE_RECIPIENT` set it takes an encrypted backup before applying migrations. The
frontend redeploys by itself when the branch changes.

## Optional, any time

- **E-mail** (activation, password reset, notifications): add `SMTP_URL` and `EMAIL_FROM` to
  `.env.vps`, then run `deploy/go-live.sh` again. Until then e-mail waits in the outbox.
- **SMS**, **document malware scanning**, **radiology images (PACS)**, **object storage**,
  **point-in-time recovery** and **monitoring**: see [deploy/README.md](../deploy/README.md).

## What was rehearsed

On 14 November 2026, from an empty database, with HTTPS on two sibling test domains
(`pacienti.itdks.test`, `pacienti-api.itdks.test`), nginx with the example configuration and a
static server behaving like GitHub Pages:

- `deploy/go-live.sh`: first installation, then an upgrade run with the automatic encrypted backup;
- the production frontend build passed the Pages artifact check;
- `deploy/smoke-test.mjs`: all 14 checks passed (and it fails as it should over plain HTTP);
- `deploy/first-admin.sh`: one private invitation; a second run is refused;
- in a real browser: activation, password, two-step sign-in set-up with recovery codes, the Ministry
  workspace with live updates connected through the proxy, staying signed in after a reload (sign-in
  cookie `HttpOnly`, `Secure`, `SameSite=Strict`), a directly opened page, the authenticator code
  asked at the next sign-in, and sign-out;
- the backup restored and verified with `deploy/restore-verify.sh`.

Fixed on the way: the backup and point-in-time recovery scripts did not pass `.env.vps` to Docker
Compose (the documented nightly backup would have failed), the restore check failed every new
installation for having no facilities yet, and the Pages artifact check rejected the app icons.
