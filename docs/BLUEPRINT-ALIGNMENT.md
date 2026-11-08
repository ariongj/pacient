# Blueprint alignment

How this codebase maps to the _Hospital Information System Blueprint_. The blueprint recommends a
**foundation + controlled outpatient pilot** first; high-acuity modules (emergency department,
inpatient medication administration, theatre) stay on established systems until their own
readiness gates pass. This repository implements the foundation and the outpatient pilot scope.

Legend: ✅ implemented · 🟡 partial / foundation in place · ⏳ planned (later phase)

## Roles and permission model (§3)

| Requirement                                                                            | Status | Where                                                                   |
| -------------------------------------------------------------------------------------- | :----: | ----------------------------------------------------------------------- |
| Default deny; contextual authorization enforced on the server                          |   ✅   | `modules/access/policy.ts`                                              |
| Roles are responsibilities, not a ladder; director/ministry get no record access       |   ✅   | policy + `test/access-control.test.ts`                                  |
| Doctor access limited to assigned care                                                 |   ✅   | `care_assignments`                                                      |
| Institution (tenant) isolation incl. search and break-glass                            |   ✅   | patients routes, policy                                                 |
| Break-glass: eligible clinicians, reason, short duration, review, never cross-tenant   |   ✅   | emergency access + director review queue + Ministry compliance view     |
| Audit of reads, searches, changes, exports, denials, role changes, emergency access    |   ✅   | `modules/audit`                                                         |
| Prompt leaver revocation (blocks active sessions)                                      |   ✅   | staff status + per-request account check                                |
| Patient, Doctor, Director (operations/clinical), Ministry roles                        |   ✅   |                                                                         |
| Nurse role: care team, observations, tasks, medication administration (no prescribing) |   ✅   | `policy.ts` WRITERS, MAR, care tasks                                    |
| Pharmacist role: medication review/verification/dispensing with necessary context only |   ✅   | `modules/pharmacy`                                                      |
| Reception role: identity, contact, scheduling; clinical detail hidden                  |   ✅   | patients/appointments routes                                            |
| Guardian / proxy: verified, explicit, patient-specific, scoped, expiring, revocable    |   ✅   | `modules/guardians`, `X-Acting-For`                                     |
| Confidential minor records follow applicable law                                       |   🟡   | per-visit "confidential from guardians"; age rules per jurisdiction ⏳  |
| Lab/radiology, billing, IT support roles                                               |   ⏳   |                                                                         |
| Purpose/consent and data-sensitivity in policy decisions                               |   🟡   | consent gates cross-facility referral; research consent recorded        |
| Periodic access review                                                                 |   🟡   | audit review UI and emergency-access reviews; formal recertification ⏳ |
| Cross-institution sharing only through an explicit arrangement                         |   ✅   | referrals: acceptance creates the care relationship                     |

## Patient portal (§2, §4)

| Requirement                                                           |  Status   |
| --------------------------------------------------------------------- | :-------: |
| Timeline of visits, medications, allergies (with verification status) |    ✅     |
| Released results only; source facility and dates shown                |    ✅     |
| Appointments (request / cancel)                                       |    ✅     |
| Correction requests that never silently overwrite clinician records   |    ✅     |
| "Who viewed my record" transparency                                   |    ✅     |
| Export of own record                                                  | ✅ (JSON) |
| Not an emergency channel (stated in UI)                               |    ✅     |
| Secure non-urgent messaging (not an emergency channel)                |    ✅     |
| Vaccination history, referrals, notifications, announcements          |    ✅     |
| Proxy / guardian access with "viewing as" switcher                    |    ✅     |
| Email notifications without health information; user preferences      |    ✅     |
| Consent settings, documents                                           |    ✅     |

## Clinical record integrity (§5)

| Requirement                                                              |               Status               |
| ------------------------------------------------------------------------ | :--------------------------------: |
| Author, effective time and recorded time on every clinical item          |                 ✅                 |
| Signed notes corrected through attributable addenda; originals preserved |          ✅ (DB trigger)           |
| Optimistic concurrency for clinical edits                                |        ✅ (encounter notes)        |
| Distinguish "no known allergies" / "unknown" / "not recorded"            |                 ✅                 |
| Patient-reported vs clinician-entered information distinguishable        |           ✅ (allergies)           |
| Duplicate identities go to human review, never auto-merged               |      ✅ (registration check)       |
| Merge/unmerge workflow with lineage                                      |                 ✅                 |
| Temporary identities (unidentified patients), newborn registration       |                 ✅                 |
| Coded values + original text; local code systems; versioned mappings     |   🟡 ICD-10 codes + description    |
| Version history for every clinical resource                              | 🟡 audit trail; full versioning ⏳ |

## Orders and results (§4)

| Requirement                                                             |        Status         |
| ----------------------------------------------------------------------- | :-------------------: |
| Result owner (ordering clinician), acknowledgement, release to patient  |          ✅           |
| Viewing ≠ acknowledgement; unacknowledged results stay on the worklist  |          ✅           |
| Preliminary / final / corrected states; preliminary cannot be released  |          ✅           |
| Director visibility of overdue follow-up                                | ✅ (exceptions panel) |
| Structured orders (LOINC catalogue, specimen, priority), order tracking |          ✅           |
| Critical results alert the ordering clinician (in-app, email, SMS)      |          ✅           |
| Backup result owners (cover) and timed escalation of critical results   |          ✅           |
| Amended results reopening review (superseded value kept and shown)      |          ✅           |
| LIS integration (HL7 v2 ORM/ORU, ACKs, idempotent, identity-matched)    |          ✅           |
| Mismatched results held for human review, never auto-filed              |          ✅           |
| Radiology orders, worklist and signed reports (RIS)                     |          ✅           |
| PACS / DICOMweb image viewing (authorised proxy, demo archive)          |          ✅           |

## Architecture & interoperability (§6)

| Requirement                                                                   |             Status             |
| ----------------------------------------------------------------------------- | :----------------------------: |
| Modular monolith with explicit domain modules                                 |               ✅               |
| Relational transactional store; transactions around record changes + audit    |               ✅               |
| MFA (TOTP + recovery codes), mandatory for staff                              |               ✅               |
| Passkeys (WebAuthn); managed identity provider / OIDC                         |      ✅ passkeys; OIDC ⏳      |
| Transactional event delivery (NOTIFY inside the transaction) for live updates |               ✅               |
| Durable outbox for email and SMS; integration message log                     |               ✅               |
| FHIR R4 export (Patient/$everything, ICD-10, LOINC/UCUM)                      | ✅ (validate partner profiles) |
| Encrypted document storage, type checks, ClamAV upload scanning               |               ✅               |

## Security, privacy and reporting (§7)

| Requirement                                                                 |       Status        |
| --------------------------------------------------------------------------- | :-----------------: |
| Director views scoped to own facility, aggregate by default                 |         ✅          |
| Ministry aggregate-only, small-cell suppression                             |         ✅          |
| Identifiable drill-down for the Ministry disabled                           | ✅ (does not exist) |
| Protected audit logs; minimal clinical content in diagnostic logs           |         ✅          |
| Transport security headers, no-store caching                                |         ✅          |
| Staff MFA; protected recovery (single-use codes, reset links)               |         ✅          |
| Purpose-specific reports with suppression and export controls               |  ✅ (audited CSV)   |
| Encryption at rest, KMS, environment separation                             |   ⏳ (deployment)   |
| Retention schedule, legal holds, data-subject requests, signed audit export |  ✅ (`PRIVACY.md`)  |

## Reliability and governance (§8)

| Requirement                                          |                                                Status                                                 |
| ---------------------------------------------------- | :---------------------------------------------------------------------------------------------------: |
| Health/readiness probes, graceful shutdown           |                                                  ✅                                                   |
| Metrics, alert rules and dashboards                  |                                       ✅ (`deploy/monitoring/`)                                       |
| Migrations tested against a fresh database in CI     |                                                  ✅                                                   |
| Encrypted backups with scripted restore verification |                                                  ✅                                                   |
| PITR (WAL archiving), downtime procedures            |                         ✅ scripted (pgBackRest, downtime kit); rehearsal ⏳                          |
| Hazard log, clinical safety case, release sign-off   |                          ✅ written (`CLINICAL-SAFETY.md`); CSO sign-off ⏳                           |
| WCAG 2.2 AA                                          | 🟡 automated axe audit clean on every page (`npm run a11y`); formal evaluation with screen readers ⏳ |

## Suggested next backlog (in order)

1. **Licensed drug knowledge base** replacing the demo interaction set and dose limits; review by a
   clinical pharmacist and the CSO.
2. **Rehearse** the downtime procedure and a point-in-time restore; agree recovery objectives.
3. SMTP relay with SPF/DKIM/DMARC; OIDC with the national identity provider (§7).
4. KMS-managed keys for the document store (object storage and versions are in place).
5. Jurisdiction-specific rules for adolescent confidentiality and consent age (B06).
6. Certified PACS viewer; HIS↔Fund contract validation; the approved paediatric (PEWS) chart.
7. **Validate the LIS interface with the real laboratory** (their HL7 v2 profile, MLLP bridge if
   needed) and RIS/PACS with the modalities (B07).
8. **FHIR profile validation** with a real partner (IPS) and inbound FHIR interfaces.
9. Independent penetration test; formal accessibility evaluation; clinical review of the Albanian
   and Serbian texts (B09–B10).

## Hospital modules (added)

| Module                                                                                    | Status                              |
| ----------------------------------------------------------------------------------------- | ----------------------------------- |
| Wards, beds, admissions, transfers, discharge summaries (signed, immutable)               | ✅                                  |
| Emergency department: arrivals, five-level triage with target times, live board           | ✅                                  |
| Births linked to the mother, temporary numbers, civil-registry confirmation               | ✅                                  |
| Unit-based access (only while the patient is in the unit), audited                        | ✅                                  |
| Partner API: scoped keys, purpose of use, consent-gated FHIR, OpenAPI                     | ✅                                  |
| Hospital reports: occupancy, length of stay, ED waiting times, births, imaging turnaround | ✅                                  |
| Operating theatres: booking, WHO surgical safety checklist, signed operation notes        | ✅                                  |
| Pharmacy stock: catalogue, batches/expiry, FEFO dispensing, alerts, national availability | ✅                                  |
| Online booking from consulting hours, reminders                                           | ✅                                  |
| National child vaccination calendar, reminders, coverage                                  | ✅ (calendar to verify with IKShPK) |
| Passkeys, session management, new-device alerts                                           | ✅                                  |
| Serbian interface                                                                         | ✅                                  |
| Medication safety: interactions, allergies, kidney, age, pregnancy, overrides             | ✅ (demo knowledge base)            |
| NEWS2 and paediatric PEWS early warning with escalation                                   | ✅ (PEWS thresholds illustrative)   |
| Blood bank and transfusion safety, haemovigilance                                         | ✅                                  |
| Hospital nutrition: diet orders, screening, kitchen lists                                 | ✅                                  |
| Billing, co-payments, Health Insurance Fund claims                                        | ✅ (demo tariff)                    |
| Notifiable disease surveillance and outbreak alerts                                       | ✅ (list to verify with IKShPK)     |
| Video consultations (WebRTC)                                                              | ✅                                  |
| Structured dosing and dose-range checks by age and weight                                 | ✅ (demo dose limits)               |
| Barcode medication administration, printed wristbands                                     | ✅                                  |
| Death registration (WHO MCCD), civil-registry notification, mortality statistics          | ✅                                  |
| Medical certificates (sick leave, fitness) with public QR verification                    | ✅                                  |
| Elective waiting lists, maximum waits, published waiting times                            | ✅ (waits to validate)              |
| Chronic disease registers, recalls, quality indicators                                    | ✅ (targets to confirm)             |
| Patient safety incident and near-miss reporting                                           | ✅                                  |
| Object storage for documents, document versions                                           | ✅                                  |
| Antenatal care: pregnancy record, visits, WHO contact schedule                            | ✅ (thresholds to confirm)          |
| Cancer screening programmes, invitations, coverage                                        | ✅ (protocols to confirm)           |
| National e-prescriptions for community pharmacies                                         | ✅                                  |
| Register of professional licences, enforced on clinical work                              | ✅                                  |
| Patient complaints and anonymous experience feedback                                      | ✅                                  |
| Organ donation registry, advance directives, DNACPR alerts                                | ✅                                  |
| Ambulance service: dispatch, pre-hospital record, ED pre-alert and handover               | ✅ (categories to confirm)          |
| Sepsis screening and the Sepsis Six bundle                                                | ✅ (thresholds to confirm)          |
| Infection prevention, HAI rates, reserve antibiotic approval                              | ✅                                  |
| Staff rosters, on-call, staffing ratios                                                   | ✅ (rules to confirm)               |
| Home care and community nursing                                                           | ✅                                  |
| Medical equipment register and maintenance                                                | ✅                                  |
| Load test and capacity baseline                                                           | ✅ (`docs/PERFORMANCE.md`)          |

## Open decisions (§10) — needed from the project sponsor

Hospital(s) and jurisdiction; first service and clinical owner; existing LIS/RIS/PACS/pharmacy
systems; record ownership and the legal basis for any Ministry reporting; languages (Albanian, Serbian and English are implemented) and accessibility needs; hosting, retention, recovery objectives and
out-of-hours support; who approves go-live.
