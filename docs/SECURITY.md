# Security & privacy

## Access model

Authorization is **default-deny and contextual**. Job title alone never grants access to a record.
The policy lives in one place: `apps/api/src/modules/access/policy.ts`.

| Role     | Identifiable clinical record                                               | Demographics                       | Aggregates                      |
| -------- | -------------------------------------------------------------------------- | ---------------------------------- | ------------------------------- |
| Patient  | Own record, read-only; only **released** results and **signed** notes      | Own                                | –                               |
| Doctor   | Active care relationship, or emergency access **within the same facility** | Own facility, own care team        | –                               |
| Director | Never                                                                      | Own facility's registered patients | Own facility                    |
| Ministry | Never                                                                      | Never                              | National, small-cell suppressed |

- **Institution boundaries.** Patient search, care-team assignment and emergency access never cross
  facilities. A national ID match at another facility is not disclosed.
- **Emergency ("break-glass") access.** Doctors only; mandatory free-text reason (≥ 10 chars);
  expires after 4 hours; written to the audit trail; surfaced on the director's dashboard and audit
  review; visible to the patient with the stated reason.
- **Chain of command for accounts.** The Ministry appoints directors and Ministry officials;
  directors onboard doctors for their own facility only (a facility in the request body is
  ignored). Nobody can grant themselves a role, and nobody can deactivate their own account.
- **Patients never edit clinical content.** They submit correction requests that a clinician reviews.

## Authentication

- Passwords: argon2id (OWASP parameters), 12–128 characters, common/repetitive passwords rejected
  (NIST SP 800-63B style: length over composition rules).
- Invitations: accounts are created without a password; a single-use activation token (256-bit,
  stored as SHA-256, 72 h expiry) lets the person choose their own. Administrators never know user
  passwords. Outside production the link is returned to the inviter for convenience; in production
  it must be delivered through the notifier (`modules/notifications/notifier.ts`).
- Login: generic error for unknown user / wrong password / locked account; timing equalised with a
  dummy hash; lockout for 15 minutes after 5 failures; per-IP rate limit on credential endpoints.
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
- Record export (right of access / portability) is audited.
- Input validation on every endpoint (Zod), size limits on bodies and fields, parameterised SQL only.
- Dependencies are audited in CI (`npm audit --omit=dev --audit-level=high`).

## Required before production (not yet implemented)

These are tracked in [BLUEPRINT-ALIGNMENT.md](BLUEPRINT-ALIGNMENT.md):

1. **MFA for all staff** (phishing-resistant where practical) — ideally via a managed identity
   provider (OIDC). Step-up authentication for emergency access and exports.
2. Email/SMS delivery of activation links; password-reset flow; patient identity proofing.
3. Encryption at rest (managed PostgreSQL with KMS), secrets from a secrets manager, key rotation.
4. Separate database roles (migrations vs. runtime; runtime without UPDATE/DELETE on audit tables).
5. Distributed rate limiting (Redis) when running more than one API instance.
6. Independent security review against OWASP ASVS, plus penetration testing.
7. Legal basis, retention schedule, data-residency and breach-notification procedures confirmed
   for the launch jurisdiction.

## Reporting a vulnerability

Please report security issues privately to the maintainers rather than opening a public issue.
