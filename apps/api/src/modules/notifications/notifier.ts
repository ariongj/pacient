import { isProd, isTest } from '../../config/env.js';
import { logger } from '../../lib/logger.js';

/**
 * Outbound email/SMS. In production, plug in a provider here. The development implementation only
 * logs (never in production, where links are secrets). Tests read the in-memory outbox.
 */
export interface OutboundMessage {
  to: string;
  kind: 'ACCOUNT_ACTIVATION' | 'PASSWORD_RESET';
  url: string;
}

export interface Notifier {
  sendActivationLink(to: { email: string; fullName: string }, url: string): Promise<void>;
  sendPasswordReset(to: { email: string; fullName: string }, url: string): Promise<void>;
}

export const testOutbox: OutboundMessage[] = [];

class LogNotifier implements Notifier {
  private async send(message: OutboundMessage) {
    if (isTest) {
      testOutbox.push(message);
      return;
    }
    if (isProd) {
      logger.warn(
        { to: message.to, kind: message.kind },
        'No notifier configured: message not delivered',
      );
      return;
    }
    logger.info(message, 'Outbound message (development only)');
  }
  sendActivationLink(to: { email: string }, url: string) {
    return this.send({ to: to.email, kind: 'ACCOUNT_ACTIVATION', url });
  }
  sendPasswordReset(to: { email: string }, url: string) {
    return this.send({ to: to.email, kind: 'PASSWORD_RESET', url });
  }
}

export const notifier: Notifier = new LogNotifier();
