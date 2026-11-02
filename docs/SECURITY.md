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
- Dependencies are audited in CI (`npm audit --omit=dev --audit-level=high`).

## Required before production (not yet implemented)

These are tracked in [BLUEPRINT-ALIGNMENT.md](BLUEPRINT-ALIGNMENT.md):

1. **Phishing-resistant MFA** (WebAuthn/passkeys) or a managed identity provider (OIDC); step-up
   authentication for emergency access and exports. (TOTP two-step sign-in is implemented.)
2. A real email/SMS provider for activation and reset links (`modules/notifications/notifier.ts`);
   patient identity proofing.
3. Encryption at rest (managed PostgreSQL with KMS), secrets from a secrets manager, key rotation.
4. Separate database roles (migrations vs. runtime; runtime without UPDATE/DELETE on audit tables).
5. Distributed rate limiting (Redis) when running more than one API instance.
6. Independent security review against OWASP ASVS, plus penetration testing.
7. Legal basis, retention schedule, data-residency and breach-notification procedures confirmed
   for the launch jurisdiction.

## Reporting a vulnerability

Please report security issues privately to the maintainers rather than opening a public issue.
