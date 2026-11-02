# Pacient

An electronic health record platform with a **patient portal** and separate workspaces for
**doctors**, **facility directors** and the **Ministry of Health**.

Roles are distinct responsibilities, **not a seniority ladder**: a director or minister does not
inherit access to medical records. Access to identifiable clinical data follows the care
relationship, is limited to one institution, and every access is audited and visible to the patient.

| Workspace          | Can do                                                                                                                                                                                                                                                                                                                        | Cannot do                                                                            |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| **Patient portal** | Own history, vaccinations, released results, medications, allergies; request/cancel appointments; **secure messages** with their doctors; follow **referrals**; update contact details; request corrections; download the record; see **who viewed the record**; notifications and announcements; optional two-step sign-in   | Edit clinical content; see anyone else                                               |
| **Doctor**         | Worklist (unreviewed results, corrections, unsigned notes); register patients; document visits, diagnoses (ICD-10), prescriptions, allergies, vitals, lab results, **vaccinations**; sign notes and add addenda; release results; schedule; **message patients**; **refer to other facilities** and accept incoming referrals | Open records outside their care team without audited, same-facility emergency access |
| **Nurse**          | Shift overview, care tasks, clinic check-in; record vital signs, reported allergies, vaccinations and the **medication administration record** (given / withheld / refused / omitted with reason); message patients                                                                                                           | Diagnose, prescribe, release results or use emergency access                         |
| **Pharmacist**     | Facility **verification and dispensing queue** with medication context (allergies, other medicines, problems, renal function, weight) and safety alerts; return to prescriber; dispense                                                                                                                                       | Open the full clinical record                                                        |
| **Reception**      | Register patients, update contact details, portal invitations, **book any facility doctor**, front-desk queue with check-in / no-show                                                                                                                                                                                         | See any clinical information                                                         |
| **Director**       | Facility dashboard and operational exceptions; onboard/deactivate doctors; assign care teams; **accept and route incoming referrals**; **review every emergency access**; **facility reports with CSV export**; **facility announcements**; audit review                                                                      | Read clinical records                                                                |
| **Ministry**       | National aggregates with small-cell suppression; **period/region reports with CSV export**; **emergency-access review compliance per facility**; manage facilities; appoint directors; **national announcements**; national audit review                                                                                      | Read clinical records or identifiable patient data                                   |

Every staff role has **team channels** (facility channels per team plus a national Ministry ↔
directors channel), and the whole app updates **live** (Server-Sent Events). Records can be
exchanged in **HL7 FHIR R4** (`/api/v1/fhir`), and the report centre offers eight aggregate reports
with charts, print/PDF and audited CSV export.

**Guardians** (parents, legal guardians, foster carers) can be registered by the front desk after
checking evidence; they switch between their own record and their children's in the portal. Access
ends automatically at the child's 18th birthday, can be limited to appointments, and doctors can mark
visits as confidential from guardians. **Email notifications** are delivered through a transactional
outbox (SMTP, retries, encrypted at rest) and never contain health information; each user chooses
all, important only, or none. **SMS alerts** (Twilio) go to a verified mobile number for important
events only, respect quiet hours and never contain health information.

**Laboratory connections:** doctors order LOINC-coded tests; the facility's laboratory system
connects with an API key, pulls orders (JSON or HL7 v2 ORM^O01) and returns results as HL7 v2
ORU^R01. Results are filed automatically only when order number, national ID and date of birth all
match; anything else waits in the director's review queue. Corrected results supersede the old
value and reopen review; critical results alert the ordering doctor immediately.

All staff accounts use **two-step sign-in** (authenticator app with recovery codes) — mandatory in
production. Every account can reset a forgotten password through a single-use emailed link.

The design follows the project's _Hospital Information System Blueprint_; see
[docs/BLUEPRINT-ALIGNMENT.md](docs/BLUEPRINT-ALIGNMENT.md) for what is implemented and what is
deliberately deferred to later phases.

## Stack

- **API** — Node.js 22, TypeScript, Express 5, PostgreSQL 16, Drizzle ORM (SQL migrations), Zod
  validation, argon2id, pino structured logging. A modular monolith (`apps/api/src/modules/*`).
- **Web** — React 19, Vite, React Router, TanStack Query; dependency-free UI kit targeting WCAG 2.2 AA.
- **Tests** — Vitest + Supertest integration tests against a real PostgreSQL database.
- **Ops** — Dockerfiles (non-root), docker-compose, nginx with strict CSP, GitHub Actions CI.

## Quick start (local development)

Requirements: Node.js 22+, PostgreSQL 16.

```bash
npm install
```

```bash
createuser -P pacient            # password: pacient (development only)
createdb -O pacient pacient
createdb -O pacient pacient_test
```

```bash
cp apps/api/.env.example apps/api/.env   # then set JWT_ACCESS_SECRET to a long random value
```

```bash
npm run db:migrate && npm run db:seed
```

```bash
npm run dev
```

Open http://localhost:5173. The seed creates demo accounts (password `Pacient-Demo-2026`, development only):

| Role       | Email                      |
| ---------- | -------------------------- |
| Ministry   | `minister@pacient.local`   |
| Director   | `director@pacient.local`   |
| Doctor     | `doctor@pacient.local`     |
| Nurse      | `nurse@pacient.local`      |
| Pharmacist | `pharmacist@pacient.local` |
| Reception  | `reception@pacient.local`  |
| Patient    | `patient@pacient.local`    |

All seed data is synthetic. **Never load real patient data into development or test environments.**

### Email in development

By default the API logs emails instead of sending them. To see real emails, run a local catcher and
point the API at it:

```bash
docker run -d -p 1025:1025 -p 8025:8025 axllent/mailpit
```

Then set `SMTP_URL=smtp://localhost:1025` in `apps/api/.env` and open http://localhost:8025.

### Laboratory simulator

The seed creates a laboratory connection with a development key. With the API running, act as the
laboratory: pull the open orders and send back results (occasionally abnormal or critical):

```bash
cd apps/api
LAB_API_KEY=pk_dev_ucc_laboratory_demo_key_not_for_production npm run lab:simulate             # once
LAB_API_KEY=pk_dev_ucc_laboratory_demo_key_not_for_production npm run lab:simulate -- --watch  # every 15 s
```

SMS uses the `log` provider in development: verification codes appear in the API log.

### With Docker

```bash
JWT_ACCESS_SECRET=$(openssl rand -base64 48) MFA_ENCRYPTION_KEY=$(openssl rand -base64 48) docker compose up --build
```

Then open http://localhost:8080 (no demo data is seeded in this mode; create the first Ministry
account with a one-off script or seed in a non-production environment).

## Scripts

| Command                            | Purpose                                             |
| ---------------------------------- | --------------------------------------------------- |
| `npm run dev`                      | API (port 4000) and web (port 5173) with hot reload |
| `npm test`                         | Integration test suite (uses `pacient_test`)        |
| `npm run lint`                     | ESLint                                              |
| `npm run typecheck`                | TypeScript, all workspaces                          |
| `npm run build`                    | Production builds                                   |
| `npm run db:migrate`               | Apply migrations                                    |
| `npm run db:seed`                  | Load synthetic demo data (refuses in production)    |
| `npm run db:generate -w apps/api`  | Generate a migration after editing `schema.ts`      |
| `npm run lab:simulate -w apps/api` | Development laboratory system (see above)           |
| `deploy/backup.sh`                 | Encrypted `pg_dump` with retention                  |
| `deploy/restore-verify.sh`         | Restore a backup into a scratch DB and check it     |

## Documentation

- [Architecture](docs/ARCHITECTURE.md) — modules, data model, request flow, API overview
- [Security & privacy](docs/SECURITY.md) — access model, authentication, audit, threat mitigations
- [Blueprint alignment](docs/BLUEPRINT-ALIGNMENT.md) — requirement-by-requirement status and roadmap

## Status

This is a **foundation for a controlled outpatient pilot**, built on synthetic data. It is not
certified, has not had an independent security review, and must not be used for real patient care
until the acceptance gates in the blueprint (clinical safety, privacy, security, recovery and
usability sign-off) have been passed.
