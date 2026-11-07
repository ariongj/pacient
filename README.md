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

**Albanian, Serbian and English:** the whole interface, notifications, emails and SMS are
available in Albanian (default), Serbian (Latin) and English; dates use a 24-hour clock.

**Hospital modules:** wards and beds with a live bed board, admissions, transfers and discharge
with signed summaries; an emergency department with five-level triage and target times; newborn
registration linked to the mother with temporary numbers until the civil registry assigns one,
and temporary records for unidentified patients; radiology orders with safety checks, a
radiologist worklist and signed reports. Staff assigned to a unit see a patient's record only
while the patient is in that unit.

**More hospital and public-health modules:** operating theatres (booking with conflict checks,
WHO surgical safety checklist, signed operation notes, utilisation report); pharmacy stock
(national catalogue, batches with expiry, first-expiry-first-out dispensing, low-stock and expiry
alerts, national medicine availability); radiology image viewing through an authorised PACS
proxy (DICOMweb, with synthetic demo images in development); online appointment booking from
doctors' published consulting hours with reminders the day before; the national child
vaccination calendar with due/overdue lists, reminders to parents and coverage by birth cohort.

**Clinical safety and the rest of the hospital:** medication safety checks at prescribing and
in the pharmacy (interactions, allergy cross-reactions, kidney function, age, pregnancy, duplicate
therapy – overrides need a reason); structured dosing with dose-range checks by age and weight;
barcode medication administration with printed patient wristbands (wrong patient or wrong medicine
can never be overridden); NEWS2 and paediatric PEWS early warning with escalation; blood bank and
transfusions (compatibility, bedside two-person check, reactions); hospital nutrition (diet
orders, malnutrition screening, kitchen lists, fasting before operations); notifiable disease
reporting to public health with an outbreak dashboard; video consultations; billing with
co-payments and monthly claims to the Health Insurance Fund.

**National registers and certificates:** death registration with the WHO medical certificate of
cause of death (civil registry notified over the partner API, mortality statistics); sick-leave and
fitness certificates that employers and schools verify by QR code without seeing the diagnosis;
elective waiting lists with maximum waiting times and published waits; chronic disease registers
(diabetes, hypertension, asthma, COPD, kidney disease, heart failure) with recalls and quality
indicators; patient safety incident and near-miss reporting with review and learning.

**Prevention, prescriptions and rights:** antenatal care (pregnancy record, WHO contact schedule,
warning signs); cancer screening programmes with invitations and coverage; national e-prescriptions
dispensed by any community pharmacy (code and QR in the portal); a national register of professional
licences checked on clinical work; patient complaints with deadlines and anonymous feedback; the
organ donation registry, advance directives and resuscitation decisions shown in the chart and the
emergency department.

**Running a national service:** a downtime kit (hourly encrypted offline ward lists with
allergies and medicines due, downtime mode and a back-entry checklist), point-in-time database
recovery, Prometheus metrics with alert rules and a Grafana dashboard, and data protection tools
(retention schedule for operational data, legal holds, data-subject requests) and an audit
export for security monitoring.

**Account security:** passkeys (phishing-resistant sign-in), signed-in devices with remote
sign-out, personal sign-in history and alerts on sign-in from a new device. The portal can be
installed as an app on phones (no health data is stored on the device).

**Partner API:** documented (OpenAPI 3.1), scoped API keys for other systems – FHIR record access
by national ID (consent-gated, purpose of use required), civil-registry birth registration,
national statistics and a public directory.

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

| Role       | Email                       |
| ---------- | --------------------------- |
| Ministry   | `minister@pacient.local`    |
| Director   | `director@pacient.local`    |
| Doctor     | `doctor@pacient.local`      |
| Nurse      | `nurse@pacient.local`       |
| Pharmacist | `pharmacist@pacient.local`  |
| Reception  | `reception@pacient.local`   |
| Radiology  | `radiologist@pacient.local` |
| Kitchen    | `kuzhina@pacient.local`     |
| Patient    | `patient@pacient.local`     |

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
- **Hospital** (doctor, nurse, reception): _Emergjenca_ – register an unknown patient, triage,
  admit to a ward; _Repartet dhe shtretërit_ – bed board, transfer, discharge with a signed
  summary; _Lindjet_ – register a birth from the mother (Drita Hoxha), enter the baby's national
  number; _Identitetet e përkohshme_ – confirm unknown patients.
- **Radiologist** (`radiologist@`): worklist, write and sign the report for the STAT head CT,
  open the images (_Shiko imazhet_ – synthetic demo images).
- **Operating theatres** (doctor, nurse): _Sallat e operacionit_ – today's list, schedule the
  urgent request, run the WHO checklist (sign in → time out → sign out), sign the note.
- **Pharmacist**: _Stoku_ – low and expired items, receive a delivery, dispense a prescription
  and watch the batch quantity go down.
- **Patient**: book an appointment online (_Terminet_ → free slots), the vaccination booklet of
  her son Ardit (_Vaksinimet_, switch record), _Siguria dhe kyçja_ – add a passkey.
- **Safety and hospital** (doctor, nurse): prescribe ibuprofen for a patient on warfarin and see
  the block; _Paralajmërimi i hershëm (NEWS2)_ – the high-score patient; _Banka e gjakut_ and the
  _Transfuzionet_ tab; _Ushqyerja_ – today's kitchen list; _Sëmundjet ngjitëse_ – complete the
  measles case report.
- **Dosing and bedside scanning** (doctor, nurse): prescribe with the dose builder and see the
  dose-limit check (try a child without a recorded weight); _Printo byzylykun_ in the chart
  header; _Skano dhe jep_ on the medicines tab – type the wristband code and a pack barcode
  (`2900000000018` …) or use a handheld scanner; the children on _Pediatria_ are scored with PEWS.
- **Downtime** (director): _Paketa për ndërprerje_ – start downtime mode (red banner for all
  staff), download the offline pack, end downtime and work through the back-entry checklist.
- **Data protection and system health** (ministry): _Mbrojtja e të dhënave_ – retention, legal
  holds, requests from patients; _Gjendja e sistemit_ – workers, queues and backups.
- **Certificates** (doctor, patient): on a chart's _Vërtetimet_ tab issue a sick-leave certificate
  and print it; the patient finds it under _Vërtetimet mjekësore_; anyone can check the demo
  certificate at `/verify/demo-certificate-code-not-for-production` (no sign-in).
- **Waiting lists** (doctor, reception, director): _Listat e pritjes_ – breached and postponed
  entries, schedule a patient; directors see median waits; the published times need no sign-in.
- **Disease registers** (doctor, nurse, director, ministry): _Regjistrat e sëmundjeve_ – the recall
  list, the chart tab _Sëmundjet kronike_, and
  quality indicators for directors and the Ministry.
- **Deaths** (doctor, director, ministry): _Certifikatat e vdekjes_ – a draft and signed
  certificates, the WHO form with its warnings, mortality statistics.
- **Safety incidents** (all staff): _Raporto një incident_ – report anonymously or by name;
  `director@` and `pharmacist@` (named medication-safety lead) see the review queue; the Ministry
  sees national counts and incidents involving the system.
- **E-prescriptions** (doctor, patient): prescribe with _E-recetë për barnatore_; the
  patient sees the code and QR under _E-recetat_; a pharmacy system looks up the demo code
  `DEMA-ERX2-345C` with the partner key in [docs/API.md](docs/API.md).
- **Antenatal care and screening** (doctor, nurse): _Kujdesi antenatal_ – pregnancies with
  warnings (one possible pre-eclampsia, one past 42 weeks); _Depistimi i kancerit_ – who is due and
  the abnormal result awaiting follow-up; the patient sees her screening invitation in the portal.
- **Wishes and directives**: the patient records an organ donation decision and a healthcare proxy
  under _Dhurimi i organeve dhe dëshirat_; doctor@ sees the DNACPR banner on Dardan Berisha's chart.
- **Complaints and licences**: the patient complains or rates a recent visit under _Ankesat dhe
  vlerësimet_; director@ handles complaints and sees staff licences; the Ministry manages the
  licence register and can withdraw a death certificate (_Vdekshmëria_ → _Tërhiq një certifikatë_).
- **Video visit** (patient + doctor): the demo patient's video appointment starts about 10 minutes
  after seeding – _Bashkohu në vizitën me video_ in both accounts (use two browsers).
- **Billing** (reception, director): _Faturimi dhe sigurimi_ – take a co-payment, prepare and
  submit the monthly claim; the patient sees bills under _Faturat dhe pagesat_.
- **Languages**: SQ / SR / EN at the top.
- **Ministry**: partner systems (API keys) and the API documentation page; national reports for
  occupancy, emergency waiting times, births and imaging.
- **Nurse, pharmacist, reception**: their own workspaces and team channels.

### Partner API (other systems)

Outside systems never get database access – they get scoped, revocable API keys, and every call
is audited and visible to the patient. Try the demo keys against a running API (option B):

```bash
curl -s "http://localhost:4000/api/v1/partner/fhir/Patient?identifier=1100000000" -H "Authorization: Bearer pk_dev_hif_demo_key_not_for_production" -H "X-Purpose-Of-Use: PAYMENT"
```

```bash
curl -s "http://localhost:4000/api/v1/partner/births" -H "Authorization: Bearer pk_dev_civil_registry_demo_key_not_for_production"
```

The full reference is at `/api/v1/openapi.json` (rendered in the app under _API documentation_)
and the guide is [docs/API.md](docs/API.md).

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

| Command                            | Purpose                                              |
| ---------------------------------- | ---------------------------------------------------- |
| `npm run dev`                      | API (port 4000) and web (port 5173) with hot reload  |
| `npm test`                         | Integration test suite (uses `pacient_test`)         |
| `npm run lint`                     | ESLint                                               |
| `npm run typecheck`                | TypeScript, all workspaces                           |
| `npm run build`                    | Production builds                                    |
| `npm run db:migrate`               | Apply migrations                                     |
| `npm run db:seed`                  | Load synthetic demo data (refuses in production)     |
| `npm run db:generate -w apps/api`  | Generate a migration after editing `schema.ts`       |
| `npm run lab:simulate -w apps/api` | Development laboratory system (see above)            |
| `deploy/backup.sh`                 | Encrypted `pg_dump` with retention                   |
| `deploy/restore-verify.sh`         | Restore a backup into a scratch DB and check it      |
| `deploy/pitr/pitr.sh`              | Point-in-time recovery (pgBackRest)                  |
| `node scripts/downtime-sync.mjs`   | Copy the latest downtime pack to a ward PC           |
| `npm run a11y`                     | Accessibility audit (axe, WCAG 2.2 AA) of every page |

## Documentation

- [Architecture](docs/ARCHITECTURE.md) — modules, data model, request flow, API overview
- [Security & privacy](docs/SECURITY.md) — access model, authentication, audit, threat mitigations
- [Blueprint alignment](docs/BLUEPRINT-ALIGNMENT.md) — requirement-by-requirement status and roadmap
- [Clinical safety case](docs/CLINICAL-SAFETY.md) — hazard log, controls and go-live conditions
- [Privacy](docs/PRIVACY.md) — data protection, retention and data-subject rights
- [Downtime](docs/DOWNTIME.md) — what to do when the system is unavailable, and recovery
- [Partner API](docs/API.md) — keys, scopes, purpose of use, OpenAPI and FHIR
- [Deployment](deploy/README.md) — production setup, backups, PITR and monitoring

## Status

This is a **foundation for a controlled outpatient pilot**, built on synthetic data. It is not
certified, has not had an independent security review, and must not be used for real patient care
until the acceptance gates in the blueprint (clinical safety, privacy, security, recovery and
usability sign-off) have been passed.
