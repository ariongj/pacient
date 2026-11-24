import nodemailer from 'nodemailer';
import { env, isProd } from '../../config/env.js';
import { logger } from '../../lib/logger.js';

/** A file sent with a message: only billing documents, rendered when the message is sent. */
export interface EmailAttachment {
  filename: string;
  contentType: string;
  content: Buffer;
}

export interface OutgoingEmail {
  to: string;
  /** The operator's support address (Operator settings), so that replies reach a person. */
  replyTo?: string;
  subject: string;
  text: string;
  html: string;
  attachments?: EmailAttachment[];
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
      replyTo: m.replyTo,
      subject: m.subject,
      text: m.text,
      html: m.html,
      // In-memory buffers only: file and URL access stay off.
      attachments: m.attachments?.map((a) => ({
        filename: a.filename,
        contentType: a.contentType,
        content: a.content,
      })),
      disableFileAccess: true,
      disableUrlAccess: true,
    });
  }
}

class LogTransport implements EmailTransport {
  async send(m: OutgoingEmail) {
    // Development only: the text may contain single-use links. Attachments: names and sizes.
    logger.info(
      {
        to: m.to,
        subject: m.subject,
        text: isProd ? '[redacted]' : m.text,
        attachments: m.attachments?.map((a) => ({ filename: a.filename, bytes: a.content.length })),
      },
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
  if (env.EMAIL_TRANSPORT === 'held')
    throw new Error('Email delivery is not configured (SMTP_URL)');
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
