import { and, eq, inArray, ne } from 'drizzle-orm';
import { hashPassword } from '../lib/password.js';
import { newReference } from '../modules/support/support.service.js';
import { db } from './client.js';
import { supportTickets, users } from './schema.js';

const HOUR = 3_600_000;

/**
 * Synthetic demo data for IT support (development only): it@pacient.local at the demo facility,
 * open requests (one waiting for the director's approval), a locked account and a month of
 * resolved requests – plus a few at other facilities for the Ministry's counts.
 */
export async function seedSupport(opts: { facilityId: string; demoDoctorId: string }) {
  const [existing] = await db.select().from(users).where(eq(users.email, 'it@pacient.local'));
  if (existing) return;
  const [it] = await db
    .insert(users)
    .values({
      email: 'it@pacient.local',
      fullName: 'Labinot Gashi',
      role: 'IT_SUPPORT',
      facilityId: opts.facilityId,
      passwordHash: await hashPassword('Pacient-Demo-2026'),
      passwordChangedAt: new Date(),
    })
    .returning();

  const staff = await db
    .select({ id: users.id, email: users.email, role: users.role, facilityId: users.facilityId })
    .from(users)
    .where(
      and(
        inArray(users.role, ['DOCTOR', 'NURSE', 'PHARMACIST', 'RECEPTION', 'DIRECTOR']),
        ne(users.id, it!.id),
      ),
    );
  const here = staff.filter((s) => s.facilityId === opts.facilityId);
  const byEmail = (email: string) => here.find((s) => s.email === email);
  const nurse = byEmail('nurse@pacient.local') ?? here.find((s) => s.role === 'NURSE');
  const reception = byEmail('reception@pacient.local') ?? here.find((s) => s.role === 'RECEPTION');
  const pharmacist = here.find((s) => s.role === 'PHARMACIST');
  const otherDoctor = here.find((s) => s.role === 'DOCTOR' && s.id !== opts.demoDoctorId);
  const director = byEmail('director@pacient.local') ?? here.find((s) => s.role === 'DIRECTOR');
  if (!nurse || !reception || !otherDoctor || !director) return;

  // A colleague locked out after too many attempts (IT support unlocks).
  await db
    .update(users)
    .set({ lockedUntil: new Date(Date.now() + 10 * 60_000), failedLoginAttempts: 5 })
    .where(eq(users.id, otherDoctor.id));

  const ago = (h: number) => new Date(Date.now() - h * HOUR);
  const base = { facilityId: opts.facilityId };
  await db.insert(supportTickets).values([
    {
      ...base,
      reference: newReference(),
      requesterId: opts.demoDoctorId,
      subjectUserId: otherDoctor.id,
      kind: 'ACCOUNT_LOCKED',
      description: 'Kolegu im nuk mund të kyçet pas disa përpjekjeve – llogaria duket e bllokuar.',
      createdAt: ago(0.3),
    },
    {
      ...base,
      reference: newReference(),
      requesterId: nurse.id,
      subjectUserId: nurse.id,
      kind: 'MFA_RESET',
      description: 'Humba telefonin me aplikacionin e verifikimit me dy hapa.',
      status: 'AWAITING_APPROVAL',
      assignedToId: it!.id,
      createdAt: ago(3),
    },
    {
      ...base,
      reference: newReference(),
      requesterId: reception.id,
      subjectUserId: reception.id,
      kind: 'DEVICE',
      description: 'Printeri i etiketave në recepsion nuk printon.',
      status: 'IN_PROGRESS',
      assignedToId: it!.id,
      createdAt: ago(20),
    },
    {
      ...base,
      reference: newReference(),
      requesterId: director.id,
      subjectUserId: pharmacist?.id ?? nurse.id,
      kind: 'ACCESS_CHANGE',
      description: 'Farmacisti kalon në farmacinë e spitalit nga java e ardhshme.',
      createdAt: ago(28),
    },
    // Resolved during the last month (for the counts and median time).
    ...Array.from({ length: 9 }, (_, i) => {
      const created = ago(24 * (2 + i * 3));
      const kinds = ['PASSWORD_RESET', 'ACCOUNT_LOCKED', 'DEVICE', 'OTHER'] as const;
      return {
        ...base,
        reference: newReference(),
        requesterId: here[i % here.length]!.id,
        subjectUserId: here[i % here.length]!.id,
        kind: kinds[i % kinds.length]!,
        description: 'Kërkesë e zgjidhur (shembull).',
        status: 'RESOLVED' as const,
        assignedToId: it!.id,
        resolution: 'U zgjidh.',
        createdAt: created,
        resolvedAt: new Date(created.getTime() + (1 + (i % 5) * 3) * HOUR),
      };
    }),
  ]);

  // Other facilities (no content is shown to the Ministry, only counts).
  const elsewhere = staff.filter((s) => s.facilityId && s.facilityId !== opts.facilityId);
  for (const [i, s] of elsewhere.slice(0, 6).entries()) {
    await db.insert(supportTickets).values({
      facilityId: s.facilityId,
      reference: newReference(),
      requesterId: s.id,
      subjectUserId: s.id,
      kind: i % 2 ? 'PASSWORD_RESET' : 'OTHER',
      description: 'Kërkesë shembull.',
      status: i % 3 === 0 ? 'RESOLVED' : 'OPEN',
      resolution: i % 3 === 0 ? 'U zgjidh.' : null,
      createdAt: ago(24 * (i + 1)),
      resolvedAt: i % 3 === 0 ? ago(24 * (i + 1) - 4) : null,
    });
  }
}
