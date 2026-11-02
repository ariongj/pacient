import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../src/db/client.js';
import { notifications, users } from '../src/db/schema.js';
import { tr } from '../src/i18n/index.js';
import { createInvitedUser } from '../src/modules/auth/invitations.js';
import { processOutboxOnce } from '../src/modules/email/outbox.js';
import { sentEmails } from '../src/modules/email/transport.js';
import { notifyUsers } from '../src/modules/notifications/notifications.service.js';
import { processSmsOnce } from '../src/modules/sms/outbox.js';
import { sentSms } from '../src/modules/sms/transport.js';
import { api, bearer, createUser, login } from './helpers.js';

async function drain() {
  while ((await processOutboxOnce()) > 0 || (await processSmsOnce()) > 0) {
    /* deliver everything due */
  }
}
const titlesOf = async (userId: string) =>
  (await db.select().from(notifications).where(eq(notifications.userId, userId))).map(
    (n) => n.title,
  );

let en: Awaited<ReturnType<typeof createUser>>;
let sq: Awaited<ReturnType<typeof createUser>>;
beforeAll(async () => {
  en = await createUser('PATIENT', null, { emailNotifications: 'ALL' });
  sq = await createUser('PATIENT', null, {
    locale: 'sq',
    emailNotifications: 'ALL',
    phone: '+38344123987',
    phoneVerifiedAt: new Date(),
    smsNotifications: 'IMPORTANT',
  });
});

describe('language preference', () => {
  it('is saved on the profile and returned by /auth/me', async () => {
    const token = await login(sq.email);
    expect((await api().get('/api/v1/auth/me').set(bearer(token))).body.locale).toBe('sq');
    const changed = await api()
      .patch('/api/v1/auth/me/preferences')
      .set(bearer(token))
      .send({ locale: 'en' });
    expect(changed.status).toBe(200);
    expect((await api().get('/api/v1/auth/me').set(bearer(token))).body.locale).toBe('en');
    const bad = await api()
      .patch('/api/v1/auth/me/preferences')
      .set(bearer(token))
      .send({ locale: 'de' });
    expect(bad.status).toBe(400);
    await api().patch('/api/v1/auth/me/preferences').set(bearer(token)).send({ locale: 'sq' });
  });
});

describe('messages in the recipient’s language', () => {
  it('translates one notification per recipient, with values and wrappers', async () => {
    await notifyUsers([en.id, sq.id], {
      type: 'test',
      title: 'A new test result is available',
      important: true,
      link: '/portal/results',
    });
    expect(await titlesOf(en.id)).toContain('A new test result is available');
    expect(await titlesOf(sq.id)).toContain('Një rezultat i ri analize është i disponueshëm');

    const from = new Date('2026-11-05T13:30:00Z');
    await notifyUsers([en.id, sq.id], {
      type: 'cover',
      title: 'You are covering results for {doctor} from {from} to {to}',
      vars: { doctor: 'Dr. Test', from, to: new Date('2026-11-07T13:30:00Z') },
      wrap: [{ text: '{title} (family member)' }],
    });
    expect(await titlesOf(en.id)).toContain(
      'You are covering results for Dr. Test from 05 Nov, 14:30 to 07 Nov, 14:30 (family member)',
    );
    const sqTitles = await titlesOf(sq.id);
    expect(
      sqTitles.some((t) => t.startsWith('Ju zëvendësoni Dr. Test për rezultatet nga 05')),
    ).toBe(true);
    expect(sqTitles.some((t) => t.endsWith('(anëtar i familjes)'))).toBe(true);
  });

  it('writes notification emails and SMS in the recipient’s language, without health details', async () => {
    await notifyUsers([en.id, sq.id], {
      type: 'pharmacy',
      title: 'Your medication is ready at the pharmacy',
      important: true,
      link: '/portal',
    });
    await drain();
    const enMail = sentEmails.find((m) => m.to === en.email && m.subject.includes('medication'))!;
    const sqMail = sentEmails.find((m) => m.to === sq.email && m.subject.includes('Barnat'))!;
    expect(enMail.subject).toBe('Pacient: Your medication is ready at the pharmacy');
    expect(enMail.html).toContain('<html lang="en">');
    expect(sqMail.subject).toBe('Pacient: Barnat tuaja janë gati në farmaci');
    expect(sqMail.text).toContain('Përshëndetje');
    expect(sqMail.text).toContain('Kyçuni në Pacient për të parë hollësitë.');
    expect(sqMail.html).toContain('<html lang="sq">');
    expect(sqMail.html).toContain('Hap Pacient');

    expect(sentSms.filter((m) => m.to === '+38344123987').map((m) => m.body)).toContain(
      'Pacient: Barnat tuaja janë gati në farmaci. Kyçuni për ta parë.',
    );
  });

  it('sends the phone verification code in the account’s language', async () => {
    const u = await createUser('PATIENT', null, { locale: 'sq' });
    const token = await login(u.email);
    expect(
      (await api().post('/api/v1/auth/me/phone').set(bearer(token)).send({ phone: '044 321 654' }))
        .status,
    ).toBe(202);
    await drain();
    const sms = sentSms.filter((m) => m.to === '+38344321654').at(-1)!;
    expect(sms.body).toMatch(/^Kodi i verifikimit Pacient: \d{6}\. Skadon pas 10 minutash\./);
  });

  it('writes activation emails in the invited account’s language', async () => {
    const inviter = await createUser('MINISTRY', null, { locale: 'sq' });
    const email = `invited-${Date.now()}@test.local`;
    await db.transaction((tx) =>
      createInvitedUser(
        tx,
        { email, fullName: 'Ardit Hoxha', role: 'PATIENT', facilityId: null },
        inviter.id,
      ),
    );
    const [created] = await db.select().from(users).where(eq(users.email, email));
    expect(created!.locale).toBe('sq'); // inherits the inviter's language
    await drain();
    const mail = sentEmails.filter((m) => m.to === email).at(-1)!;
    expect(mail.subject).toBe('Aktivizoni llogarinë tuaj në Pacient');
    expect(mail.text).toContain('Përshëndetje Ardit Hoxha,');
    expect(mail.html).toContain('Zgjidhni fjalëkalimin');

    const englishEmail = `invited-en-${Date.now()}@test.local`;
    await db.transaction((tx) =>
      createInvitedUser(
        tx,
        {
          email: englishEmail,
          fullName: 'Jane Doe',
          role: 'PATIENT',
          facilityId: null,
          locale: 'en',
        },
        inviter.id,
      ),
    );
    await drain();
    expect(sentEmails.filter((m) => m.to === englishEmail).at(-1)!.subject).toBe(
      'Activate your Pacient account',
    );
  });

  it('falls back to English for texts without a translation', () => {
    expect(tr('sq', 'Something not yet translated {x}', { x: 1 })).toBe(
      'Something not yet translated 1',
    );
  });
});
