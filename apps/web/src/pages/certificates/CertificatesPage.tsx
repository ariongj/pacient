import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import {
  addDays,
  CERTIFICATE_KINDS,
  kindLabel,
  todayKosovo,
  useCertificateLookup,
  useCertificateStats,
  useMyCertificates,
  useRevokeCertificate,
} from '../../api/certificates';
import { useUser } from '../../auth/AuthContext';
import {
  Badge,
  Button,
  Card,
  DefinitionList,
  EmptyState,
  ErrorAlert,
  Grid,
  PageHeader,
  QueryView,
  Stat,
  Table,
  TextAreaField,
  TextField,
} from '../../components/ui';
import { formatDate, formatDateTime, formatMonth, formatNumber } from '../../format';
import { t } from '../../i18n';
import { periodText } from './CertificateList';

/**
 * Doctors: certificates they issued recently (certificates are issued from the patient's chart).
 * Directors: facility statistics and finding a certificate by its number to revoke it.
 */
export function CertificatesPage() {
  const user = useUser();
  return (
    <>
      <PageHeader
        title={t('Medical certificates')}
        subtitle={
          user.role === 'DOCTOR'
            ? t('Issue certificates from the patient’s chart, on the Certificates tab.')
            : t('Certificates issued at your facility – figures only, without names or diagnoses.')
        }
      />
      <div className="stack">
        {user.role === 'DOCTOR' ? <MyCertificates /> : <DirectorView />}
        <Card title={t('Verify a certificate')}>
          <p className="muted">
            {t('Anyone can check a certificate by scanning its QR code or entering its code.')}
          </p>
          <Link to="/verify/check">{t('Open the verification page')}</Link>
        </Card>
      </div>
    </>
  );
}

function MyCertificates() {
  const q = useMyCertificates();
  return (
    <Card title={t('Certificates I issued')}>
      <QueryView query={q}>
        {(items) =>
          items.length ? (
            <Table caption={t('Certificates I issued')}>
              <thead>
                <tr>
                  <th scope="col">{t('Patient')}</th>
                  <th scope="col">{t('Certificate')}</th>
                  <th scope="col">{t('Period')}</th>
                  <th scope="col">{t('Issued on')}</th>
                  <th scope="col">{t('Status')}</th>
                </tr>
              </thead>
              <tbody>
                {items.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <Link to={`/doctor/patients/${c.patientId}?tab=certificates`}>
                        {c.patientName}
                      </Link>
                    </td>
                    <td>
                      {kindLabel(c.kind)}
                      <div className="muted">
                        <code>{c.serialNumber}</code>
                      </div>
                    </td>
                    <td>{periodText({ ...c, days: null })}</td>
                    <td>{formatDateTime(c.issuedAt)}</td>
                    <td>
                      <Badge tone={c.status === 'REVOKED' ? 'danger' : 'success'}>
                        {c.status === 'REVOKED' ? t('Revoked|certificate') : t('Issued')}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          ) : (
            <EmptyState title={t('You have not issued any certificates yet')} />
          )
        }
      </QueryView>
    </Card>
  );
}

function DirectorView() {
  const to = todayKosovo();
  const [from, setFrom] = useState(`${addDays(to, -365).slice(0, 7)}-01`);
  const stats = useCertificateStats(from, to);
  return (
    <>
      <Card title={t('Statistics')}>
        <div className="form-grid" style={{ maxWidth: 360 }}>
          <TextField
            label={t('From')}
            name="from"
            type="date"
            value={from}
            max={to}
            onChange={(e) => e.target.value && setFrom(e.target.value)}
          />
        </div>
        <QueryView query={stats}>
          {(s) => (
            <div className="stack">
              <Grid>
                <Stat label={t('Certificates issued')} value={formatNumber(s.totals.issued)} />
                <Stat label={t('Revoked|certificate')} value={formatNumber(s.totals.revoked)} />
                <Stat
                  label={t('Sick-leave days')}
                  value={formatNumber(s.totals.sickLeaveDays)}
                  hint={
                    s.totals.averageSickLeaveDays !== null
                      ? t('{days} days per certificate on average', {
                          days: String(s.totals.averageSickLeaveDays).replace('.', ','),
                        })
                      : undefined
                  }
                />
              </Grid>
              <MonthlyTable rows={s.rows} />
            </div>
          )}
        </QueryView>
      </Card>
      <SerialLookup />
    </>
  );
}

function MonthlyTable({
  rows,
}: {
  rows: { month: string; kind: (typeof CERTIFICATE_KINDS)[number]; issued: number }[];
}) {
  const months = [...new Set(rows.map((r) => r.month))].sort().reverse();
  if (!months.length) return <EmptyState title={t('No certificates in this period')} />;
  const count = (m: string, k: string) =>
    rows.find((r) => r.month === m && r.kind === k)?.issued ?? 0;
  return (
    <Table caption={t('Certificates by month and kind')}>
      <thead>
        <tr>
          <th scope="col">{t('Month')}</th>
          {CERTIFICATE_KINDS.map((k) => (
            <th key={k} scope="col" className="num">
              {kindLabel(k)}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {months.map((m) => (
          <tr key={m}>
            <th scope="row">{formatMonth(m)}</th>
            {CERTIFICATE_KINDS.map((k) => (
              <td key={k} className="num">
                {formatNumber(count(m, k))}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

function SerialLookup() {
  const [typed, setTyped] = useState('');
  const [serial, setSerial] = useState('');
  const q = useCertificateLookup(serial);
  const revoke = useRevokeCertificate(q.data?.patientId ?? null);
  const [revoking, setRevoking] = useState(false);

  function onRevoke(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!q.data) return;
    const reason = String(new FormData(e.currentTarget).get('reason') ?? '').trim();
    revoke.mutate({ id: q.data.id, reason }, { onSuccess: () => setRevoking(false) });
  }

  return (
    <Card title={t('Find a certificate by its number')}>
      <form
        className="row"
        style={{ gap: '0.5rem', alignItems: 'flex-end', flexWrap: 'wrap' }}
        onSubmit={(e) => {
          e.preventDefault();
          setSerial(typed.trim().toUpperCase());
        }}
      >
        <TextField
          label={t('Certificate number')}
          name="serial"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder="UCC-PR-2026-000123"
        />
        <Button type="submit" variant="secondary">
          {t('Find')}
        </Button>
      </form>
      {serial && q.error && <ErrorAlert error={q.error} />}
      {q.data && (
        <div className="stack" style={{ marginTop: '1rem' }}>
          <DefinitionList
            items={[
              [t('Certificate'), kindLabel(q.data.kind)],
              [t('Patient'), q.data.patientName],
              [t('Period'), periodText({ ...q.data, days: null })],
              [t('Issued by'), `${q.data.issuedByName} · ${formatDate(q.data.issuedAt)}`],
              [
                t('Status'),
                q.data.status === 'REVOKED'
                  ? `${t('Revoked|certificate')} – ${q.data.revokeReason ?? ''}`
                  : t('Issued'),
              ],
            ]}
          />
          {q.data.status === 'ISSUED' &&
            (revoking ? (
              <form onSubmit={onRevoke} className="stack">
                <TextAreaField
                  label={t('Reason')}
                  name="reason"
                  required
                  minLength={5}
                  maxLength={300}
                  rows={2}
                />
                <ErrorAlert error={revoke.error} />
                <div className="form-actions">
                  <Button variant="secondary" onClick={() => setRevoking(false)}>
                    {t('Cancel')}
                  </Button>
                  <Button type="submit" variant="danger" loading={revoke.isPending}>
                    {t('Revoke|certificate')}
                  </Button>
                </div>
              </form>
            ) : (
              <div>
                <Button variant="danger" onClick={() => setRevoking(true)}>
                  {t('Revoke certificate')}
                </Button>
              </div>
            ))}
        </div>
      )}
    </Card>
  );
}
