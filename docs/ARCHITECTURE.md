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

## Languages (Albanian / English)

Web: `apps/web/src/i18n` – English source strings wrapped in `t()` / `tn()`; Albanian dictionaries
per area in `i18n/sq/*.ts` (glossary in `i18n/GLOSSARY.md`); missing entries fall back to English.
Enum labels (`humanize`), audit action labels, server error messages and stored notification
titles are translated centrally. Albanian dates are formatted in code (24-hour clock) rather than
relying on browser locale data. The language lives in `users.locale` (`sq` default) and is switched
with SQ / EN in the top bar; a choice made on the sign-in page is saved to the profile.

API: `apps/api/src/i18n` – `tr(locale, text, vars)`. `notifyUsers` translates each notification
for its recipient before storing it and before queueing email/SMS; email templates and SMS bodies
exist in both languages.

## Patient merge

`modules/merge` – directors merge a duplicate into the surviving record at their facility. In one
transaction (`SET LOCAL pacient.patient_merge = 'on'`, which the append-only triggers accept only
for changes to `patient_id`), every table referencing `patients` is re-pointed (a test fails if a
new referencing table is not covered), equivalent active care-team/guardian rows are ended instead
of duplicated, and the moved row ids plus a demographic snapshot are stored in `patient_merges`.
Unmerge moves exactly those rows back; rows created after the merge stay with the survivor. Merged
records are read-only: clinical access answers `409 PATIENT_MERGED` with the surviving id. Audit
entries are never rewritten; the patient's access log includes those of merged duplicates.

## Hospital modules

- **Care units** (`care_units`, `unit_staff`, `beds`): wards, emergency, radiology, maternity and
  neonatal units per facility. Unit staff get care-team access to patients currently in the unit
  (`unitAccessVia` in `access/policy.ts`).
- **Inpatient** (`modules/inpatient`, `/hospital`): admissions with bed locking (one active
  admission per patient, one patient per bed – partial unique indexes), bed movements, discharge
  with a signed summary drafted from the record, release to the patient.
- **Emergency** (`modules/ed`, `/ed`): attendances with five-level triage, target times and breach
  flags; admission from the board goes through `/hospital/admissions` with `edVisitId`.
- **Identity** (`modules/identity`, `/identity`): births (`births`) create the newborn's record with
  a temporary number (`TMP…`), care team, guardianship and rooming-in admission; unidentified
  patients get temporary records; `confirmIdentity()` is shared by staff and the civil registry.
- **Imaging** (`modules/imaging`, `/imaging`): orders with modality-specific safety checks,
  radiology worklist, signed immutable reports, acknowledgement and release.
- **Live boards**: writes on these routers publish `hospital.board`, `ed.board` and
  `imaging.worklist` events to the facility's staff (`publishBoardChanges` in `lib/events.ts`).

## Partner API and OpenAPI

`modules/partner` authenticates partner systems with scoped API keys (`partner_clients`), requires
`X-Purpose-Of-Use` for record access, enforces consent and limits FHIR content by purpose, and
audits every call. FHIR bundles are built once in `modules/fhir/fhir.service.ts` for staff,
patients and partners. The OpenAPI 3.1 document (`src/openapi`) is served at
`/api/v1/openapi.json`. See [API.md](API.md).

## Operating theatres, pharmacy stock, images, scheduling, vaccination, passkeys

- **Theatre** (`modules/theatre`, `/theatre`): surgical cases with team, side, priority and
  consent; scheduling with theatre-overlap and surgeon double-booking checks; the WHO checklist
  enforced in order (stored with user and time); signed operation notes immutable by trigger.
  Theatre units (`OPERATING_THEATRE`) give their staff record access around the operation.
- **Stock** (`modules/stock`, `/stock`): `medication_catalog` (national), `stock_batches`
  (per facility, never negative), `stock_movements` (append-only ledger), `stock_settings`
  (reorder levels). Pharmacy dispensing allocates batches first-expiry-first-out inside the same
  transaction as the dispense.
- **Images** (`modules/pacs`, `/imaging/orders/:id/images…`): DICOMweb client (QIDO/WADO-RS)
  behind an authorised, audited proxy; `PACS_MODE=demo` generates watermarked synthetic images.
- **Scheduling** (`modules/scheduling`, `/scheduling`): weekly consulting hours and absences;
  slots computed in Europe/Belgrade (DST-safe); portal bookings serialised per doctor; reminder
  worker 20–28 h before.
- **Vaccination** (`modules/vaccination`, `/vaccination`): `vaccine_schedule` (Ministry-editable),
  per-child status computed from date of birth and recorded doses, due lists, reminders
  (`immunization_reminders`, once per dose and kind), coverage by birth cohort.
- **Security** (`modules/security`, `/auth/security`): WebAuthn passkeys (`webauthn_credentials`,
  single-use `auth_challenges`), sessions from refresh-token families, sign-in history from the
  audit log, `known_devices` for new-device alerts.
- **Languages**: `sq`, `sr` (Latin) and `en`; web dictionaries in `apps/web/src/i18n/{sq,sr}`,
  server in `apps/api/src/i18n/{sq,sr}-*.ts`; glossaries `GLOSSARY.md` / `GLOSSARY-sr.md`.
- **PWA**: `apps/web/public/manifest.webmanifest` and `sw.js` (caches the app shell only, never
  `/api`).

## Video visits

`modules/telemedicine` (`/video`): VIDEO appointments open a room 15 minutes before the start;
only the appointment's doctor and patient (or a guardian acting for a child) may join. Media flows
peer-to-peer (WebRTC, DTLS-SRTP); the API only relays signalling (offer/answer/ICE candidates)
and wakes the other side with a `video.signal` live event. Signalling messages are kept in memory
in one API process – with several API instances, route `/api/v1/video` with sticky sessions or
move the queue to a shared store. STUN from `WEBRTC_STUN_URLS`; TURN credentials (coturn REST
style, 1 hour) when `WEBRTC_TURN_*` are set. Calls are never recorded.

## Clinical safety and hospital services

- **Medication safety** (`modules/safety`, `/safety`): one engine (`safety/engine.ts`) runs at
  prescribing, pharmacy verification and the bedside – interactions (`drug_interactions`,
  Ministry-maintained), allergy cross-reactions, kidney function, age, pregnancy, duplicate
  therapy and dose ranges. Blocking alerts answer `409 SAFETY_ALERTS`; overrides need a reason and
  are stored in `prescription_alerts`.
- **Structured dosing** (`safety/dosing.ts`): prescriptions carry amount, unit, route, frequency
  code, duration and PRN maximum per 24 h; the free text is generated in the prescriber's language.
  Dose rules (`dose_rules`, Ministry-maintained) per ingredient, route and age group (neonate,
  child, adult, elderly), absolute or per kg using the latest recorded weight; catalogue strengths
  are parsed to convert tablets, ml or puffs to mg, per ingredient for combination products.
- **Barcode administration** (`modules/bcma`): wristbands carry a signed code
  (`PAC1.<payload>.<HMAC>`, patient id and issue time only). `POST /patients/:id/bcma/verify` and
  the administration route check right patient, right medicine (barcode → catalogue item →
  ingredients and strength), right time (interval from the frequency, PRN limit per 24 h) and
  allergies. Wrong patient, wrong medicine and invalid wristbands can never be overridden; other
  warnings need an audited reason. The scan flags are derived by the server, never trusted.
- **Early warning** (`modules/news`): every set of vital signs is scored – NEWS2 for adults
  (`news2.ts`), PEWS with age bands for patients under 18 (`pews.ts`) – and stored in
  `early_warning_scores` with the scale. A worker escalates by risk and re-escalates
  unacknowledged high scores; notifications name the ward and bed, never the patient.
- **Blood bank** (`modules/bloodbank`), **nutrition** (`modules/nutrition`), **billing**
  (`modules/billing`, claims to the Health Insurance Fund over the partner API) and
  **surveillance** (`modules/surveillance`, notifiable disease reports and outbreak signals) follow
  the same pattern: unit-based access, audited writes, append-only ledgers where money or blood
  products move.

## Business continuity, monitoring and data protection

- **Downtime** (`modules/downtime`, `/downtime`): an hourly worker writes an encrypted HTML pack per
  facility (admitted patients, allergies, medicines due in the next 12 h, last observations and early warning
  score) to `DOWNTIME_DIR`, keeping the newest 48; optionally an `age`-encrypted copy for ward PCs
  (`scripts/downtime-sync.mjs`, authenticated by per-facility sync keys stored as hashes).
  Directors start and end downtime mode (a banner for all staff); the back-entry checklist lists
  what to enter afterwards. Vital signs and doses accept their real time for back-entry. See
  [DOWNTIME.md](DOWNTIME.md).
- **Point-in-time recovery**: pgBackRest with WAL archiving (`deploy/pitr/`,
  `deploy/compose.pitr.yml`), alongside the nightly encrypted dumps (`deploy/backup.sh`).
- **Monitoring** (`modules/monitoring`): Prometheus metrics at `/metrics` (requests, latency,
  database pool, event loop, memory, outbox depth and age, live events), alert rules and a Grafana dashboard in
  `deploy/monitoring/`; the Ministry's system health page shows the same signals, and the Ministry can export the audit
  trail for a SIEM (the export itself is audited).
- **Data protection** (`modules/privacy`, `/privacy`): retention schedule for operational data
  (sessions, tokens, delivered messages and similar – fixed, reviewed statements; the Ministry sets
  only the days and can switch a category off). Clinical records and the audit trail are never
  purged, and rows of a patient under a legal hold are always skipped. Legal holds and
  data-subject requests with deadlines are managed on the same page. See [PRIVACY.md](PRIVACY.md).
