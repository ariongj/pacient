import { beforeAll, describe, expect, it } from 'vitest';
import { normalizePhone } from '../src/lib/phone.js';
import { inQuietHours, nextSendTime, processSmsOnce } from '../src/modules/sms/outbox.js';
import { sentSms } from '../src/modules/sms/transport.js';
import { api, bearer, createUser, createWorld, login } from './helpers.js';

let w: Awaited<ReturnType<typeof createWorld>>;
beforeAll(async () => {
  w = await createWorld();
});

async function drain() {
  while ((await processSmsOnce()) > 0) {
    /* deliver everything due */
  }
}
const smsTo = (phone: string) => sentSms.filter((m) => m.to === phone);

async function verifyPhone(token: string, input: string, e164: string) {
  const req = await api().post('/api/v1/auth/me/phone').set(bearer(token)).send({ phone: input });
  expect(req.status).toBe(202);
  await drain();
  const code = smsTo(e164).at(-1)!.body.match(/\d{6}/)![0];
  return { req, code };
}

describe('phone numbers', () => {
  it('normalises local and international formats to E.164', () => {
    expect(normalizePhone('044 123 456')).toBe('+38344123456');
    expect(normalizePhone('00383 49 555 666')).toBe('+38349555666');
    expect(normalizePhone('+49 (151) 2345-6789')).toBe('+4915123456789');
    expect(normalizePhone('12')).toBeNull();
    expect(normalizePhone('call me')).toBeNull();
  });

  it('verifies ownership with a code before enabling SMS', async () => {
    const { req, code } = await verifyPhone(w.tokens.patient, '044 700 801', '+38344700801');
    expect(req.body.phone).toBe('+383 •••• 801');
    const wrong = await api()
      .post('/api/v1/auth/me/phone/verify')
      .set(bearer(w.tokens.patient))
      .send({ code: code === '000000' ? '111111' : '000000' });
    expect(wrong.status).toBe(400);
    const ok = await api()
      .post('/api/v1/auth/me/phone/verify')
      .set(bearer(w.tokens.patient))
      .send({ code });
    expect(ok.status).toBe(200);
    const me = await api().get('/api/v1/auth/me').set(bearer(w.tokens.patient));
    expect(me.body).toMatchObject({ phone: '+383 •••• 801', smsNotifications: 'IMPORTANT' });
  });

  it('refuses SMS without a verified number, and limits code requests', async () => {
    const u = await createUser('PATIENT');
    const t = await login(u.email);
    const pref = await api()
      .patch('/api/v1/auth/me/preferences')
      .set(bearer(t))
      .send({ smsNotifications: 'IMPORTANT' });
    expect(pref.status).toBe(400);
    for (let i = 0; i < 3; i++) {
      expect(
        (await api().post('/api/v1/auth/me/phone').set(bearer(t)).send({ phone: '+38344999000' }))
          .status,
      ).toBe(202);
    }
    expect(
      (await api().post('/api/v1/auth/me/phone').set(bearer(t)).send({ phone: '+38344999000' }))
        .status,
    ).toBe(429);
    expect(
      (await api().post('/api/v1/auth/me/phone').set(bearer(t)).send({ phone: 'abc' })).status,
    ).toBe(400);
  });

  it('locks verification after too many wrong codes', async () => {
    const u = await createUser('PATIENT');
    const t = await login(u.email);
    const { code } = await verifyPhone(t, '+38344111222', '+38344111222');
    const wrongCode = code === '123456' ? '654321' : '123456';
    for (let i = 0; i < 5; i++) {
      await api().post('/api/v1/auth/me/phone/verify').set(bearer(t)).send({ code: wrongCode });
    }
    const late = await api().post('/api/v1/auth/me/phone/verify').set(bearer(t)).send({ code });
    expect(late.status).toBe(400);
  });
});

describe('SMS notifications', () => {
  it('sends important notifications only, without clinical details', async () => {
    const before = smsTo('+38344700801').length;
    const base = `/api/v1/patients/${w.patient.id}`;
    const r = await api()
      .post(`${base}/lab-results`)
      .set(bearer(w.tokens.doctor))
      .send({ testName: 'HIV antibody', value: 'Reactive' });
    await api().post(`${base}/lab-results/${r.body.id}/acknowledge`).set(bearer(w.tokens.doctor));
    await api().post(`${base}/lab-results/${r.body.id}/release`).set(bearer(w.tokens.doctor));
    await drain();
    const sms = smsTo('+38344700801').slice(before);
    expect(sms).toHaveLength(1);
    expect(sms[0]!.body).toBe('Pacient: A new test result is available. Sign in to view.');
    expect(sms[0]!.body.length).toBeLessThanOrEqual(160);

    // Non-important notifications (e.g. a care-task update) never go by SMS.
    await api()
      .patch('/api/v1/portal/contact')
      .set(bearer(w.tokens.patient))
      .send({ phone: '+383 44 700 801' });
    await drain();
    expect(smsTo('+38344700801').slice(before)).toHaveLength(1);
  });

  it('stops after the number is removed', async () => {
    await api().delete('/api/v1/auth/me/phone').set(bearer(w.tokens.patient)).expect(204);
    const me = await api().get('/api/v1/auth/me').set(bearer(w.tokens.patient));
    expect(me.body).toMatchObject({ phone: null, smsNotifications: 'OFF' });
  });

  it('holds non-urgent messages during quiet hours', () => {
    // 23:30 Belgrade time (UTC+1 in November) is inside 22-7.
    const night = new Date('2026-11-02T22:30:00Z');
    expect(inQuietHours(night, '22-7')).toBe(true);
    expect(inQuietHours(new Date('2026-11-02T09:00:00Z'), '22-7')).toBe(false);
    const next = nextSendTime(night, '22-7');
    expect(inQuietHours(next, '22-7')).toBe(false);
    expect(next.getTime()).toBeGreaterThan(night.getTime());
    expect(next.toISOString()).toBe('2026-11-03T06:00:00.000Z'); // 07:00 local
  });

  it('the ministry can monitor SMS delivery', async () => {
    const res = await api().get('/api/v1/stats/sms').set(bearer(w.tokens.ministry));
    expect(res.status).toBe(200);
    expect(res.body.SENT.count).toBeGreaterThan(0);
  });
});
