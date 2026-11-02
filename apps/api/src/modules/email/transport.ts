import nodemailer from 'nodemailer';
import { env, isProd } from '../../config/env.js';
import { logger } from '../../lib/logger.js';

export interface OutgoingEmail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface EmailTransport {
  send(message: OutgoingEmail): Promise<void>;
}

/** Messages "sent" by the memory transport (tests only). */
export const sentEmails: OutgoingEmail[] = [];

class SmtpTransport implements EmailTransport {
  private readonly mailer = nodemailer.createTransport(env.SMTP_URL!, { from: env.EMAIL_FROM });
  async send(m: OutgoingEmail) {
    await this.mailer.sendMail({
      to: m.to,
      subject: m.subject,
      text: m.text,
      html: m.html,
      disableFileAccess: true,
      disableUrlAccess: true,
    });
  }
}

class LogTransport implements EmailTransport {
  async send(m: OutgoingEmail) {
    // Development only: the text may contain single-use links.
    logger.info(
      { to: m.to, subject: m.subject, text: isProd ? '[redacted]' : m.text },
      'Email (log transport)',
    );
  }
}

class MemoryTransport implements EmailTransport {
  async send(m: OutgoingEmail) {
    sentEmails.push(m);
  }
}

let override: EmailTransport | null = null;
let instance: EmailTransport | null = null;

export function getTransport(): EmailTransport {
  if (override) return override;
  instance ??=
    env.EMAIL_TRANSPORT === 'smtp'
      ? new SmtpTransport()
      : env.EMAIL_TRANSPORT === 'log'
        ? new LogTransport()
        : new MemoryTransport();
  return instance;
}

/** Tests can simulate an unavailable mail server. */
export function setTransportForTests(t: EmailTransport | null) {
  override = t;
}
