import { useState, type FormEvent } from 'react';
import {
  useAdminSettings,
  useSaveSettings,
  type PlatformSettings as Settings,
} from '../../api/platform';
import {
  Alert,
  Button,
  Card,
  ErrorAlert,
  formValues,
  PageHeader,
  QueryView,
  SelectField,
  TextAreaField,
  TextField,
} from '../../components/ui';
import { formatDateTime } from '../../format';
import { t } from '../../i18n';

/** "2026-11-15T10:30:00Z" → the value of a datetime-local field in the reader's time zone. */
function toLocalInput(iso: string | null) {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Who runs the service (shown on invoices, the terms and the privacy notice), the billing rules
 * the subscriptions follow, and a notice shown to every signed-in user.
 */
export function PlatformSettings() {
  const settings = useAdminSettings();
  // Kept here: the form is re-created with the saved (normalised) values after each save, also
  // when nothing changed (e.g. only the IBAN's letter case, which the server normalises).
  const [saved, setSaved] = useState(false);
  const [saves, setSaves] = useState(0);
  return (
    <>
      <PageHeader
        title={t('Operator settings')}
        subtitle={t('Who runs the service, billing rules and a notice to all users.')}
      />
      <QueryView query={settings}>
        {(s) => (
          <SettingsForm
            key={`${s.updatedAt}:${saves}`}
            settings={s}
            saved={saved}
            onSaved={(v) => {
              setSaved(v);
              if (v) setSaves((n) => n + 1);
            }}
          />
        )}
      </QueryView>
    </>
  );
}

function SettingsForm({
  settings: s,
  saved,
  onSaved,
}: {
  settings: Settings;
  saved: boolean;
  onSaved: (v: boolean) => void;
}) {
  const save = useSaveSettings();

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    onSaved(false);
    const v = formValues(e.currentTarget);
    const orNull = (k: string) => v[k] || null;
    const int = (k: string) => (v[k] === '' ? undefined : Number(v[k]));
    save.mutate(
      {
        operatorName: v.operatorName ?? '',
        operatorAddress: v.operatorAddress ?? '',
        operatorFiscalNumber: orNull('operatorFiscalNumber'),
        operatorVatNumber: orNull('operatorVatNumber'),
        operatorIban: orNull('operatorIban'),
        operatorBank: orNull('operatorBank'),
        supportEmail: orNull('supportEmail'),
        supportPhone: orNull('supportPhone'),
        privacyEmail: orNull('privacyEmail'),
        invoicePrefix: v.invoicePrefix,
        paymentTermsDays: int('paymentTermsDays'),
        vatRateBp: v.vatPercent === '' ? undefined : Math.round(Number(v.vatPercent) * 100),
        trialDays: int('trialDays'),
        graceDays: int('graceDays'),
        noticeText: orNull('noticeText'),
        noticeTone: v.noticeTone === 'WARNING' ? 'WARNING' : 'INFO',
        noticeUntil: v.noticeUntil ? new Date(v.noticeUntil).toISOString() : null,
      },
      { onSuccess: () => onSaved(true) },
    );
  }

  return (
    <form onSubmit={onSubmit} className="stack">
      <Card title={t('Operator')}>
        <p className="muted">
          {t(
            'Printed on invoices and filled into the terms of use and the privacy notice. Use the registered legal name.',
          )}
        </p>
        <div className="form-grid">
          <TextField
            label={t('Operator name')}
            name="operatorName"
            maxLength={200}
            defaultValue={s.operatorName}
          />
          <TextField
            label={t('Fiscal number (NUI)')}
            name="operatorFiscalNumber"
            maxLength={40}
            defaultValue={s.operatorFiscalNumber ?? ''}
          />
          <TextField
            label={t('VAT number')}
            name="operatorVatNumber"
            maxLength={40}
            defaultValue={s.operatorVatNumber ?? ''}
            hint={t('Leave empty if the operator is not registered for VAT.')}
          />
          <TextField
            label={t('IBAN')}
            name="operatorIban"
            maxLength={40}
            defaultValue={s.operatorIban ?? ''}
            hint={t('Shown on invoices for payment by bank transfer.')}
          />
          <TextField
            label={t('Bank')}
            name="operatorBank"
            maxLength={120}
            defaultValue={s.operatorBank ?? ''}
          />
        </div>
        <TextAreaField
          label={t('Operator address')}
          name="operatorAddress"
          maxLength={500}
          rows={2}
          defaultValue={s.operatorAddress}
        />
      </Card>

      <Card title={t('Contacts')}>
        <div className="form-grid">
          <TextField
            label={t('Support e-mail')}
            name="supportEmail"
            type="email"
            maxLength={254}
            defaultValue={s.supportEmail ?? ''}
          />
          <TextField
            label={t('Support phone')}
            name="supportPhone"
            type="tel"
            maxLength={40}
            defaultValue={s.supportPhone ?? ''}
          />
          <TextField
            label={t('Privacy e-mail')}
            name="privacyEmail"
            type="email"
            maxLength={254}
            defaultValue={s.privacyEmail ?? ''}
            hint={t(
              'Contact for personal data (data protection officer), named in the privacy notice.',
            )}
          />
        </div>
      </Card>

      <Card title={t('Billing rules')}>
        <div className="form-grid">
          <TextField
            label={t('Invoice number prefix')}
            name="invoicePrefix"
            required
            maxLength={10}
            pattern="[A-Za-z0-9\-]{1,10}"
            defaultValue={s.invoicePrefix}
            hint={t('Invoices are numbered PREFIX-YEAR-00001.')}
          />
          <TextField
            label={t('Payment terms (days)')}
            name="paymentTermsDays"
            type="number"
            min={0}
            max={120}
            required
            defaultValue={s.paymentTermsDays}
          />
          <TextField
            label={t('VAT (%)')}
            name="vatPercent"
            type="number"
            min={0}
            max={50}
            step={0.01}
            required
            defaultValue={s.vatRateBp / 100}
            hint={t('0 when the operator is not registered for VAT.')}
          />
          <TextField
            label={t('Trial (days)')}
            name="trialDays"
            type="number"
            min={0}
            max={365}
            required
            defaultValue={s.trialDays}
          />
          <TextField
            label={t('Grace period before suspension (days)')}
            name="graceDays"
            type="number"
            min={0}
            max={365}
            required
            defaultValue={s.graceDays}
            hint={t(
              'Days an invoice may stay unpaid after its due date. Suspension never blocks access to patient records.',
            )}
          />
        </div>
      </Card>

      <Card title={t('Notice to all users')}>
        <p className="muted">
          {t(
            'Shown at the top of every page for everyone who is signed in, e.g. planned maintenance. Leave the text empty to remove it.',
          )}
        </p>
        <TextAreaField
          label={t('Notice')}
          name="noticeText"
          maxLength={300}
          rows={2}
          defaultValue={s.noticeText ?? ''}
        />
        <div className="form-grid">
          <SelectField
            label={t('Kind of notice')}
            name="noticeTone"
            defaultValue={s.noticeTone}
            options={[
              { value: 'INFO', label: t('Information') },
              { value: 'WARNING', label: t('Warning') },
            ]}
          />
          <TextField
            label={t('Show until')}
            name="noticeUntil"
            type="datetime-local"
            defaultValue={toLocalInput(s.noticeUntil)}
            hint={t('Leave empty to show it until you remove it.')}
          />
        </div>
      </Card>

      <ErrorAlert error={save.error} />
      {saved && <Alert tone="success" title={t('Settings saved')} />}
      <div className="form-actions">
        <span className="muted">
          {t('Last changed {date}', { date: formatDateTime(s.updatedAt) })}
        </span>
        <Button type="submit" loading={save.isPending}>
          {t('Save settings')}
        </Button>
      </div>
    </form>
  );
}
