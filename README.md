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
| **Director**       | Facility dashboard and operational exceptions; onboard/deactivate doctors; assign care teams; **accept and route incoming referrals**; **review every emergency access**; **facility reports with CSV export**; **facility announcements**; audit review                                                                      | Read clinical records                                                                |
| **Ministry**       | National aggregates with small-cell suppression; **period/region reports with CSV export**; **emergency-access review compliance per facility**; manage facilities; appoint directors; **national announcements**; national audit review                                                                                      | Read clinical records or identifiable patient data                                   |

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

| Role     | Email                    |
| -------- | ------------------------ |
| Ministry | `minister@pacient.local` |
| Director | `director@pacient.local` |
| Doctor   | `doctor@pacient.local`   |
| Patient  | `patient@pacient.local`  |

All seed data is synthetic. **Never load real patient data into development or test environments.**

### With Docker

```bash
JWT_ACCESS_SECRET=$(openssl rand -base64 48) MFA_ENCRYPTION_KEY=$(openssl rand -base64 48) docker compose up --build
```

Then open http://localhost:8080 (no demo data is seeded in this mode; create the first Ministry
account with a one-off script or seed in a non-production environment).

## Scripts

| Command                           | Purpose                                             |
| --------------------------------- | --------------------------------------------------- |
| `npm run dev`                     | API (port 4000) and web (port 5173) with hot reload |
| `npm test`                        | Integration test suite (uses `pacient_test`)        |
| `npm run lint`                    | ESLint                                              |
| `npm run typecheck`               | TypeScript, all workspaces                          |
| `npm run build`                   | Production builds                                   |
| `npm run db:migrate`              | Apply migrations                                    |
| `npm run db:seed`                 | Load synthetic demo data (refuses in production)    |
| `npm run db:generate -w apps/api` | Generate a migration after editing `schema.ts`      |

## Documentation

- [Architecture](docs/ARCHITECTURE.md) — modules, data model, request flow, API overview
- [Security & privacy](docs/SECURITY.md) — access model, authentication, audit, threat mitigations
- [Blueprint alignment](docs/BLUEPRINT-ALIGNMENT.md) — requirement-by-requirement status and roadmap

## Status

This is a **foundation for a controlled outpatient pilot**, built on synthetic data. It is not
certified, has not had an independent security review, and must not be used for real patient care
until the acceptance gates in the blueprint (clinical safety, privacy, security, recovery and
usability sign-off) have been passed.
