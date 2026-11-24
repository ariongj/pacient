import { useState, type FormEvent, type ReactNode } from 'react';
import {
  parseEmails,
  useBillingProfile,
  useSaveBillingProfile,
  type BillingProfile,
  type BillingProfileInput,
} from '../../../api/billingdocs';
import type { OrganizationDetail } from '../../../api/subscriptions';
import {
  Alert,
  Button,
  Card,
  DefinitionList,
  Dialog,
  EmptyState,
  ErrorAlert,
  formValues,
  QueryView,
  TextAreaField,
  TextField,
} from '../../../components/ui';
import { formatDateTime } from '../../../format';
import { t } from '../../../i18n';

/** The billing details as a list (shared with the director's read-only card). */
export function BillingProfileList({ profile }: { profile: BillingProfile }) {
  const items: [string, ReactNode][] = [
    [t('Legal name'), profile.legalName],
    [t('Business number (NUI)'), profile.businessNumber],
    [t('Fiscal number'), profile.fiscalNumber],
    [t('VAT number'), profile.vatNumber],
    [t('Billing address'), profile.billingAddress],
    [
      t('Billing e-mails'),
      profile.billingEmails.length ? (
        <ul style={{ margin: 0, paddingLeft: '1.1rem' }}>
          {profile.billingEmails.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      ) : null,
    ],
    [t('Contact person'), profile.contactName],
    [t('Customer reference'), profile.customerReference],
  ];
  return <DefinitionList items={items} />;
}

/**
 * The fields of the billing details (the facility page's form and the new-customer form). Every
 * field is optional except the legal name; `required` is off in the new-customer form, where the
 * details as a whole are optional.
 */
export function BillingProfileFields({
  defaults,
  required = true,
}: {
  defaults?: BillingProfile | null;
  required?: boolean;
}) {
  return (
    <div className="form-grid">
      <TextField
        label={t('Legal name')}
        name="legalName"
        required={required}
        minLength={2}
        maxLength={200}
        defaultValue={defaults?.legalName ?? ''}
        hint={t('The legal entity that is invoiced, as registered')}
      />
      <TextField
        label={t('Business number (NUI)')}
        name="businessNumber"
        maxLength={40}
        defaultValue={defaults?.businessNumber ?? ''}
      />
      <TextField
        label={t('Fiscal number')}
        name="fiscalNumber"
        maxLength={40}
        defaultValue={defaults?.fiscalNumber ?? ''}
      />
      <TextField
        label={t('VAT number')}
        name="vatNumber"
        maxLength={40}
        defaultValue={defaults?.vatNumber ?? ''}
      />
      <TextAreaField
        label={t('Billing address')}
        name="billingAddress"
        maxLength={500}
        rows={2}
        defaultValue={defaults?.billingAddress ?? ''}
        hint={t('Empty: the facility’s address')}
      />
      <TextField
        label={t('Billing e-mails')}
        name="billingEmails"
        type="email"
        multiple
        maxLength={800}
        defaultValue={defaults?.billingEmails.join(', ') ?? ''}
        hint={t(
          'Up to three addresses, separated by commas. The facility’s active directors receive invoices as well.',
        )}
      />
      <TextField
        label={t('Contact person')}
        name="contactName"
        maxLength={200}
        defaultValue={defaults?.contactName ?? ''}
      />
      <TextField
        label={t('Customer reference')}
        name="customerReference"
        maxLength={120}
        defaultValue={defaults?.customerReference ?? ''}
        hint={t('Their purchase order or contract number, printed on invoices')}
      />
    </div>
  );
}

/**
 * Reads BillingProfileFields: null when nothing was entered, a problem to show when the details
 * cannot be sent as they are.
 */
export function readBillingProfile(v: Record<string, string>): {
  profile: BillingProfileInput | null;
  problem: string | null;
} {
  const text = (k: string) => (v[k] ?? '').trim() || null;
  const billingEmails = parseEmails(v.billingEmails ?? '');
  const profile: BillingProfileInput = {
    legalName: (v.legalName ?? '').trim(),
    businessNumber: text('businessNumber'),
    fiscalNumber: text('fiscalNumber'),
    vatNumber: text('vatNumber'),
    billingAddress: text('billingAddress'),
    billingEmails,
    contactName: text('contactName'),
    customerReference: text('customerReference'),
  };
  const anything = Object.entries(profile).some(([, x]) =>
    Array.isArray(x) ? x.length > 0 : Boolean(x),
  );
  if (!anything) return { profile: null, problem: null };
  if (!profile.legalName) {
    return {
      profile: null,
      problem: t('Enter the legal name for the billing details, or leave them all empty.'),
    };
  }
  if (billingEmails.length > 3) {
    return { profile: null, problem: t('Enter at most three billing e-mail addresses') };
  }
  return { profile, problem: null };
}

function BillingProfileForm({
  facilityId,
  defaults,
  onDone,
}: {
  facilityId: string;
  defaults: BillingProfile | null;
  onDone: () => void;
}) {
  const [problem, setProblem] = useState<string | null>(null);
  const mutation = useSaveBillingProfile(facilityId);
  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const read = readBillingProfile(formValues(e.currentTarget));
    setProblem(read.problem);
    if (read.profile) mutation.mutate(read.profile, { onSuccess: onDone });
  }
  return (
    <form onSubmit={onSubmit}>
      <BillingProfileFields defaults={defaults} />
      <p className="muted">
        {t(
          'The next invoice uses these details; invoices already issued keep the details they were issued with.',
        )}
      </p>
      {problem && <Alert tone="danger" title={problem} />}
      <ErrorAlert error={mutation.error} />
      <div className="form-actions">
        <Button variant="secondary" onClick={onDone}>
          {t('Cancel')}
        </Button>
        <Button type="submit" loading={mutation.isPending}>
          {t('Save billing details')}
        </Button>
      </div>
    </form>
  );
}

/**
 * Facility page of the administrator (Organization): the facility's billing details (legal name,
 * NUI, fiscal and VAT numbers, billing address and e-mails, contact, customer reference) with
 * editing. Business data of the customer, never about patients.
 */
export function BillingProfileCard({ detail }: { detail: OrganizationDetail }) {
  const query = useBillingProfile(detail.facility.id);
  const [editing, setEditing] = useState(false);
  const profile = query.data?.profile ?? null;
  return (
    <Card
      title={t('Billing details')}
      actions={
        query.data && (
          <Button variant="secondary" onClick={() => setEditing(true)}>
            {profile ? t('Edit billing details') : t('Add billing details')}
          </Button>
        )
      }
    >
      <QueryView query={query}>
        {(data) =>
          data.profile ? (
            <div className="stack">
              <BillingProfileList profile={data.profile} />
              <p className="muted" style={{ margin: 0 }}>
                {t('Changed on {date} by {name}', {
                  date: formatDateTime(data.profile.updatedAt),
                  name: data.profile.updatedBy?.fullName ?? '—',
                })}
              </p>
            </div>
          ) : (
            <EmptyState title={t('No billing details yet')}>
              {t(
                'Invoices name the facility as it is registered in Pacient until its billing details are entered.',
              )}
            </EmptyState>
          )
        }
      </QueryView>
      <p className="muted">
        {t(
          'Invoices and credit notes are e-mailed to the billing e-mails and to the facility’s active directors.',
        )}
      </p>
      <Dialog
        open={editing}
        onClose={() => setEditing(false)}
        title={t('Billing details of {facility}', { facility: detail.facility.name })}
        wide
      >
        <BillingProfileForm
          facilityId={detail.facility.id}
          defaults={profile}
          onDone={() => setEditing(false)}
        />
      </Dialog>
    </Card>
  );
}
