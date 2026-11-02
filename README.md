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

**Documents:** scanned letters, reports, photos and signed consent forms are attached to the
record, checked (file type, optional ClamAV malware scan), stored encrypted and never deleted
(wrong uploads are marked "entered in error"). Patients see documents once they are shared and can
add their own, e.g. results from a clinic abroad.

**Consent:** patients (and guardians) decide in the portal whether their record is shared when they
are referred to another facility and whether de-identified data may be used for approved research;
doctors record treatment consent in person or with a signed form. Consent history is append-only,
and referring a patient who withdrew sharing requires recording their renewed agreement.

**Albanian and English:** the whole interface, notifications, emails and SMS are available in
Albanian (default) and English; dates use a 24-hour clock.

**Duplicate records:** directors find people registered twice, compare both records (demographics
and counts only), merge them with a reason and can undo a wrong merge exactly.

**Result cover and escalation:** doctors name a colleague who covers their results while they are
away. Critical results nobody has acknowledged escalate after 30 minutes to the care team and
cover, and after 2 hours also to the director (without patient details).

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

## Try it on your computer

You need [Git](https://git-scm.com) and **either** Docker Desktop (option A) **or** Node.js 22+
(option B). Everything runs on your machine with synthetic demo data.

```bash
git clone https://github.com/ariongj/pacient.git
```

```bash
cd pacient && git checkout claude/practical-rubin-idyxdo
```

**Option A – only Docker Desktop (simplest).** Builds and starts the database, API, web app and a
mail catcher, migrates and loads the demo data on first start:

```bash
docker compose -f docker-compose.demo.yml up --build
```

Open http://localhost:8080 for the app and http://localhost:8025 for the emails it sends. Stop with
Ctrl+C; delete the demo data with `docker compose -f docker-compose.demo.yml down -v`.

**Option B – Node.js (best for development, live reload).** One-time setup creates
`apps/api/.env` with random secrets, starts PostgreSQL and Mailpit with Docker if no database is
running on port 5432 (or uses your own PostgreSQL 16 with user/password `pacient`), migrates and
loads the demo data:

```bash
npm run setup
```

```bash
npm run dev
```

Open http://localhost:5173 (emails: http://localhost:8025 when Mailpit runs).

The interface opens in **Albanian**; switch to English with **SQ / EN** at the top. Each user's
choice is saved, and notifications, emails and SMS follow it. Sign in with any demo account
(password `Pacient-Demo-2026`, development only):

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

### What to try

- **Patient** (`patient@`): medical history, results, documents, privacy & consent, and switch to
  the record of daughter Lea with the selector at the top left (guardian access).
- **Doctor** (`doctor@`): worklist (including results covered for an absent colleague), open Arta
  Krasniqi → order a lab test on _Rezultatet / Results_, then run the laboratory simulator below.
- **Director** (`director@`): dashboard with an overdue critical result, _Kartela të dyfishta /
  Duplicate records_ (merge the two "Blerim Gashi" records, then undo it from the history), lab
  connections with one held message to review.
- **Nurse, pharmacist, reception, ministry**: their own workspaces and team channels.

### Laboratory simulator

The seed creates a laboratory connection with a development key. With the API running, act as the
laboratory: pull the open orders and send back results (occasionally abnormal or critical). With
option A run it inside the container:
`docker compose -f docker-compose.demo.yml exec -e LAB_API_KEY=pk_dev_ucc_laboratory_demo_key_not_for_production api node dist/ops/lab-simulator.js`.
With option B:

```bash
cd apps/api
LAB_API_KEY=pk_dev_ucc_laboratory_demo_key_not_for_production npm run lab:simulate             # once
LAB_API_KEY=pk_dev_ucc_laboratory_demo_key_not_for_production npm run lab:simulate -- --watch  # every 15 s
```

SMS uses the `log` provider in development: verification codes appear in the API log.

### Production-style Docker (no demo data)

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
