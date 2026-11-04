# Data protection

How Pacient meets **Law No. 06/L-082 on Protection of Personal Data** (Kosovo, aligned with the
EU GDPR). This page is the records of processing, the summary of the data protection impact
assessment (DPIA) and the procedure for data subject rights and breaches. It describes what
the software does; the controller must still adopt it formally and keep it current.

Day-to-day handling is in the web app under **Data protection** (`/privacy`, facility directors
and the Ministry). Patients use **Privacy & consent → Your data rights** in the portal.

## Roles

| Role                    | Who                                                                            |
| ----------------------- | ------------------------------------------------------------------------------ |
| Controller              | Ministry of Health, for the national system; each public facility for its care |
| Processor               | The operator hosting Pacient, under a written processing agreement             |
| Sub-processors          | Email and SMS delivery providers (no health details are ever sent to them)     |
| Data protection officer | _To be appointed – name, email and phone go here before go-live_               |
| Supervisory authority   | Information and Privacy Agency (Agjencia për Informim dhe Privatësi, IPA)      |

## Lawful bases

Health data is a special category. Pacient processes it because it is necessary for medical
diagnosis, care and treatment by professionals bound by confidentiality, and for public health
(notifiable disease surveillance, vaccination, the national registers). Other processing:

- **Legal obligation** – the audit trail of every access, identification of patients, retention
  of health records for the period health legislation sets.
- **Consent** – research use and sharing between facilities outside a referral (patients can
  withdraw at any time in the portal; see `modules/consent`).
- **Legitimate interest / security** – sign-in sessions, known devices, delivery logs.

## Records of processing

| Data                                            | Data subjects             | Purpose                                 | Lawful basis                     | Recipients                                  | Retention                                                     |
| ----------------------------------------------- | ------------------------- | --------------------------------------- | -------------------------------- | ------------------------------------------- | ------------------------------------------------------------- |
| Health record (diagnoses, results, medicines)   | Patients                  | Care and treatment                      | Care; public health              | Care team; other facilities on referral     | Period set by health legislation; never removed automatically |
| Identity and contact details                    | Patients, guardians       | Identification, contact                 | Care; legal obligation           | Care team, reception                        | As long as the health record                                  |
| Consent decisions                               | Patients, guardians       | Respect choices on sharing and research | Consent; legal obligation        | Care team                                   | As long as the health record                                  |
| Audit trail of access                           | Patients, staff           | Accountability, security                | Legal obligation                 | Patient (own access log), director, Ministry | Never deleted                                                 |
| Staff accounts, licence numbers                 | Staff                     | Access control                          | Legal obligation; contract       | Directors, Ministry                         | Duration of employment plus audit needs                       |
| Notifications, email and SMS delivery logs      | Patients, staff           | Telling people something is ready       | Service; legitimate interest     | Email/SMS providers (no health details)     | Retention policies (default 90–365 days)                      |
| Sign-in sessions, devices, verification codes   | Patients, staff           | Security of processing                  | Security; legitimate interest    | –                                           | Retention policies (default 1–730 days)                       |
| Raw laboratory messages (HL7)                   | Patients                  | Filing results from laboratories        | Care                             | Laboratory interface                        | Anonymised after 730 days (the filed results stay)            |
| Statistics and reports                          | –                         | Planning, public health                 | Public interest                  | Ministry                                    | Aggregated, no personal data                                  |

**International transfers:** none. All data is hosted in Kosovo; providers that would transfer
data outside the country must not be configured without a new assessment.

## DPIA summary

| Risk                                  | Controls in Pacient                                                                                                     |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Staff viewing records without reason  | Access only through a care relationship; break-glass emergency access needs a reason and is reviewed; every view audited |
| Patients unaware of who looked        | Patients see their own access log in the portal                                                                          |
| Account takeover                      | Two-step sign-in for staff, passkeys, account lockout, new-device alerts, refresh-token reuse detection                 |
| Disclosure through notifications      | Email and SMS never contain health details; message bodies are erased after sending                                     |
| Data at rest exposed                  | Sensitive fields sealed with encryption; backups encrypted (see `SECURITY.md`)                                           |
| Data kept longer than needed          | Nightly retention job for operational data with Ministry-set periods and a legal basis per category                     |
| Records destroyed during a dispute    | Legal holds stop retention for the patient until released                                                               |
| Children's data handled by others     | Guardian access is verified with evidence and scoped (full or appointments only)                                        |
| Confidential diagnoses                | Confidential entries hidden from guardians and outside the care team                                                    |

Residual risk is assessed as acceptable when the controls above are in place and the
organisational measures (training, confidentiality agreements, access reviews) are followed.

## Retention

The job (`apps/api/src/modules/privacy/retention.ts`) runs every night at 02:00 local time and
only touches **operational data**. It never deletes health records and never deletes the audit
trail. Patients under an active legal hold are skipped in every category that can be linked to
them.

| Category                   | Default  | Action                                    |
| -------------------------- | -------- | ----------------------------------------- |
| `EMAIL_OUTBOX`             | 90 days  | Delete sent / failed delivery records     |
| `SMS_OUTBOX`               | 90 days  | Delete sent / failed delivery records     |
| `NOTIFICATIONS_READ`       | 365 days | Delete read in-app notifications          |
| `REFRESH_TOKENS`           | 30 days  | Delete expired sessions                   |
| `AUTH_CHALLENGES`          | 1 day    | Delete expired passkey challenges         |
| `PHONE_VERIFICATIONS`      | 30 days  | Delete verification codes                 |
| `KNOWN_DEVICES`            | 730 days | Delete devices not used since             |
| `VIDEO_SESSIONS`           | 365 days | Delete technical records of ended visits  |
| `INTEGRATION_RAW_MESSAGES` | 730 days | Anonymise (drop the raw message body)     |

The Ministry can change the period, pause a category and must record the legal basis; each
change is audited (`privacy.retention_changed`). Directors and the Ministry can preview what the
next run would remove; every real run is audited (`privacy.retention_run`) with the counts.

## Data subject rights

Requests are answered **within 30 days** of receipt; the register marks overdue requests.

| Right            | How it is handled                                                                                         |
| ---------------- | --------------------------------------------------------------------------------------------------------- |
| Access (copy)    | Self-service download in the portal (My details → download), plus the access log                         |
| Portability      | Self-service FHIR R4 export (`Patient/$everything`)                                                        |
| Rectification    | Correction request in the portal; clinical entries are corrected by the treating doctor                   |
| Restriction      | Request from the portal or in person; the director decides and records the outcome                        |
| Objection        | Request from the portal or in person (for example to reminders or research); consent can be withdrawn    |
| Erasure          | Health records cannot be erased during the legal retention period; operational data can be, and the patient may add a statement to the record |

Patients and full-scope guardians file requests in the portal. Directors (for patients of their
facility) and the Ministry (nationally) record requests received in person, by post or by email,
move them through _received → in progress → completed / rejected_, and record the outcome. The
patient is notified when a request is answered. Every step is audited (`privacy.request`).

## Legal holds

A director or the Ministry places a hold with a reason (court case, complaint, investigation)
and releases it with a reason. Both are audited (`privacy.legal_hold`).

## Personal data breach

1. Anyone who suspects a breach reports it to the data protection officer immediately.
2. The DPO and the operator contain it, preserve evidence (audit trail, logs) and assess the risk.
3. The controller notifies the **Information and Privacy Agency within 72 hours** of becoming
   aware, unless the breach is unlikely to result in a risk to people.
4. When the risk is high, the patients affected are told without undue delay, in plain language,
   with what they can do.
5. Every breach is documented, including those not notified.

## API

| Method | Path                                    | Who                                      |
| ------ | --------------------------------------- | ---------------------------------------- |
| GET    | `/api/v1/privacy/retention`             | Director, Ministry                       |
| PATCH  | `/api/v1/privacy/retention/:category`   | Ministry                                 |
| POST   | `/api/v1/privacy/retention/preview`     | Director, Ministry (dry run)             |
| POST   | `/api/v1/privacy/retention/run`         | Ministry                                 |
| GET    | `/api/v1/privacy/my-requests`           | Patient, full-scope guardian             |
| POST   | `/api/v1/privacy/my-requests`           | Patient, full-scope guardian             |
| GET    | `/api/v1/privacy/requests`              | Director (own facility), Ministry        |
| POST   | `/api/v1/privacy/requests`              | Director (own facility), Ministry        |
| PATCH  | `/api/v1/privacy/requests/:id`          | Director (own facility), Ministry        |
| GET    | `/api/v1/privacy/holds`                 | Director (own facility), Ministry        |
| GET    | `/api/v1/privacy/patients/:id/holds`    | Director (own facility), Ministry        |
| POST   | `/api/v1/privacy/holds`                 | Director (own facility), Ministry        |
| POST   | `/api/v1/privacy/holds/:id/release`     | Director (own facility), Ministry        |
