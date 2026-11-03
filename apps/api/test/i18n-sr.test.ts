import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '../src/db/client.js';
import { notifications } from '../src/db/schema.js';
import { tr } from '../src/i18n/index.js';
import { notifyUsers } from '../src/modules/notifications/notifications.service.js';
import { api, bearer, createUser, login } from './helpers.js';

describe('Serbian (sr)', () => {
  it('can be chosen as the profile language', async () => {
    const u = await createUser('PATIENT');
    const token = await login(u.email);
    const res = await api()
      .patch('/api/v1/auth/me/preferences')
      .set(bearer(token))
      .send({ locale: 'sr' });
    expect(res.status).toBe(200);
    expect((await api().get('/api/v1/auth/me').set(bearer(token))).body.locale).toBe('sr');
  });

  it('delivers notifications in Serbian to Serbian-speaking users', async () => {
    const u = await createUser('PATIENT', null, { locale: 'sr' });
    await notifyUsers([u.id], { type: 'RESULT', title: 'A new test result is available' });
    const rows = await db.select().from(notifications).where(eq(notifications.userId, u.id));
    expect(rows.map((r) => r.title)).toContain('Dostupan je novi rezultat analize');
  });

  it('fills placeholders in Serbian texts', () => {
    expect(tr('sr', '{title} (family member)', { title: 'X' })).toBe('X (član porodice)');
  });
});
