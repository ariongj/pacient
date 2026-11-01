# Blueprint alignment

How this codebase maps to the _Hospital Information System Blueprint_. The blueprint recommends a
**foundation + controlled outpatient pilot** first; high-acuity modules (emergency department,
inpatient medication administration, theatre) stay on established systems until their own
readiness gates pass. This repository implements the foundation and the outpatient pilot scope.

Legend: ✅ implemented · 🟡 partial / foundation in place · ⏳ planned (later phase)

## Roles and permission model (§3)

| Requirement                                                                          | Status | Where                                      |
| ------------------------------------------------------------------------------------ | :----: | ------------------------------------------ |
| Default deny; contextual authorization enforced on the server                        |   ✅   | `modules/access/policy.ts`                 |
| Roles are responsibilities, not a ladder; director/ministry get no record access     |   ✅   | policy + `test/access-control.test.ts`     |
| Doctor access limited to assigned care                                               |   ✅   | `care_assignments`                         |
| Institution (tenant) isolation incl. search and break-glass                          |   ✅   | patients routes, policy                    |
| Break-glass: eligible clinicians, reason, short duration, review, never cross-tenant |   ✅   | `POST /patients/:id/emergency-access`      |
| Audit of reads, searches, changes, exports, denials, role changes, emergency access  |   ✅   | `modules/audit`                            |
| Prompt leaver revocation (blocks active sessions)                                    |   ✅   | staff status + per-request account check   |
| Patient, Doctor, Director (operations/clinical), Ministry roles                      |   ✅   |                                            |
| Nurse, pharmacist, lab/radiology, reception, billing, IT support, proxy/guardian     |   ⏳   | add roles + policy rules per workflow      |
| Purpose/consent and data-sensitivity in policy decisions                             |   ⏳   |                                            |
| Periodic access review                                                               |   🟡   | audit review UI; formal recertification ⏳ |

## Patient portal (§2, §4)

| Requirement                                                            |  Status   |
| ---------------------------------------------------------------------- | :-------: |
| Timeline of visits, medications, allergies (with verification status)  |    ✅     |
| Released results only; source facility and dates shown                 |    ✅     |
| Appointments (request / cancel)                                        |    ✅     |
| Correction requests that never silently overwrite clinician records    |    ✅     |
| "Who viewed my record" transparency                                    |    ✅     |
| Export of own record                                                   | ✅ (JSON) |
| Not an emergency channel (stated in UI)                                |    ✅     |
| Proxy / guardian access, consent settings, secure messaging, documents |    ⏳     |

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

| Requirement                                                              |        Status         |
| ------------------------------------------------------------------------ | :-------------------: |
| Result owner (ordering clinician), acknowledgement, release to patient   |          ✅           |
| Viewing ≠ acknowledgement; unacknowledged results stay on the worklist   |          ✅           |
| Preliminary / final / corrected states; preliminary cannot be released   |          ✅           |
| Director visibility of overdue follow-up                                 | ✅ (exceptions panel) |
| Structured orders, specimens, critical-result escalation & backup owners |          ⏳           |
| Amended results reopening review                                         |          ⏳           |
| LIS/RIS/PACS integration (HL7 v2, DICOMweb)                              |          ⏳           |

## Architecture & interoperability (§6)

| Requirement                                                                | Status |
| -------------------------------------------------------------------------- | :----: |
| Modular monolith with explicit domain modules                              |   ✅   |
| Relational transactional store; transactions around record changes + audit |   ✅   |
| Managed identity provider / OIDC, MFA                                      |   ⏳   |
| Transactional outbox + durable queue for integrations                      |   ⏳   |
| FHIR R4 mapping / export profiles                                          |   ⏳   |
| Private object store for documents, upload scanning                        |   ⏳   |

## Security, privacy and reporting (§7)

| Requirement                                                       |       Status        |
| ----------------------------------------------------------------- | :-----------------: |
| Director views scoped to own facility, aggregate by default       |         ✅          |
| Ministry aggregate-only, small-cell suppression                   |         ✅          |
| Identifiable drill-down for the Ministry disabled                 | ✅ (does not exist) |
| Protected audit logs; minimal clinical content in diagnostic logs |         ✅          |
| Transport security headers, no-store caching                      |         ✅          |
| MFA, encryption at rest, KMS, environment separation              |   ⏳ (deployment)   |

## Reliability and governance (§8)

| Requirement                                           |                                         Status                                          |
| ----------------------------------------------------- | :-------------------------------------------------------------------------------------: |
| Health/readiness probes, graceful shutdown            |                                           ✅                                            |
| Migrations tested against a fresh database in CI      |                                           ✅                                            |
| Backups, PITR, restore rehearsal, downtime procedures |                                     ⏳ (operations)                                     |
| Hazard log, clinical safety case, release sign-off    |                                     ⏳ (governance)                                     |
| WCAG 2.2 AA                                           | 🟡 designed for (labels, focus, non-colour status, keyboard tabs); formal evaluation ⏳ |

## Suggested next backlog (in order)

1. **Staff MFA via OIDC** (B03/§7) — blocker for any real deployment.
2. **Nurse and reception roles** with policy tests (B03).
3. **Structured orders and critical-result escalation** with backup owners (B05).
4. **Proxy/guardian access** and consent records (B06).
5. **Identity merge/unmerge** with lineage (B02).
6. **Transactional outbox** and one validated integration (e.g. LIS results via HL7 v2) (B07).
7. **FHIR R4 export** (Patient, Encounter, Condition, MedicationRequest, AllergyIntolerance,
   Observation) for portability and exchange.
8. Backup/restore and downtime rehearsal; accessibility evaluation; independent security review (B09–B10).

## Open decisions (§10) — needed from the project sponsor

Hospital(s) and jurisdiction; first service and clinical owner; existing LIS/RIS/PACS/pharmacy
systems; record ownership and the legal basis for any Ministry reporting; languages (Albanian /
Serbian / English UI) and accessibility needs; hosting, retention, recovery objectives and
out-of-hours support; who approves go-live.
