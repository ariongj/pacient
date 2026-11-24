import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useLocation } from 'react-router-dom';
import {
  useAcceptAgreement,
  useMyAgreements,
  type AgreementState,
  type MyAgreements,
} from '../../../api/agreements';
import { kindPath, type LegalText as LegalTextData } from '../../../api/platform';
import type { MySubscription } from '../../../api/subscriptions';
import { useUser } from '../../../auth/AuthContext';
import {
  Badge,
  Button,
  Card,
  Dialog,
  ErrorAlert,
  formValues,
  QueryView,
  Table,
  TextField,
} from '../../../components/ui';
import { formatDate, formatDateTime } from '../../../format';
import { t, useLocale } from '../../../i18n';
import { legalKindLabel } from '../../admin/platform/labels';
import { LegalText } from '../../admin/platform/LegalText';

/** Where the facility stands with one agreement, in words and a badge. */
export function AgreementBadge({ a }: { a: AgreementState }) {
  if (!a.currentVersion) return <Badge>{t('Not published yet|agreement')}</Badge>;
  if (a.pending) return <Badge tone="warning">{t('Not accepted yet|agreement')}</Badge>;
  if (a.acceptedCurrent) {
    return (
      <Badge tone="success">
        {t('Accepted on {date}|agreement', { date: formatDate(a.acceptedCurrent.acceptedAt) })}
      </Badge>
    );
  }
  // A later version for information only: the acceptance of an earlier one still holds.
  return <Badge tone="success">{t('Up to date|agreement')}</Badge>;
}

/**
 * Director's subscription page (SubscriptionPage): the service agreement and the data processing
 * agreement – read them and accept them for the facility with the signer's name and title. Also
 * shown to a facility without a subscription. Never blocks anything.
 */
export function AgreementsCard({ data }: { data: MySubscription }) {
  const { locale } = useLocale();
  const query = useMyAgreements(locale);
  const [reading, setReading] = useState<string | null>(null);
  const ref = useRef<HTMLElement>(null);
  const { hash } = useLocation();
  // The directors' notice links here (#agreements): bring the card into view once it is there.
  useEffect(() => {
    if (hash === '#agreements' && query.data) ref.current?.scrollIntoView({ block: 'start' });
  }, [hash, query.data]);
  const facilityName = query.data?.facility?.name ?? data.facility?.name ?? '';
  const open = query.data?.agreements.find((a) => a.kind === reading) ?? null;
  return (
    <section id="agreements" ref={ref} aria-label={t('Agreements with the operator')}>
      <Card title={t('Agreements with the operator')}>
        <p className="muted">
          {t(
            'The service agreement and the data processing agreement are accepted once for the facility, by one of its directors. Nothing is blocked while they are not accepted.',
          )}
        </p>
        <QueryView query={query}>
          {(d) => <AgreementsTable data={d} onRead={setReading} />}
        </QueryView>
      </Card>
      <Dialog
        open={open !== null}
        onClose={() => setReading(null)}
        title={open ? legalKindLabel(open.kind) : ''}
        wide
      >
        {open?.document && (
          <AcceptForm
            document={open.document}
            facilityName={facilityName}
            onDone={() => setReading(null)}
          />
        )}
      </Dialog>
    </section>
  );
}

function AgreementsTable({ data, onRead }: { data: MyAgreements; onRead: (kind: string) => void }) {
  return (
    <Table caption={t('Agreements with the operator')}>
      <thead>
        <tr>
          <th scope="col">{t('Agreement')}</th>
          <th scope="col">{t('Status')}</th>
          <th scope="col">{t('Signed by')}</th>
          <th scope="col">
            <span className="sr-only">{t('Actions')}</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {data.agreements.map((a) => {
          const signed = a.acceptedCurrent ?? a.acceptances[0] ?? null;
          const name = legalKindLabel(a.kind);
          return (
            <tr key={a.kind}>
              <td>
                {name}
                {a.currentVersion && (
                  <div className="muted">
                    {t('Version {version}', { version: a.currentVersion })}
                  </div>
                )}
              </td>
              <td>
                <AgreementBadge a={a} />
              </td>
              <td>
                {signed ? (
                  <>
                    {signed.signerName}, {signed.signerTitle}
                    <div className="muted">
                      {t('Version {version}', { version: signed.version })} ·{' '}
                      {formatDateTime(signed.acceptedAt)}
                    </div>
                  </>
                ) : (
                  '—'
                )}
              </td>
              <td>
                {a.document &&
                  (a.pending ? (
                    <Button
                      size="sm"
                      onClick={() => onRead(a.kind)}
                      aria-label={`${t('Read and accept')} – ${name}`}
                    >
                      {t('Read and accept')}
                    </Button>
                  ) : (
                    <Link to={kindPath(a.kind)} aria-label={`${t('Read|agreement')} – ${name}`}>
                      {t('Read|agreement')}
                    </Link>
                  ))}
              </td>
            </tr>
          );
        })}
      </tbody>
    </Table>
  );
}

/** The text to read, then the signer's name and title and an explicit confirmation. */
function AcceptForm({
  document: doc,
  facilityName,
  onDone,
}: {
  document: LegalTextData;
  facilityName: string;
  onDone: () => void;
}) {
  const user = useUser();
  const { locale } = useLocale();
  const accept = useAcceptAgreement(locale);
  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const v = formValues(e.currentTarget);
    accept.mutate(
      { documentId: doc.id, signerName: v.signerName ?? '', signerTitle: v.signerTitle ?? '' },
      { onSuccess: onDone },
    );
  }
  return (
    <form onSubmit={onSubmit} className="stack">
      <p className="muted">
        {t('Version {version}, in force since {date}', {
          version: doc.version,
          date: formatDate(doc.publishedAt),
        })}
        {doc.locale !== locale && ` · ${t('Not yet available in your language.')}`}
      </p>
      <div
        role="region"
        aria-label={doc.title}
        tabIndex={0}
        style={{
          maxHeight: '45vh',
          overflowY: 'auto',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-sm)',
          padding: '0.75rem 1rem',
        }}
      >
        <h3>{doc.title}</h3>
        <LegalText body={doc.body} level={3} />
      </div>
      <div className="form-grid">
        <TextField
          label={t('Name of the signer')}
          name="signerName"
          required
          minLength={2}
          maxLength={200}
          defaultValue={user.fullName}
          autoComplete="name"
        />
        <TextField
          label={t('Title of the signer')}
          name="signerTitle"
          required
          minLength={2}
          maxLength={200}
          placeholder={t('e.g. Director')}
          autoComplete="organization-title"
        />
      </div>
      <label className="checkbox">
        <input type="checkbox" name="confirm" required />{' '}
        {t('I have read this agreement and accept it on behalf of {facility}.', {
          facility: facilityName,
        })}
      </label>
      <ErrorAlert error={accept.error} />
      <div className="form-actions">
        <Button variant="secondary" onClick={onDone}>
          {t('Cancel')}
        </Button>
        <Button type="submit" loading={accept.isPending}>
          {t('Accept for the facility')}
        </Button>
      </div>
    </form>
  );
}
