import { Link } from 'react-router-dom';
import { settingLabel, useBillingReadiness, type MissingSetting } from '../../../api/billingdocs';
import { Alert, Card } from '../../../components/ui';
import { t } from '../../../i18n';

/** "Operator name, IBAN" in the reader's language. */
const settingsText = (missing: MissingSetting[]) => missing.map(settingLabel).join(', ');

/**
 * Platform overview (AdminHome): "Billing is not ready": the operator settings missing for
 * invoicing (name, address, fiscal number, IBAN, VAT number when VAT > 0), with a link to the
 * settings. Fetches its own data and renders nothing when there is nothing to show; it sits
 * between other cards of the page, so it has its own bottom margin.
 */
export function BillingReadinessCard() {
  const readiness = useBillingReadiness();
  const missing = readiness.data?.missing ?? [];
  if (!readiness.data || readiness.data.ready) return null;
  return (
    <div style={{ marginBottom: '1rem' }}>
      <Card title={t('Billing is not ready')}>
        <Alert
          tone="warning"
          title={t('No invoice can be issued until these operator settings are filled in:')}
        >
          <ul style={{ margin: '0.25rem 0 0.5rem', paddingLeft: '1.2rem' }}>
            {missing.map((m) => (
              <li key={m.field}>{settingLabel(m)}</li>
            ))}
          </ul>
          {t(
            'Until then no paid subscription can be started, and trials that end and renewals wait (their invoices are issued once the settings are complete). Clinical work, sign-in and accounts are never affected.',
          )}
        </Alert>
        <p style={{ margin: '0.75rem 0 0' }}>
          <Link to="/admin/settings">{t('Complete the operator settings')}</Link>
        </p>
      </Card>
    </div>
  );
}

/**
 * Why an action that issues an invoice is not offered: shown next to the disabled "start paid
 * now" choices, which point to it with aria-describedby. Renders nothing while billing is ready.
 */
export function BillingNotReadyNote({ id }: { id: string }) {
  const readiness = useBillingReadiness();
  if (!readiness.data || readiness.data.ready) return null;
  return (
    <p id={id} className="muted" style={{ margin: 0 }}>
      {t('Billing is not ready: invoices cannot be issued until {settings} are filled in.', {
        settings: settingsText(readiness.data.missing),
      })}{' '}
      <Link to="/admin/settings">{t('Complete the operator settings')}</Link>
    </p>
  );
}

/** True while invoices cannot be issued (false while unknown: the server refuses anyway). */
export function useBillingNotReady() {
  const readiness = useBillingReadiness();
  return readiness.data ? !readiness.data.ready : false;
}
