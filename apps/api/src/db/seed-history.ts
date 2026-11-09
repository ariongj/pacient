import { and, eq } from 'drizzle-orm';
import { AuditAction, audit } from '../modules/audit/audit.service.js';
import { db } from './client.js';
import { allergies, patients, prescriptions, users } from './schema.js';

/**
 * Synthetic demo data for record history (development only): a few attributed edits in the demo
 * patient's chart, so "History" shows who changed what. The versions themselves come from the
 * database trigger; each edit writes its audit entry in the same transaction, as the API does.
 */
export async function seedHistory(opts: {
  facilityId: string;
  demoDoctorId: string;
}): Promise<void> {
  const [arta] = await db
    .select({ id: patients.id })
    .from(patients)
    .where(eq(patients.email, 'patient@pacient.local'));
  if (!arta) return;
  const [nurse] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, 'nurse@pacient.local'));
  const doctor = {
    userId: opts.demoDoctorId,
    role: 'DOCTOR' as const,
    facilityId: opts.facilityId,
  };
  const nurseActor = nurse
    ? { userId: nurse.id, role: 'NURSE' as const, facilityId: opts.facilityId }
    : doctor;

  const [existing] = await db
    .select({ id: allergies.id })
    .from(allergies)
    .where(and(eq(allergies.patientId, arta.id), eq(allergies.substance, 'Ibuprofen')));
  if (existing) return;

  // A nurse records a reported allergy; the doctor confirms it and adds the reaction.
  const allergyId = await db.transaction(async (tx) => {
    const [a] = await tx
      .insert(allergies)
      .values({
        patientId: arta.id,
        substance: 'Ibuprofen',
        reaction: 'Urticarie',
        severity: 'MILD',
        verificationStatus: 'UNCONFIRMED',
        source: 'PATIENT_REPORTED',
        recordedById: nurseActor.userId,
      })
      .returning({ id: allergies.id });
    await audit(
      {
        action: AuditAction.CLINICAL_ENTRY_CREATED,
        actor: nurseActor,
        resourceType: 'allergy',
        resourceId: a!.id,
        patientId: arta.id,
      },
      tx,
    );
    return a!.id;
  });
  await db.transaction(async (tx) => {
    await tx
      .update(allergies)
      .set({
        verificationStatus: 'CONFIRMED',
        severity: 'MODERATE',
        reaction: 'Urticarie dhe ënjtje e buzëve',
      })
      .where(eq(allergies.id, allergyId));
    await audit(
      {
        action: AuditAction.CLINICAL_ENTRY_UPDATED,
        actor: doctor,
        resourceType: 'allergy',
        resourceId: allergyId,
        patientId: arta.id,
        metadata: { verificationStatus: 'CONFIRMED' },
      },
      tx,
    );
  });

  // The doctor adjusts the dose of one active medication.
  const [rx] = await db
    .select({ id: prescriptions.id, dosage: prescriptions.dosage })
    .from(prescriptions)
    .where(and(eq(prescriptions.patientId, arta.id), eq(prescriptions.status, 'ACTIVE')))
    .limit(1);
  if (!rx) return;
  await db.transaction(async (tx) => {
    await tx
      .update(prescriptions)
      .set({ instructions: 'Doza u rregullua pas kontrollit të tensionit në shtëpi' })
      .where(eq(prescriptions.id, rx.id));
    await audit(
      {
        action: AuditAction.CLINICAL_ENTRY_UPDATED,
        actor: doctor,
        resourceType: 'prescription',
        resourceId: rx.id,
        patientId: arta.id,
      },
      tx,
    );
  });
}
