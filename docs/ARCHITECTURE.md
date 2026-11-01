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

| Area         | Endpoints                                                                                                                                                                                                                                                                                                                                                          |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Auth         | `POST /auth/login`, `/auth/refresh`, `/auth/logout`, `/auth/activate`, `/auth/change-password`, `GET /auth/me`                                                                                                                                                                                                                                                     |
| Facilities   | `GET /facilities`, `GET /facilities/:id`, `POST` / `PATCH` (Ministry)                                                                                                                                                                                                                                                                                              |
| Staff        | `GET /staff`, `POST /staff/invitations`, `PATCH /staff/:id/status`                                                                                                                                                                                                                                                                                                 |
| Patients     | `GET/POST /patients`, `GET/PATCH /patients/:id`, `POST /patients/:id/portal-invitation`, care team `GET/POST/DELETE /patients/:id/care-team[/:doctorId]`, `POST /patients/:id/emergency-access`                                                                                                                                                                    |
| Clinical     | `GET /patients/:id/{summary,encounters,diagnoses,prescriptions,allergies,vitals,lab-results,export}`; `POST` to the same collections; `PATCH /encounters/:eid` (draft, versioned), `POST /encounters/:eid/sign`, `POST /encounters/:eid/addenda`, `POST /lab-results/:rid/{acknowledge,release}`, `PUT /allergy-assessment`, `GET/POST/PATCH /correction-requests` |
| Appointments | `GET/POST /appointments`, `PATCH /appointments/:id/status`                                                                                                                                                                                                                                                                                                         |
| Portal       | `GET /portal/access-log`, `PATCH /portal/contact`                                                                                                                                                                                                                                                                                                                  |
| Worklist     | `GET /worklist` (doctor)                                                                                                                                                                                                                                                                                                                                           |
| Reporting    | `GET /stats/facility`, `GET /stats/national`, `GET /audit-logs`                                                                                                                                                                                                                                                                                                    |
| Health       | `GET /health/live`, `GET /health/ready`                                                                                                                                                                                                                                                                                                                            |

## Testing

`npm test` drops and recreates the `pacient_test` schema **from the migrations** (so tests exercise
the real migrations and triggers), then runs integration tests through the HTTP layer. The suite
covers authentication (lockout, token rotation and reuse detection, activation), the access
matrix for every role, tenant boundaries, break-glass, clinical integrity (versioning, signing,
addenda, DB-level immutability), result follow-up, corrections, duplicate review, the staff
hierarchy, appointments, reporting scope and small-cell suppression, and audit immutability.
