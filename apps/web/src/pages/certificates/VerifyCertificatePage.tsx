import { useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ApiError } from '../../api/client';
import {
  FITNESS_KINDS,
  kindLabel,
  outcomeLabel,
  stateLabel,
  useVerifyCertificate,
  type CertificateVerification,
} from '../../api/certificates';
import { Alert, Button, DefinitionList, ErrorAlert, Loading, TextField } from '../../components/ui';
import { formatDate, formatDateTime } from '../../format';
import { t } from '../../i18n';
import { AuthCard } from '../shared/LoginPage';

/**
 * Public page opened from a certificate's QR code (no sign-in). Shows whether the certificate is
 * genuine and still valid – never the diagnosis.
 */
export function VerifyCertificatePage() {
  const { code: param = '' } = useParams();
  // "/verify/check" (or an empty code) opens the page for entering a code by hand.
  const code = param === 'check' ? '' : param;
  const navigate = useNavigate();
  const q = useVerifyCertificate(code);
  const [typed, setTyped] = useState('');

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const value = typed.trim().replace(/^.*\/verify\//, '');
    if (value) navigate(`/verify/${encodeURIComponent(value)}`);
  }

  const notFound = q.error instanceof ApiError && q.error.status === 404;
  return (
    <AuthCard>
      <h1>{t('Verify a medical certificate')}</h1>
      {q.isLoading && <Loading label={t('Checking the certificate…')} />}
      {q.data && <Result v={q.data} />}
      {notFound && (
        <Alert tone="danger" title={t('No certificate matches this code')}>
          {t(
            'Check that the code was copied completely. A certificate that cannot be found here was not issued through Pacient.',
          )}
        </Alert>
      )}
      {q.error && !notFound && <ErrorAlert error={q.error} />}
      <form onSubmit={onSubmit} className="stack" style={{ marginTop: '1rem' }}>
        <TextField
          label={t('Verification code or link')}
          name="code"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          hint={t('Printed under the QR code on the certificate.')}
        />
        <Button type="submit" variant="secondary">
          {t('Check')}
        </Button>
      </form>
      <p className="muted" style={{ marginTop: '1rem', fontSize: '0.85rem' }}>
        {t(
          'Only the validity, kind, dates and issuer are shown. The person is informed that their certificate was checked.',
        )}
      </p>
    </AuthCard>
  );
}

function Result({ v }: { v: CertificateVerification }) {
  const tone = v.state === 'VALID' ? 'success' : v.state === 'EXPIRED' ? 'info' : 'danger';
  const fitness = FITNESS_KINDS.includes(v.kind);
  const items: [string, React.ReactNode][] = [
    [t('Certificate'), kindLabel(v.kind)],
    [t('Number'), <code key="n">{v.serialNumber}</code>],
    [
      t('Person'),
      t('{initials}, born {year}', { initials: v.patient.initials, year: v.patient.birthYear }),
    ],
    [
      fitness ? t('Examined on') : t('Period'),
      v.endDate && !fitness
        ? `${formatDate(v.startDate)} – ${formatDate(v.endDate)}`
        : formatDate(v.startDate),
    ],
  ];
  if (fitness && v.endDate) items.push([t('Valid until|certificate'), formatDate(v.endDate)]);
  if (fitness && v.outcome) items.push([t('Assessment'), outcomeLabel(v.outcome)]);
  if (fitness && v.restrictions) items.push([t('Restrictions'), v.restrictions]);
  items.push(
    [t('Issued by'), `${v.issuer.doctor} · ${v.issuer.facility}, ${v.issuer.municipality}`],
    [t('Issued on'), formatDateTime(v.issuedAt)],
  );
  if (v.revokedAt) items.push([t('Revoked on'), formatDateTime(v.revokedAt)]);
  return (
    <div className="stack" role="status">
      <Alert tone={tone} title={stateLabel(v.state)}>
        {v.state === 'REVOKED'
          ? t('The issuing doctor revoked this certificate. It must not be accepted.')
          : t('This certificate was issued through Pacient and has not been changed.')}
      </Alert>
      <DefinitionList items={items} />
    </div>
  );
}
