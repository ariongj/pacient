import { useState, type FormEvent } from 'react';
import {
  FITNESS_KINDS,
  kindLabel,
  outcomeLabel,
  useRevokeCertificate,
  type CertificateListItem,
} from '../../api/certificates';
import { useUser } from '../../auth/AuthContext';
import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  ErrorAlert,
  Table,
  TextAreaField,
} from '../../components/ui';
import { formatDate, formatDateTime } from '../../format';
import { t, tn } from '../../i18n';
import { CertificatePrintDialog } from './CertificateSheet';

export function periodText(c: Pick<CertificateListItem, 'startDate' | 'endDate' | 'days'>) {
  if (!c.endDate) return formatDate(c.startDate);
  const range = `${formatDate(c.startDate)} – ${formatDate(c.endDate)}`;
  return c.days
    ? `${range} · ${tn(c.days, '{count} day', '{count} days', { count: c.days })}`
    : range;
}

/** Table of a patient's certificates with print and (for the issuer) revoke actions. */
export function CertificateList({
  items,
  patientId,
  showDiagnosis,
}: {
  items: CertificateListItem[];
  patientId: string;
  showDiagnosis: boolean;
}) {
  const user = useUser();
  const [printId, setPrintId] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<CertificateListItem | null>(null);
  const revoke = useRevokeCertificate(patientId);

  if (!items.length) return <EmptyState title={t('No medical certificates yet')} />;

  function onRevoke(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!revoking) return;
    const reason = String(new FormData(e.currentTarget).get('reason') ?? '').trim();
    revoke.mutate({ id: revoking.id, reason }, { onSuccess: () => setRevoking(null) });
  }

  return (
    <>
      <Table caption={t('Medical certificates')}>
        <thead>
          <tr>
            <th scope="col">{t('Certificate')}</th>
            <th scope="col">{t('Period')}</th>
            <th scope="col">{t('Issued by')}</th>
            <th scope="col">{t('Status')}</th>
            <th scope="col">
              <span className="sr-only">{t('Actions')}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((c) => (
            <tr key={c.id}>
              <td>
                <strong>{kindLabel(c.kind)}</strong>
                <div className="muted">
                  <code>{c.serialNumber}</code>
                </div>
                {FITNESS_KINDS.includes(c.kind) && c.outcome && (
                  <div>{outcomeLabel(c.outcome)}</div>
                )}
                {c.purpose && <div className="muted">{c.purpose}</div>}
                {showDiagnosis && c.icd10Code && (
                  <div className="muted">
                    {t('ICD-10')}: {c.icd10Code}
                    {c.diagnosisOnCertificate ? ` · ${t('printed on the certificate')}` : ''}
                  </div>
                )}
                {c.extendsCertificateId && (
                  <div className="muted">{t('Extension of an earlier certificate')}</div>
                )}
              </td>
              <td>
                {periodText(c)}
                {c.chainDays !== null && c.extendsCertificateId && (
                  <div className="muted">
                    {t('{count} days in a row in total', { count: c.chainDays })}
                  </div>
                )}
              </td>
              <td>
                {c.issuedByName}
                <div className="muted">{c.facilityName}</div>
                <div className="muted">{formatDateTime(c.issuedAt)}</div>
              </td>
              <td>
                {c.status === 'REVOKED' ? (
                  <>
                    <Badge tone="danger">{t('Revoked|certificate')}</Badge>
                    {c.revokeReason && <div className="muted">{c.revokeReason}</div>}
                  </>
                ) : (
                  <Badge tone="success">{t('Issued')}</Badge>
                )}
              </td>
              <td>
                <div className="row" style={{ gap: '0.4rem', flexWrap: 'wrap' }}>
                  <Button size="sm" variant="secondary" onClick={() => setPrintId(c.id)}>
                    {t('Show and print')}
                  </Button>
                  {c.status === 'ISSUED' && user.role === 'DOCTOR' && c.issuedById === user.id && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setRevoking(c)}
                      disabled={Boolean(c.extendedById)}
                      title={
                        c.extendedById
                          ? t('Revoke the extension of this certificate first')
                          : undefined
                      }
                    >
                      {t('Revoke|certificate')}
                    </Button>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </Table>

      <CertificatePrintDialog id={printId} onClose={() => setPrintId(null)} />

      <Dialog
        open={revoking !== null}
        onClose={() => setRevoking(null)}
        title={t('Revoke certificate')}
      >
        {revoking && (
          <form onSubmit={onRevoke} className="stack">
            <p>
              {t(
                'Certificate {serial} will no longer be valid. Anyone verifying it will see that it was revoked.',
                {
                  serial: revoking.serialNumber,
                },
              )}
            </p>
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
              <Button variant="secondary" onClick={() => setRevoking(null)}>
                {t('Cancel')}
              </Button>
              <Button type="submit" variant="danger" loading={revoke.isPending}>
                {t('Revoke|certificate')}
              </Button>
            </div>
          </form>
        )}
      </Dialog>
    </>
  );
}
