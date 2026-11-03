# Security & privacy

## Access model

Authorization is **default-deny and contextual**. Job title alone never grants access to a record.
The policy lives in one place: `apps/api/src/modules/access/policy.ts`.

| Role       | Identifiable clinical record                                                                                | Demographics                       | Aggregates                      |
| ---------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------- | ------------------------------- |
| Patient    | Own record, read-only; only **released** results and **signed** notes                                       | Own                                | –                               |
| Doctor     | Active care relationship, or emergency access **within the same facility**                                  | Own facility, own care team        | –                               |
| Nurse      | Care team: read; record vitals, reported allergies, vaccinations, medication administration                 | Own facility, own care team        | –                               |
| Pharmacist | Never in full – medication context of prescriptions in the facility queue (audited, visible to the patient) | Via the queue only                 | –                               |
| Reception  | Never                                                                                                       | Own facility's registered patients | –                               |
| Director   | Never                                                                                                       | Own facility's registered patients | Own facility                    |
| Ministry   | Never                                                                                                       | Never                              | National, small-cell suppressed |

- **Institution boundaries.** Patient search, care-team assignment and emergency access never cross
  facilities. A national ID match at another facility is not disclosed.
- **Emergency ("break-glass") access.** Doctors only; mandatory free-text reason (≥ 10 chars);
  expires after 4 hours; written to the audit trail; surfaced on the director's dashboard and audit
  review; visible to the patient with the stated reason.
- **Chain of command for accounts.** The Ministry appoints directors and Ministry officials;
  directors onboard doctors for their own facility only (a facility in the request body is
  ignored). Nobody can grant themselves a role, and nobody can deactivate their own account.
- **Patients never edit clinical content.** They submit correction requests that a clinician reviews.
- **Referrals are the only cross-institution path.** A pending referral shares only the written
  summary and minimal demographics with the receiving facility; accepting it creates a care
  relationship for one named doctor. Creation, acceptance, decline and completion are audited and
  visible to the patient.
- **Emergency access is reviewed.** Directors are notified and must record an outcome
  (appropriate / inappropriate / needs follow-up) for every event, seeing how many reads and changes
  the doctor made during the access window. The Ministry sees review compliance per facility, never
  the patients involved.
- **Messaging** is only possible within an active care relationship and is part of the audit trail.
- **Medication safety:** prescriber, pharmacist and nurse duties are separate. Nurses can only
  record administration against pharmacy-verified prescriptions; every dose given, withheld,
  refused or omitted is recorded with author and reason in an append-only table. Pharmacy safety
  alerts (allergy, class cross-reactivity, duplicate therapy) are decision support: verifying a
  flagged prescription requires an explicit review note. A validated drug-interaction database must
  be integrated before production.
- **Team channels** are scoped by facility and role; national channels connect the Ministry with
  directors. Channel posts are audited, and the UI reminds staff not to post patient identifiers.
- **Live updates** use single-use 30-second tickets instead of putting access tokens in URLs.
- **Guardian (proxy) access** follows the blueprint's proxy rules: one verified guardianship per
  child and guardian (no household-wide sharing), recorded with relationship, scope (full record or
  appointments only), the evidence checked and who checked it. For minors it ends automatically at
  the 18th birthday; adults can only have a court-appointed legal guardian with an end date of at
  most five years. Staff accounts can never be guardians. The `X-Acting-For` header is re-verified
  against the database on every request, so revocation and expiry are immediate. Guardian reads use
  their own audited access basis (`GUARDIAN`) and appear in the child's access log. Visits marked
  _confidential from guardians_ — and everything recorded during them — are excluded from the
  guardian view, FHIR export and guardian notifications; a young person's own messages stay private.
- **Email**: messages are queued in the same transaction as the change (transactional outbox),
  encrypted at rest with the same AES-256-GCM key as MFA secrets, and erased after delivery or after
  the final failed attempt. Workers claim messages with `FOR UPDATE SKIP LOCKED` (no duplicates across
  instances) and retry with exponential backoff. Emails never contain clinical information; nodemailer
  is configured with file and URL access disabled. Without `SMTP_URL`, production holds email in the
  outbox instead of sending it anywhere.

## Authentication

- Passwords: argon2id (OWASP parameters), 12–128 characters, common/repetitive passwords rejected
  (NIST SP 800-63B style: length over composition rules).
- Invitations: accounts are created without a password; a single-use activation token (256-bit,
  stored as SHA-256, 72 h expiry) lets the person choose their own. Administrators never know user
  passwords. Outside production the link is returned to the inviter for convenience; in production
  it must be delivered through the notifier (`modules/notifications/notifier.ts`).
- Login: generic error for unknown user / wrong password / locked account; timing equalised with a
  dummy hash; lockout for 15 minutes after 5 failures; per-IP rate limit on credential endpoints.
- Rate limits are **per user** for authenticated traffic (600 requests/min) because hospital
  networks usually share one public IP; anonymous and credential endpoints fall back to per-IP
  limits sized for a facility behind NAT (100 failed sign-ins / 15 min), with per-account lockout
  stopping targeted guessing.
- **Two-step sign-in (TOTP, RFC 6238)** with any standard authenticator app. Secrets are stored
  encrypted with AES-256-GCM using `MFA_ENCRYPTION_KEY` (kept outside the database); codes cannot be
  replayed (last accepted time-step is recorded); 10 single-use recovery codes are stored as hashes.
  Wrong codes count toward account lockout. With `REQUIRE_STAFF_MFA=true` (the production default)
  staff cannot reach any workspace endpoint until they enrol, and cannot switch it off. The
  password step returns only a 5-minute challenge token; no session exists until the second factor
  succeeds.
- **Passkeys (WebAuthn)** – phishing-resistant sign-in bound to the Pacient domain
  (`WEBAUTHN_RP_ID`, allowed origins `WEBAUTHN_ORIGINS`). A passkey with user verification is a
  complete sign-in on its own, or the second step after the password; it satisfies the staff
  two-step requirement (`users.mfa_enabled_at` means "two-step on with an app, passkeys or both").
  Challenges are stored server-side, expire after 5 minutes and work once; the signature counter
  must increase (a regression is refused as a possible cloned authenticator). Only the public key
  is stored. Adding or removing a passkey requires a sign-in within the last 10 minutes or the
  password; staff cannot remove their last second factor. Passkey sign-in uses discoverable
  credentials, so the server never reveals whether an email address has passkeys.
- **Active sessions**: every refresh-token family is a signed-in device; users see device (browser
  and system), masked network (`192.168.1.x`), start and last use, and can sign out one device or
  all other devices. A signed-out device keeps its in-memory access token for at most 15 minutes.
- **Sign-in history**: users see their own sign-ins, failures, lockouts and security changes of the
  last 90 days (from the audit trail) with masked network.
- **New-device alerts**: a successful sign-in from a browser/system/network combination the user
  has not used before (not the account's first device) sends an important notification and email
  with device and masked network – never health information.
- **Password reset** via a single-use, hashed, 1-hour token; the response never reveals whether an
  account exists; completing a reset ends every session.
- Sessions: short-lived access JWT (15 min, HS256, issuer/audience checked) held **in memory** by
  the web app; opaque refresh token in an `httpOnly`, `SameSite=Strict`, `Secure` (production)
  cookie scoped to `/api/v1/auth`, stored server-side as a SHA-256 hash.
- **Refresh-token rotation with reuse detection**: every refresh consumes the token; presenting a
  consumed token revokes the entire token family. Logout and password change revoke sessions.
- Every authenticated request re-checks the account in the database, so deactivation takes effect
  immediately.

## Audit trail

- Written for logins (success, failure, lockout), token reuse, account changes, facility changes,
  patient registration, searches (without the search term), every read of a clinical record
  (with section and access basis), **denied** record access, exports, every clinical change, note
  signing/addenda, result acknowledgement/release, emergency access, correction requests and
  appointments.
- Clinical changes and their audit records commit in the same transaction.
- The table is **append-only at the database level** (triggers block UPDATE/DELETE/TRUNCATE). For
  production, also run the API with a database role that has only `INSERT`/`SELECT` on
  `audit_logs`, and ship the log to write-once storage.
- Patients see an "accessed by" view of their own trail (without IP addresses or internal metadata).

## Data protection

- `Cache-Control: no-store` on every API response; nginx sends a strict CSP (no inline scripts, no
  third-party origins), `frame-ancestors 'none'`, `nosniff`, `no-referrer`.
- Logs redact authorization headers, cookies, passwords and tokens; request logs record the path
  only (never query strings, which can contain names). Clinical content is never logged.
- Aggregate statistics suppress counts below 5 for diagnoses to reduce re-identification risk.
- The web app clears all cached data on sign-out.
- Record export (right of access / portability) and every report CSV export are audited. CSV cells
  are protected against spreadsheet formula injection.
- Notifications are deliberately generic ("A new test result is available") so they reveal no
  clinical detail on lock screens or if later forwarded by email/SMS.
- Input validation on every endpoint (Zod), size limits on bodies and fields, parameterised SQL only.
- SMS texts contain no health information, only that something needs attention. Numbers are used
  only after the owner enters a code sent to them (10-minute expiry, 5 attempts, 3 codes per hour)
  and are shown masked. Non-urgent texts wait for the end of quiet hours.
- Laboratory systems authenticate with per-system API keys (shown once, stored as SHA-256 hashes,
  revocable, scoped to one facility; staff tokens are not accepted and vice versa). Results are
  filed only when the order number, national ID and date of birth match; otherwise the message is
  held for a director, who sees only the identifiers needed to decide. Raw messages are stored
  sealed (AES-256-GCM) for audit and are never returned by the API.
- Documents: only PDF/JPEG/PNG whose content matches the declared type, 10 MiB limit, optional
  ClamAV scan (an unreachable scanner refuses the upload rather than storing it unscanned), content
  encrypted with AES-256-GCM under a purpose-specific key, SHA-256 verified on every read, served
  with `nosniff` and a sandboxing CSP, every opening audited and shown in the patient's access log.
- Consent history is append-only (database trigger). Withdrawn cross-facility sharing blocks
  referrals to other facilities until renewed agreement is recorded; emergency access within the
  facility is unaffected (vital interests) and remains reviewed.
- Result cover grants care-team access only during the cover window, only for the absent doctor's
  care-team patients, and is audited (`via: COVER`). Escalations to directors carry no patient
  identity or values.
- Unit-based access: staff assigned to a ward, the emergency department, radiology or maternity
  may open a record only while the patient is in that unit (admitted, open ED attendance or
  <24 h after it, imaging order not yet reported, newborn <28 days); audited with `via: UNIT`.
  Reception and directors see bed and board data without clinical reasons or triage notes.
- Signed discharge summaries and signed imaging reports are immutable (database triggers).
- Partner API keys are scoped, hashed, revocable and rate limited, optionally IP-restricted;
  record access requires a declared purpose of use, is refused when the patient withdrew
  cross-facility sharing, returns content limited to the purpose, and every call (also refused
  ones) is audited and shown in the patient's access log under the organisation's name. External
  systems never get database credentials.
- Patient merges are director-only, limited to records registered at the director's facility,
  require a reason, show demographics and counts only (no clinical content), are audited for both
  records and can be undone exactly. Both records having portal accounts blocks the merge.
- Backups are encrypted to an offline age key before they leave `pg_dump`; the backup script refuses
  to write unencrypted dumps, and restores are verified in a throw-away database.
- Dependencies are audited in CI (`npm audit --omit=dev --audit-level=high`).

## Required before production (not yet implemented)

These are tracked in [BLUEPRINT-ALIGNMENT.md](BLUEPRINT-ALIGNMENT.md):

1. A managed identity provider (OIDC) for staff, and step-up authentication for emergency access
   and exports. (TOTP two-step sign-in and phishing-resistant passkeys are implemented.)
2. Production email (SMTP relay with SPF/DKIM/DMARC) and SMS provider accounts; patient identity
   proofing.
3. Encryption at rest (managed PostgreSQL with KMS), secrets from a secrets manager, key rotation.
4. Separate database roles (migrations vs. runtime; runtime without UPDATE/DELETE on audit tables).
5. Distributed rate limiting (Redis) when running more than one API instance.
6. Independent security review against OWASP ASVS, plus penetration testing.
7. Legal basis, retention schedule, data-residency and breach-notification procedures confirmed
   for the launch jurisdiction.

## Reporting a vulnerability

Please report security issues privately to the maintainers rather than opening a public issue.
