# Architecture

Pacient is a **modular monolith**: one deployable API with explicit domain modules, plus a single-page
web app. Modules own their routes and data access and talk to each other through small, explicit
functions (for example the access policy), so a module can be extracted later if scale or
organisational needs justify it.

```
apps/
  api/                      Express 5 + TypeScript
    drizzle/                SQL migrations (generated + hand-written security constraints)
    src/
      config/env.ts         Zod-validated configuration; the process refuses to start if invalid
      db/                   schema.ts (single source of truth), client, migrate, seed
      lib/                  errors, logger (redacting), password (argon2id), tokens, pagination
      middleware/           request id, authentication, role gate, rate limits, error handler
      modules/
        access/policy.ts    ★ central authorization policy for patient data
        auth/               login, refresh rotation, logout, activation, change password
        audit/              append-only audit trail + review API
        facilities/         facility registry (Ministry-managed)
        staff/              invitations and account status along the chain of command
        patients/           registration, demographics, care team, emergency access
        clinical/           encounters & notes, diagnoses, prescriptions, allergies, vitals,
                            lab results (follow-up loop), correction requests, export
        appointments/       booking with role-specific state transitions and overlap checks
        portal/             patient-only features (access log, contact details)
        worklist/           doctor's outstanding follow-up
        stats/              aggregate facility and national dashboards (small-cell suppression)
        reports/            period/region reports + audited CSV export
        referrals/          cross-facility referrals (the governed sharing path)
        messaging/          patient ↔ doctor secure messages
        notifications/      in-app notifications + outbound notifier (email/SMS adapter)
        emergency/          director review of break-glass events, Ministry compliance view
        announcements/      national and facility announcements
        pharmacy/           verification & dispensing queue, medication-context view
        care-tasks/         clinician task lists with explicit ownership
        channels/           team channels (facility + national)
        events/             Server-Sent Events stream (tickets) fed by PostgreSQL LISTEN/NOTIFY
        fhir/               HL7 FHIR R4 CapabilityStatement, Patient, Patient/$everything
        directory/          same-facility clinician directory
        guardians/          guardian (proxy) access: registration, revocation, dependants
        email/              transactional email outbox, templates, SMTP/log/memory transports
    test/                   integration tests against a real PostgreSQL database
  web/                      React 19 + Vite
    src/
      api/                  fetch client (in-memory access token, single-flight refresh) + types
      auth/                 session restore, login/logout
      components/           accessible UI kit, charts, layout, route guard
      pages/{patient,doctor,director,ministry,shared}
```

## Request flow

1. `requestId` assigns a correlation id (also written to audit entries).
2. `helmet`, CORS allow-list, 200 kB JSON body limit, `Cache-Control: no-store` on all API responses.
3. `authenticate` verifies the JWT **and re-loads the account from the database**, so deactivation is
   effective immediately and role/facility always come from the source of truth, never the token.
4. `requireRole` is a coarse gate; fine-grained, contextual checks happen in
   `modules/access/policy.ts` (care relationship, institution, emergency grant, self).
5. Input is validated with Zod (`parse()`), producing uniform `400` responses.
6. Writes run in a transaction **together with their audit record** — if auditing fails, the change
   rolls back.
7. Errors are mapped to a consistent envelope `{ error: { code, message, details? } }`; database
   constraint violations become 400/409; internals are never leaked.

## Data model (main tables)

| Area          | Tables                                                                                                                                                                                               |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Organisation  | `facilities`                                                                                                                                                                                         |
| Identity      | `users` (role + facility), `refresh_tokens` (hashed, rotated), `one_time_tokens` (hashed)                                                                                                            |
| Patients      | `patients` (national ID unique, allergy assessment), `care_assignments`, `emergency_access_grants`                                                                                                   |
| Clinical      | `encounters` (draft/signed, version), `encounter_addenda`, `diagnoses` (ICD-10), `prescriptions`, `allergies` (verification + source), `vital_signs`, `lab_results` (status, acknowledged, released) |
| Patient voice | `correction_requests`                                                                                                                                                                                |
| Scheduling    | `appointments`                                                                                                                                                                                       |
| Oversight     | `audit_logs` (append-only)                                                                                                                                                                           |

Every clinical item records the patient, the author, the effective time and the recorded time.
Clinical records are never hard-deleted; they change state (resolved, cancelled, refuted,
entered-in-error) or are amended by addenda.

### Invariants enforced by the database (defence in depth)

- Staff roles must have a facility; Ministry and patient accounts must not (`CHECK`).
- Physiological ranges for vital signs (`CHECK`).
- `audit_logs` and `encounter_addenda` reject `UPDATE`, `DELETE` and `TRUNCATE` (triggers).
- A **signed** encounter note cannot be rewritten (trigger) — only addenda may be added.
- One active care assignment per doctor/patient (partial unique index).
- Case-insensitive unique email; unique national ID.

## API overview (`/api/v1`)

| Area         | Endpoints                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auth         | `POST /auth/login`, `/auth/refresh`, `/auth/logout`, `/auth/activate`, `/auth/change-password`, `GET /auth/me`                                                                                                                                                                                                                                                                                                   |
| Facilities   | `GET /facilities`, `GET /facilities/:id`, `POST` / `PATCH` (Ministry)                                                                                                                                                                                                                                                                                                                                            |
| Staff        | `GET /staff`, `POST /staff/invitations`, `PATCH /staff/:id/status`                                                                                                                                                                                                                                                                                                                                               |
| Patients     | `GET/POST /patients`, `GET/PATCH /patients/:id`, `POST /patients/:id/portal-invitation`, care team `GET/POST/DELETE /patients/:id/care-team[/:doctorId]`, `POST /patients/:id/emergency-access`                                                                                                                                                                                                                  |
| Clinical     | `GET /patients/:id/{summary,encounters,diagnoses,prescriptions,allergies,vitals,lab-results,export}`; `POST` to the same collections; `PATCH /encounters/:eid` (draft, versioned), `POST /encounters/:eid/sign`, `POST /encounters/:eid/addenda`, `POST /lab-results/:rid/{acknowledge,release}`, `PUT /allergy-assessment`, `GET/POST/PATCH /correction-requests`                                               |
| Appointments | `GET/POST /appointments`, `PATCH /appointments/:id/status`                                                                                                                                                                                                                                                                                                                                                       |
| Portal       | `GET /portal/access-log`, `PATCH /portal/contact`                                                                                                                                                                                                                                                                                                                                                                |
| Laboratory   | `GET /lab-catalog`, `GET/POST /patients/:id/lab-orders`, `POST /patients/:id/lab-orders/:oid/cancel`; LIS (API key): `GET /integrations/lab/{orders,ping}`, `POST /integrations/lab/orders/:placer/receive`, `POST /integrations/lab/results`; director: `GET/POST /integrations/clients`, `POST /integrations/clients/:id/revoke`, `GET /integrations/messages[/:id]`, `POST /integrations/messages/:id/review` |
| Documents    | `GET/POST /patients/:id/documents` (raw PDF/JPEG/PNG body), `GET /patients/:id/documents/:did/content`, `PATCH /patients/:id/documents/:did`, `POST /patients/:id/documents/:did/entered-in-error`                                                                                                                                                                                                               |
| Consent      | `GET/POST /patients/:id/consents` (referrals check cross-facility sharing consent)                                                                                                                                                                                                                                                                                                                               |
| Cover        | `GET/POST /cover`, `GET /cover/colleagues`, `POST /cover/:id/cancel`, `GET /cover/escalations` (director)                                                                                                                                                                                                                                                                                                        |
| SMS          | `POST /auth/me/phone`, `POST /auth/me/phone/verify`, `DELETE /auth/me/phone`, `PATCH /auth/me/preferences`, `GET /stats/sms` (Ministry)                                                                                                                                                                                                                                                                          |
| Worklist     | `GET /worklist` (doctor)                                                                                                                                                                                                                                                                                                                                                                                         |
| Reporting    | `GET /stats/facility`, `GET /stats/national`, `GET /audit-logs`                                                                                                                                                                                                                                                                                                                                                  |
| Health       | `GET /health/live`, `GET /health/ready`                                                                                                                                                                                                                                                                                                                                                                          |

## Testing

`npm test` drops and recreates the `pacient_test` schema **from the migrations** (so tests exercise
the real migrations and triggers), then runs integration tests through the HTTP layer. The suite
covers authentication (lockout, token rotation and reuse detection, activation), the access
matrix for every role, tenant boundaries, break-glass, clinical integrity (versioning, signing,
addenda, DB-level immutability), result follow-up, corrections, duplicate review, the staff
hierarchy, appointments, reporting scope and small-cell suppression, and audit immutability.

## Real-time updates

Notifications and channel messages are published with PostgreSQL `NOTIFY` inside the same
transaction as the change, so they are delivered only after commit. Each API process keeps one
`LISTEN` connection and fans events out to its Server-Sent-Event streams; any number of API
instances can run behind a load balancer without extra infrastructure. Event payloads carry only
identifiers – the browser re-fetches data through the authorised API. EventSource cannot send an
Authorization header, so the client first exchanges its access token for a 30-second, single-use
ticket.

## Interoperability (HL7 FHIR R4)

`/api/v1/fhir/Patient/:id/$everything` returns a searchset Bundle with Patient, Organization,
Practitioner, Encounter, Condition (ICD-10), MedicationRequest, MedicationAdministration,
AllergyIntolerance, Observation (vital signs with LOINC + UCUM, laboratory results) and
Immunization. Access, patient-view filtering (released results, signed notes) and auditing are
identical to the rest of the API. Partner-specific profiles (e.g. International Patient Summary)
must be validated before production exchange.

## Email delivery (transactional outbox)

`enqueueEmail()` inserts into `email_outbox` inside the caller's transaction, so an email exists only
if the change that caused it committed (no "email sent but change rolled back"). A worker in each API
process polls every 5 seconds and claims due messages with `UPDATE … WHERE id IN (SELECT … FOR UPDATE
SKIP LOCKED)`, so instances never send the same message twice; a message stuck in `SENDING` (crash
mid-send) is re-claimed after a 5-minute lease. Failures back off exponentially (1, 2, 4, 8, 16
minutes) and are marked `FAILED` after six attempts. Subject and bodies are sealed with AES-256-GCM
and erased once a message is delivered or abandoned. Transports: `smtp` (nodemailer), `log`
(development) and `memory` (tests).

## SMS delivery

`sms_outbox` works like the email outbox (same claiming, lease, backoff, sealed bodies). Texts are
only queued for important notifications to users with a verified number who opted in. Non-urgent
texts scheduled inside quiet hours (`SMS_QUIET_HOURS`, default 22–07 in `SMS_TIMEZONE`) are
deferred to the end of the window; verification codes are always sent immediately. Providers:
`twilio` (REST API), `log`, `memory`, and `held` (production without credentials: queue only).

## Laboratory integration (HL7 v2)

```
Doctor ──POST /patients/:id/lab-orders──▶ lab_orders (ORDERED, placer number PAC…)
LIS ──GET  /integrations/lab/orders (JSON | ?format=hl7 → ORM^O01)──▶ new orders for its facility
LIS ──POST /integrations/lab/orders/:placer/receive──▶ RECEIVED (+ filler number)
LIS ──POST /integrations/lab/results (ORU^R01)──▶ ingest ──▶ ACK (AA / AE / AR)
```

The laboratory pulls work over HTTPS with its API key, so no inbound connection into the laboratory
network is required (an MLLP bridge can sit in front for analysers that only speak MLLP). Ingestion
(`modules/lab/ingest.ts`) runs in one transaction:

1. Idempotency: `(client, direction, MSH-10)` is unique; a retransmission is answered `AA` without
   filing again.
2. Matching: the OBR-2 placer order must exist at the laboratory's facility, and PID-3 (national ID)
   and PID-7 (date of birth) must match that order's patient. Any mismatch stores the message as
   `NEEDS_REVIEW` (still `AA`, so the lab does not resend) for the director's review queue.
3. Filing: each OBX becomes a `lab_results` row with `source = LIS`; flags map N/L/H/LL/HH/A/AA,
   OBX-11 P/F/C map to preliminary/final/corrected. A corrected result supersedes the current row
   for the same order and test (`superseded_by_id`), so lists and the worklist show only the
   current version together with the previous value, and acknowledgement starts again.
4. Alerts: the ordering doctor is notified; critical or corrected results are marked important
   (email/SMS per preference).

Every inbound message is logged in `integration_messages` (status, error, counts, sealed raw
message). `npm run lab:simulate` plays the laboratory in development.

## Backups

`deploy/backup.sh` (encrypted custom-format `pg_dump`, checksum, retention) and
`deploy/restore-verify.sh` (restore into a scratch database, check migrations, key tables and the
audit log triggers, report the recovery point). See [deploy/README.md](../deploy/README.md).

## Documents

Metadata in `patient_documents`, bytes in `document_contents` (bytea, `iv ‖ tag ‖ ciphertext`,
AES-256-GCM with a key derived for documents only). Upload: role check before reading the body →
size limit → magic-byte check → optional clamd INSTREAM scan → SHA-256 → encrypt → insert metadata,
content and audit in one transaction. FHIR `$everything` includes `DocumentReference` entries that
link to the content endpoint. At larger scale the content table can move to S3-compatible object
storage without changing the API.

## Consent

`consent_records` is an append-only history (trigger-protected); the latest unexpired row per
patient and type (per procedure for treatment) is the current decision. Defaults: cross-facility
sharing applies unless withdrawn; research is opt-in. Each row stores the wording version the
patient saw (`modules/consent/texts.ts`).

## Result cover and escalation

`cover_arrangements` give the cover doctor care-team access to the absent doctor's care-team
patients during the window (`access/policy.ts`), copy result alerts to them and add their results
to the cover doctor's worklist. `cover/escalation.ts` runs every minute: unacknowledged critical
results escalate at 30 minutes (ordering doctor, cover, care-team doctors) and 2 hours (plus the
facility director, without patient details). `result_escalations` has a unique (result, level)
key and inserts use `ON CONFLICT DO NOTHING … RETURNING`, so several API instances never notify
twice.
