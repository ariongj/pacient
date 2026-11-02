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
| Purpose/consent and data-sensitivity in policy decisions                               |   ⏳   |                                                                         |
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
| Consent settings, documents                                           |    ⏳     |

## Clinical record integrity (§5)

| Requirement                                                              |               Status               |
| ------------------------------------------------------------------------ | :--------------------------------: |
| Author, effective time and recorded time on every clinical item          |                 ✅                 |
| Signed notes corrected through attributable addenda; originals preserved |          ✅ (DB trigger)           |
| Optimistic concurrency for clinical edits                                |        ✅ (encounter notes)        |
| Distinguish "no known allergies" / "unknown" / "not recorded"            |                 ✅                 |
| Patient-reported vs clinician-entered information distinguishable        |           ✅ (allergies)           |
| Duplicate identities go to human review, never auto-merged               |      ✅ (registration check)       |
| Merge/unmerge workflow, temporary identities, newborns                   |                 ⏳                 |
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
| Backup result owners / escalation when the owner is unavailable         |          ⏳           |
| Amended results reopening review (superseded value kept and shown)      |          ✅           |
| LIS integration (HL7 v2 ORM/ORU, ACKs, idempotent, identity-matched)    |          ✅           |
| Mismatched results held for human review, never auto-filed              |          ✅           |
| RIS/PACS integration (DICOMweb)                                         |          ⏳           |

## Architecture & interoperability (§6)

| Requirement                                                                   |             Status             |
| ----------------------------------------------------------------------------- | :----------------------------: |
| Modular monolith with explicit domain modules                                 |               ✅               |
| Relational transactional store; transactions around record changes + audit    |               ✅               |
| MFA (TOTP + recovery codes), mandatory for staff                              |               ✅               |
| Managed identity provider / OIDC, passkeys                                    |               ⏳               |
| Transactional event delivery (NOTIFY inside the transaction) for live updates |               ✅               |
| Durable outbox for email and SMS; integration message log                     |               ✅               |
| FHIR R4 export (Patient/$everything, ICD-10, LOINC/UCUM)                      | ✅ (validate partner profiles) |
| Private object store for documents, upload scanning                           |               ⏳               |

## Security, privacy and reporting (§7)

| Requirement                                                       |       Status        |
| ----------------------------------------------------------------- | :-----------------: |
| Director views scoped to own facility, aggregate by default       |         ✅          |
| Ministry aggregate-only, small-cell suppression                   |         ✅          |
| Identifiable drill-down for the Ministry disabled                 | ✅ (does not exist) |
| Protected audit logs; minimal clinical content in diagnostic logs |         ✅          |
| Transport security headers, no-store caching                      |         ✅          |
| Staff MFA; protected recovery (single-use codes, reset links)     |         ✅          |
| Purpose-specific reports with suppression and export controls     |  ✅ (audited CSV)   |
| Encryption at rest, KMS, environment separation                   |   ⏳ (deployment)   |

## Reliability and governance (§8)

| Requirement                                          |                                         Status                                          |
| ---------------------------------------------------- | :-------------------------------------------------------------------------------------: |
| Health/readiness probes, graceful shutdown           |                                           ✅                                            |
| Migrations tested against a fresh database in CI     |                                           ✅                                            |
| Encrypted backups with scripted restore verification |                                           ✅                                            |
| PITR (WAL archiving), downtime procedures            |                                     ⏳ (operations)                                     |
| Hazard log, clinical safety case, release sign-off   |                                     ⏳ (governance)                                     |
| WCAG 2.2 AA                                          | 🟡 designed for (labels, focus, non-colour status, keyboard tabs); formal evaluation ⏳ |

## Suggested next backlog (in order)

1. **Validated drug-interaction database** for pharmacy decision support; barcode administration.
2. SMTP relay with SPF/DKIM/DMARC; passkeys or OIDC (§7).
3. **Backup result owners** and timed escalation of unacknowledged critical results (B05).
4. **Consent records** and jurisdiction-specific rules for adolescent confidentiality (B06).
5. **Identity merge/unmerge** with lineage (B02).
6. **Validate the LIS interface with the real laboratory** (their HL7 v2 profile, MLLP bridge if
   needed) and add RIS/PACS (B07).
7. **FHIR profile validation** with a real partner (IPS) and inbound FHIR interfaces.
8. PITR and downtime rehearsal; accessibility evaluation; independent security review (B09–B10).

## Open decisions (§10) — needed from the project sponsor

Hospital(s) and jurisdiction; first service and clinical owner; existing LIS/RIS/PACS/pharmacy
systems; record ownership and the legal basis for any Ministry reporting; languages (Albanian /
Serbian / English UI) and accessibility needs; hosting, retention, recovery objectives and
out-of-hours support; who approves go-live.
