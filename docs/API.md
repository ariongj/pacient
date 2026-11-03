# Pacient API – developer guide

Every part of Pacient (patient portal, clinics, wards, emergency department, laboratory,
radiology, reporting) works on **one PostgreSQL database behind one API**. External systems never
receive database access: they use the same API, with their own credentials, scopes and audit trail.

- Base URL: `https://<host>/api/v1`
- Machine-readable description: `GET /api/v1/partner/openapi.json` (OpenAPI 3.1, public, contains
  no data). The web app renders it under **API documentation** (`/developers`).
- FHIR: HL7 FHIR R4 (JSON, `application/fhir+json`).

## Authentication

| Caller                                                                | Credential                                                                                     | Issued by                              |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------- |
| Staff and patients (web app, mobile apps acting for a signed-in user) | `Authorization: Bearer <access token>` from `POST /auth/login` (15 minutes; refresh by cookie) | the user signs in (two-step for staff) |
| Laboratory information systems                                        | `Authorization: Bearer pk_…` laboratory key                                                    | facility director (_Lab connections_)  |
| Partner systems                                                       | `Authorization: Bearer pk_…` partner key with scopes                                           | Ministry of Health (_Partner systems_) |

Keys are shown once when created, stored only as a SHA-256 hash, can be restricted to IP
addresses and revoked at any time (effective immediately).

## Partner scopes

| Scope               | Endpoints                                                                              | Typical partner                    |
| ------------------- | -------------------------------------------------------------------------------------- | ---------------------------------- |
| `fhir.patient.read` | `GET /partner/fhir/Patient?identifier=…`, `GET /partner/fhir/Patient/{id}/$everything` | other hospitals' EHRs, insurance   |
| `stats.read`        | `GET /partner/stats/national`                                                          | public health institute, insurance |
| `directory.read`    | `GET /partner/directory/facilities`, `GET /partner/directory/practitioners`            | public health, booking platforms   |
| `births.notify`     | `GET /partner/births?since=…`, `POST /partner/births/{birthId}/registration`           | civil registry                     |

`GET /partner/ping` returns the key's name and scopes.

### Purpose of use (patient data)

Patient endpoints require `X-Purpose-Of-Use`. You receive only what the purpose needs:

| Purpose         | Content                                                                                                                             |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `TREATMENT`     | The record as the patient sees it: signed notes, released results, never confidential visits. Requires `X-Requesting-Practitioner`. |
| `PAYMENT`       | Patient identification, visits/hospital stays/emergency attendances with dates, diagnosis codes. No notes or results.               |
| `PUBLIC_HEALTH` | Identification, diagnoses, vaccinations and released laboratory results.                                                            |

### Consent

If the patient has withdrawn consent to sharing their record with other organisations
(_Privacy & consent_ in the portal), patient endpoints answer `403 CONSENT_WITHDRAWN` – for both
search and `$everything`. The refusal is audited.

### Audit and transparency

Every partner call – allowed or refused – is written to the append-only audit log with the
client, scope, purpose, practitioner and patient. Patients see partner accesses to their record in
_Who viewed my record_; the Ministry sees usage per partner (`GET /partner/clients/{id}/usage`).

## Examples

Find a patient (minimal identification, no contact details):

```bash
curl -H "Authorization: Bearer $PACIENT_KEY" \
     -H "X-Purpose-Of-Use: PAYMENT" \
     "https://<host>/api/v1/partner/fhir/Patient?identifier=urn:pacient:national-id|1234567890"
```

Record for treatment:

```bash
curl -H "Authorization: Bearer $PACIENT_KEY" \
     -H "X-Purpose-Of-Use: TREATMENT" \
     -H "X-Requesting-Practitioner: Dr. Name Surname (licence 12345)" \
     "https://<host>/api/v1/partner/fhir/Patient/<id>/\$everything"
```

The bundle can contain Patient, Organization, Practitioner, Encounter (outpatient `AMB`, inpatient
`IMP` with ward/bed and discharge disposition, emergency `EMER` with triage priority), Condition
(ICD-10), MedicationRequest, MedicationAdministration, AllergyIntolerance, Observation (vital signs
and laboratory results with LOINC/UCUM; for newborns birth weight `8339-4` and Apgar `9272-6`,
`9274-2`, `9271-8`), Immunization, ServiceRequest and DiagnosticReport (imaging; reports only once
released to the patient), DocumentReference and RelatedPerson (a newborn's mother). Records with a
temporary identity (newborns, unidentified patients) carry
`identifier.use = temp` with system `urn:pacient:temporary-id`.

## Civil registry flow

1. A birth is registered at the hospital; the newborn gets a record with a temporary number.
2. The civil registry polls `GET /partner/births?since=<last poll>` (births whose newborn still has
   a temporary identity, with the mother's national ID and name, sex, birth order and facility).
3. When the national number is issued it calls
   `POST /partner/births/{birthId}/registration` with `{ "nationalId": "1234567890", "firstName": "Lira" }`.
   The newborn's record takes the real identity; the mother, as guardian, sees it in the portal.
4. If the number already belongs to another record the answer is `409 IDENTITY_EXISTS` and nothing
   changes – the facility director merges the two records.

## Errors

```json
{ "error": { "code": "CONSENT_WITHDRAWN", "message": "…", "details": {} } }
```

| Status | Codes (examples)                                                        |
| ------ | ----------------------------------------------------------------------- |
| 400    | `BAD_REQUEST` (validation), `PURPOSE_REQUIRED`, `PRACTITIONER_REQUIRED` |
| 401    | invalid, unknown or revoked key                                         |
| 403    | `SCOPE_REQUIRED`, `CONSENT_WITHDRAWN`, `IP_NOT_ALLOWED`                 |
| 404    | patient or birth not found                                              |
| 409    | `PATIENT_MERGED` (see `details.mergedIntoId`), `IDENTITY_EXISTS`        |
| 429    | rate limit                                                              |

## Rate limits

300 requests per minute per partner key (in addition to the general API limit). Answer `429` with
a `RateLimit` header (draft-8).

## Versioning

The API is versioned in the path (`/api/v1`). Additive changes (new fields, endpoints or FHIR
resources) are made within v1; breaking changes get a new version, announced to registered partners
with a transition period.

## Privacy commitments

- No direct database access, exports or bulk downloads of identifiable data for partners.
- Minimum necessary content per purpose; confidential visits and unreleased results are never
  shared.
- The patient's consent decision is honoured on every call.
- Every access is audited, retained in the append-only audit log and visible to the patient.

## Demo keys (development seed only)

| Partner                              | Scopes                            | Key                                                 |
| ------------------------------------ | --------------------------------- | --------------------------------------------------- |
| Fondi i Sigurimit Shëndetësor (demo) | `fhir.patient.read`, `stats.read` | `pk_dev_hif_demo_key_not_for_production`            |
| Agjencia e Regjistrimit Civil (demo) | `births.notify`                   | `pk_dev_civil_registry_demo_key_not_for_production` |

These keys exist only in databases loaded with `npm run db:seed`, which refuses to run in
production.
