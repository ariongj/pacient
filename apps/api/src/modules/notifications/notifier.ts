import { isProd } from '../../config/env.js';
import { logger } from '../../lib/logger.js';

/**
 * Outbound notifications. In production, plug in an email/SMS provider here. The development
 * implementation only logs that a message would be sent (never the secret link itself in prod).
 */
export interface Notifier {
  sendActivationLink(to: { email: string; fullName: string }, url: string): Promise<void>;
}

class LogNotifier implements Notifier {
  async sendActivationLink(to: { email: string; fullName: string }, url: string) {
    if (isProd) {
      logger.warn({ to: to.email }, 'No notifier configured: activation link was not delivered');
      return;
    }
    logger.info({ to: to.email, url }, 'Activation link (development only)');
  }
}

export const notifier: Notifier = new LogNotifier();
