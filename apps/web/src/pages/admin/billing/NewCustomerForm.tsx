import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../../api/client';
import { useBillingMutation, usePlans, type NewCustomerResult } from '../../../api/subscriptions';
import {
  Alert,
  Button,
  enumOptions,
  ErrorAlert,
  formValues,
  Loading,
  SelectField,
  TextField,
} from '../../../components/ui';
import { t } from '../../../i18n';
import { readStart, StartFields } from './SubscriptionForms';
import { SubscriptionBadge } from './parts';

/** The director's activation link: shown once outside production, otherwise only e-mailed. */
function DirectorLink({ url, email }: { url: string | null; email: string }) {
  const [copied, setCopied] = useState(false);
  if (!url) {
    return <p className="muted">{t('The activation link has been sent to {email}.', { email })}</p>;
  }
  return (
    <div className="stack">
      <TextField
        label={t('Activation link')}
        readOnly
        value={url}
        onFocus={(e) => e.currentTarget.select()}
      />
      <div className="row">
        <Button
          variant="secondary"
          onClick={async () => {
            await navigator.clipboard.writeText(url);
            setCopied(true);
          }}
        >
          {copied ? `${t('Copied')} ✓` : t('Copy link')}
        </Button>
        <span className="muted" role="status">
          {t('Development only — in production the link is delivered by email.')}
        </span>
      </div>
    </div>
  );
}

const FACILITY_TYPES = [
  'UNIVERSITY_CLINICAL_CENTER',
  'REGIONAL_HOSPITAL',
  'FAMILY_MEDICINE_CENTER',
  'SPECIALIZED_CLINIC',
] as const;

/**
 * A new customer in one step: the facility, its subscription and, optionally, the first director,
 * who receives an activation link (shown here once outside production).
 */
export function NewCustomerForm({ onDone }: { onDone: () => void }) {
  const plans = usePlans();
  const [subscribe, setSubscribe] = useState(true);
  const [problem, setProblem] = useState<string | null>(null);
  const mutation = useBillingMutation((body: Record<string, unknown>) =>
    api<NewCustomerResult>('/admin/organizations', { method: 'POST', body }),
  );

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const v = formValues(e.currentTarget);
    if (Boolean(v.directorEmail) !== Boolean(v.directorName)) {
      setProblem(t('Enter both the director’s name and e-mail address, or neither.'));
      return;
    }
    const subscription = subscribe ? readStart(v) : null;
    if (subscribe && !subscription) {
      setProblem(t('Enter the price as an amount, e.g. 149.00'));
      return;
    }
    setProblem(null);
    mutation.mutate({
      facility: {
        code: v.code,
        name: v.name,
        type: v.type,
        region: v.region,
        municipality: v.municipality,
        address: v.address || null,
        phone: v.phone || null,
      },
      director: v.directorEmail ? { email: v.directorEmail, fullName: v.directorName } : null,
      subscription,
    });
  }

  const done = mutation.data;
  if (done) {
    return (
      <div className="stack">
        <Alert tone="success" title={t('{name} was added.', { name: done.facility.name })}>
          {done.subscription ? (
            <>
              {done.subscription.plan.name} ·{' '}
              <SubscriptionBadge status={done.subscription.status} />
            </>
          ) : (
            t('No subscription yet.')
          )}
        </Alert>
        {done.invitedDirector && (
          <DirectorLink
            url={done.activationLinkShown ? (done.invitedDirector.activationUrl ?? null) : null}
            email={done.invitedDirector.email}
          />
        )}
        <div className="form-actions">
          <Button variant="secondary" onClick={onDone}>
            {t('Close')}
          </Button>
          <Link className="btn btn-primary btn-md" to={`/admin/organizations/${done.facility.id}`}>
            {t('Open the facility')}
          </Link>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit}>
      <fieldset>
        <legend>{t('Facility')}</legend>
        <div className="form-grid">
          <TextField
            label={t('Code')}
            name="code"
            required
            pattern="[A-Za-z0-9\-]{2,32}"
            hint={t('Letters, digits and dashes, e.g. RH-FE')}
          />
          <TextField label={t('Name|thing')} name="name" required minLength={2} maxLength={200} />
          <SelectField
            label={t('Type')}
            name="type"
            required
            defaultValue="FAMILY_MEDICINE_CENTER"
            options={enumOptions(FACILITY_TYPES)}
          />
          <TextField label={t('Region')} name="region" required minLength={2} maxLength={100} />
          <TextField
            label={t('Municipality')}
            name="municipality"
            required
            minLength={2}
            maxLength={100}
          />
          <TextField label={t('Address')} name="address" maxLength={300} />
          <TextField label={t('Phone')} name="phone" type="tel" maxLength={40} />
        </div>
      </fieldset>
      <fieldset>
        <legend>{t('First director (optional)')}</legend>
        <div className="form-grid">
          <TextField
            label={t('Full name')}
            name="directorName"
            minLength={2}
            maxLength={200}
            autoComplete="off"
          />
          <TextField
            label={t('E-mail')}
            name="directorEmail"
            type="email"
            maxLength={254}
            autoComplete="off"
          />
        </div>
        <p className="muted">
          {t('The director receives an activation link and then invites the facility’s staff.')}
        </p>
      </fieldset>
      <fieldset>
        <legend>{t('Subscription')}</legend>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={subscribe}
            onChange={(e) => setSubscribe(e.target.checked)}
          />
          {t('Start a subscription now')}
        </label>
        {subscribe &&
          (plans.isPending ? (
            <Loading />
          ) : plans.error ? (
            <ErrorAlert error={plans.error} />
          ) : plans.data!.some((p) => p.isActive) ? (
            <div className="stack" style={{ marginTop: '0.75rem' }}>
              <StartFields plans={plans.data!} />
            </div>
          ) : (
            <Alert tone="warning" title={t('No plan is offered. Create a plan first.')} />
          ))}
      </fieldset>
      {problem && <Alert tone="danger" title={problem} />}
      <ErrorAlert error={mutation.error} />
      <div className="form-actions">
        <Button variant="secondary" onClick={onDone}>
          {t('Cancel')}
        </Button>
        <Button
          type="submit"
          loading={mutation.isPending}
          disabled={subscribe && !plans.data?.some((p) => p.isActive)}
        >
          {t('Add customer')}
        </Button>
      </div>
    </form>
  );
}
