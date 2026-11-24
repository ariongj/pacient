import type { AuditItem, SubscriptionStatus } from '../../../api/platform';
import type { Tone } from '../../../components/ui';
import { t } from '../../../i18n';

/** Subscription states in plain words (the context keeps them apart from other "Active"s). */
export const subscriptionStatusLabel = (s: SubscriptionStatus) =>
  ({
    TRIAL: t('Trial|subscription status'),
    ACTIVE: t('Active|subscription status'),
    PAST_DUE: t('Payment overdue|subscription status'),
    SUSPENDED: t('Suspended|subscription status'),
    CANCELLED: t('Cancelled|subscription status'),
    EXPIRED: t('Expired|subscription status'),
  })[s] ?? s;

export const SUBSCRIPTION_TONE: Record<SubscriptionStatus, Tone> = {
  TRIAL: 'info',
  ACTIVE: 'success',
  PAST_DUE: 'warning',
  SUSPENDED: 'danger',
  CANCELLED: 'neutral',
  EXPIRED: 'neutral',
};

/** Entries of the subscription history. */
export const subscriptionEventLabel = (type: string) =>
  ({
    CREATED: t('Subscription created'),
    TRIAL_STARTED: t('Trial started'),
    ACTIVATED: t('Subscription activated'),
    PLAN_CHANGED: t('Plan changed'),
    SEATS_CHANGED: t('Number of staff accounts changed'),
    PRICE_CHANGED: t('Price changed'),
    CYCLE_CHANGED: t('Billing cycle changed'),
    RENEWED: t('Subscription renewed'),
    INVOICE_ISSUED: t('Invoice issued'),
    PAYMENT_RECORDED: t('Payment recorded'),
    INVOICE_VOIDED: t('Invoice voided'),
    MARKED_PAST_DUE: t('Payment overdue|subscription event'),
    SUSPENDED: t('Subscription suspended'),
    REACTIVATED: t('Subscription reactivated'),
    CANCELLATION_SCHEDULED: t('Cancellation scheduled'),
    CANCELLATION_WITHDRAWN: t('Cancellation withdrawn'),
    CANCELLED: t('Subscription cancelled'),
    EXPIRED: t('Subscription expired'),
    REMINDER_SENT: t('Reminder sent'),
    NOTE: t('Note added'),
  })[type] ?? type;

/** Operator settings named in messages (e.g. "fill in before publishing"). */
export const settingLabel = (key: string) =>
  ({
    operatorName: t('Operator name'),
    operatorAddress: t('Operator address'),
    supportEmail: t('Support e-mail'),
    supportPhone: t('Support phone'),
    privacyEmail: t('Privacy e-mail'),
  })[key] ?? key;

/**
 * What an audit entry was about: a person, facility, invoice, plan, document or the settings. A
 * patient's portal account is never named (as in the list of acceptances).
 */
export const auditTarget = (a: AuditItem) => {
  if (a.resourceType === 'platform_settings') return t('Operator settings');
  if (a.targetPatientAccount) return t('Patient account|user account');
  // Legal documents arrive as "TERMS 2.0 (sq)": name the text in the reader's language.
  const legal =
    a.resourceType === 'legal_document' && a.targetName?.match(/^(TERMS|PRIVACY) (.+)$/);
  if (legal) return `${legal[1] === 'TERMS' ? t('Terms of use') : t('Privacy notice')} ${legal[2]}`;
  return a.targetName;
};
