# Downtime procedures (business continuity)

How a facility keeps caring for patients safely when Pacient is unavailable – planned
maintenance, a network failure, a server or database outage – and how records are completed
afterwards. This closes the procedural part of hazard **H42** in [CLINICAL-SAFETY.md](CLINICAL-SAFETY.md);
the technical set-up (pack encryption, ward PC sync, point-in-time recovery) is in
[deploy/README.md](../deploy/README.md#downtime-and-point-in-time-recovery).

Principles:

1. **Patient care never waits for the system.** When in doubt, switch to paper.
2. **Paper is the record during downtime.** Everything done is written down with the real time.
3. **Afterwards everything is entered** with the time it actually happened and marked as back-entered.
4. Downtime packs contain confidential information: they stay inside the facility and are
   shredded after use.

## What exists in the system

| Tool                       | What it does                                                                                                                                                                                                                                                                                                                                                                |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Downtime pack** (hourly) | One printable document per facility: per ward and bed the patient's name, national ID or temporary number, date of birth, attending doctor, allergies, active medicines with dose and the **times due in the next 12 hours**, last observations with NEWS2/PEWS, diet and nil-by-mouth, blood group; the ED board; today's operating list; today's outpatient appointments. |
| **Ward downtime PC**       | A locked-down facility computer per ward (or per floor) that downloads the newest encrypted pack every hour (`scripts/downtime-sync.mjs`) and can open and print it without the network.                                                                                                                                                                                    |
| **Downtime kit page**      | `/downtime` – status, pack list and download (director, doctors, nurses, reception), _Generate now_ and _Start/End downtime procedures_ (director), back-entry checklist (director, doctors, nurses).                                                                                                                                                                       |
| **Downtime banner**        | While the director has declared downtime, every staff member of the facility sees a red banner: _"Downtime procedures in effect – record on paper; back-enter afterwards"_. The system keeps working – this is an instruction, not a lock (useful for partial outages, e.g. lab interface down, slow network).                                                              |
| **Point-in-time recovery** | The database can be restored to any minute of the last 1–2 weeks (pgBackRest), plus nightly encrypted dumps.                                                                                                                                                                                                                                                                |

Not in the pack by design: DNR/resuscitation decisions and free-text clinical notes are not stored
in a structured form in Pacient and are **not** printed – they stay in the paper file / on the
ward's resuscitation status board.

## Roles

| Role                                      | Responsibility                                                                                                                                                                       |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Facility director** (or deputy on call) | Declares and ends downtime in the system (or by phone/PA if the system is down), informs heads of departments, decides when back-entry is complete, reviews the incident afterwards. |
| **IT on call**                            | Diagnoses the outage, estimates the duration, keeps the director updated (every 30 min), performs recovery (incl. point-in-time restore when decided), confirms the system is back.  |
| **Nurse in charge of each ward**          | Opens and prints the ward's pack, hands out paper charts, makes sure every dose and observation is written down, leads back-entry for the ward.                                      |
| **Doctors**                               | Prescribe on paper medicine charts, write requests (lab, imaging) on paper forms, review the back-entered record of their patients.                                                  |
| **Pharmacy**                              | Dispenses against paper prescriptions; keeps copies for back-entry.                                                                                                                  |
| **Reception / ED registration**           | Registers new arrivals on paper with a paper temporary number sequence; uses the appointment list from the pack.                                                                     |

## Before an outage (always, as routine)

- [ ] Each ward has a working downtime PC (or a shared one per floor) and a printer **not** on the
      same network segment that may fail; the PC shows a pack less than 90 minutes old
      (`downtime-sync.mjs check`, monitored by IT).
- [ ] Paper stock on every ward: medicine administration charts, observation charts with NEWS2/PEWS,
      fluid balance, lab/imaging request forms, admission and ED registration forms, a numbered
      sheet of temporary patient numbers (e.g. `DT-<ward>-001…`).
- [ ] The ward's downtime folder: this procedure, contact numbers (IT on call, director,
      laboratory, pharmacy, blood bank), the location of the downtime PC and printer.
- [ ] Planned maintenance: the director announces it 24 h ahead; one hour before, IT generates a
      fresh pack (_Generate now_) and the director starts downtime procedures at the agreed time.

## During downtime

1. **Declare it.** The director (or the deputy) presses _Start downtime procedures_ with a short
   note (reason, expected end, no patient data) – staff are notified and see the red banner. If
   the system is completely down, announce by phone/PA and log the start time on paper.
2. **Print.** Each ward opens the newest pack on its downtime PC (`downtime-sync.mjs open`) and
   prints its ward page, the ED board (ED) or the operating list (theatres). The pack can be up to
   one hour old: **check identity (wristband) and allergies with the patient**, and check the paper
   chart for anything given since the pack's time ("last given" is printed per medicine).
3. **Record on paper**, always with date, time and signature:
   - every medicine given, withheld or refused (paper medicine chart, using the due times from the
     pack as the schedule);
   - every set of observations and the NEWS2/PEWS score calculated by hand; escalate by phone as
     usual;
   - new admissions, transfers, discharges and ED arrivals (temporary numbers from the sheet);
   - lab and imaging requests on paper forms; results by phone are written down and read back.
4. **Blood transfusion**: follow the paper transfusion protocol with two-person bedside checks;
   the blood bank issues against the paper request.
5. **Every 2 hours** IT reports progress; for an outage longer than 4 hours the director decides
   whether to generate packs from a recovered/standby system or to continue on paper only.

## After downtime

1. IT confirms the system is back (and, if a point-in-time restore was done, **from which time
   data must be re-entered**).
2. The director presses _End downtime_ – staff are notified to back-enter.
3. **Back-entry** (nurse in charge organises, within the same shift when possible):
   - Open **Downtime kit → Back-entry checklist**. It lists every patient on the facility's wards
     during the downtime with the number of medicine administrations and observations entered for
     that period, and how many were back-entered.
   - Enter each paper record in the patient's chart **with the time it actually happened**:
     - Medicine administrations: the MAR accepts the real administration time
       (`administeredAt`); add the note **"Back-entered after downtime"**. Entries recorded more
       than 15 minutes after their administration time are counted as back-entered on the
       checklist.
     - Observations: enter them with their real time and the same note. _Note:_ the observations
       form currently records the time of entry; until it accepts an earlier time, write the real
       time in the note field.
     - Patients registered with temporary numbers: register them and merge with existing records
       through the usual duplicate-record process.
   - Paper prescriptions written during downtime are re-entered by the prescriber.
4. Paper charts are filed with the patient's record; printed packs are **shredded**.
5. The director closes the event: duration, what worked, what did not; incidents (for example a
   missed dose) are reported through the incident route and reviewed by the clinical safety officer.

## Recovery objectives

| Objective                                         | Target                                                                               |
| ------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Recovery point objective (data that may be lost)  | ≤ 1 minute with WAL archiving (`archive_timeout=60`); ≤ 24 h with nightly dumps only |
| Recovery time objective (restore of the database) | ≤ 1 hour (measured in the rehearsal; depends on size)                                |
| Information available on paper                    | Within 15 minutes of an outage, from packs no older than 1 hour                      |

## Testing schedule

| When                      | Test                                                                                                                                | Who                           |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| Continuously              | `pitr.sh check` every 30 min (WAL archiving), `downtime-sync.mjs check` on every ward PC (pack age), API health monitoring          | IT (automatic alerts)         |
| Weekly                    | Each ward opens the newest pack on its downtime PC and checks it shows today's patients; printer test page                          | Nurse in charge               |
| Monthly                   | `pitr.sh verify-restore` to a random time of the last week and `deploy/restore-verify.sh` on the latest dump; record duration (RTO) | IT                            |
| Every 6 months            | Downtime drill on one ward/department: 1 hour on paper with the pack, then back-entry with the checklist; review findings           | Director, nurse in charge, IT |
| Yearly                    | Full simulated outage of the facility including a live point-in-time restore on a standby environment; review this document         | Director, IT, CSO             |
| After every real downtime | Debrief within a week; update this procedure                                                                                        | Director                      |
