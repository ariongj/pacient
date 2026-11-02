import { env, isProd } from '../../config/env.js';
import { logger } from '../../lib/logger.js';

export interface OutgoingSms {
  to: string;
  body: string;
}

export interface SmsTransport {
  /** Returns the provider's message id. */
  send(message: OutgoingSms): Promise<string | null>;
}

/** Messages "sent" by the memory transport (tests only). */
export const sentSms: OutgoingSms[] = [];

/** Twilio-compatible REST API over HTTPS (no SDK dependency). */
class TwilioTransport implements SmsTransport {
  async send(m: OutgoingSms) {
    const sid = env.TWILIO_ACCOUNT_SID!;
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${sid}:${env.TWILIO_AUTH_TOKEN}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ To: m.to, From: env.SMS_FROM!, Body: m.body }),
        signal: AbortSignal.timeout(15_000),
      },
    );
    const payload = (await res.json().catch(() => ({}))) as {
      sid?: string;
      message?: string;
      code?: number;
    };
    if (!res.ok)
      throw new Error(
        `SMS provider ${res.status}: ${payload.message ?? 'error'} (${payload.code ?? '-'})`,
      );
    return payload.sid ?? null;
  }
}

class LogTransport implements SmsTransport {
  async send(m: OutgoingSms) {
    logger.info({ to: m.to, body: isProd ? '[redacted]' : m.body }, 'SMS (log transport)');
    return null;
  }
}

class MemoryTransport implements SmsTransport {
  async send(m: OutgoingSms) {
    sentSms.push(m);
    return `mem-${sentSms.length}`;
  }
}

let override: SmsTransport | null = null;
let instance: SmsTransport | null = null;

export function getSmsTransport(): SmsTransport {
  if (override) return override;
  if (env.SMS_PROVIDER === 'held') throw new Error('SMS delivery is not configured');
  instance ??=
    env.SMS_PROVIDER === 'twilio'
      ? new TwilioTransport()
      : env.SMS_PROVIDER === 'log'
        ? new LogTransport()
        : new MemoryTransport();
  return instance;
}

export function setSmsTransportForTests(t: SmsTransport | null) {
  override = t;
}
