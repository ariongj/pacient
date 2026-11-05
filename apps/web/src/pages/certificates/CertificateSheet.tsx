import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import {
  FITNESS_KINDS,
  kindSource,
  outcomeLabel,
  useCertificate,
  type CertificateDetail,
} from '../../api/certificates';
import { Alert, Button, Dialog, ErrorAlert, Loading } from '../../components/ui';
import { formatDate, formatDateTime } from '../../format';
import { getLocale, t } from '../../i18n';
import { sq } from '../../i18n/sq';
import { sr } from '../../i18n/sr';

/**
 * Printable certificate (A5 portrait). Headings and field names are bilingual – Albanian or
 * Serbian with English – so the certificate can be read by employers abroad. The QR code opens the
 * public verification page; the diagnosis appears only when the patient asked for it.
 */
const PRINT_CSS = `
@media print {
  @page { size: A5 portrait; margin: 10mm; }
  html, body { background: #fff !important; }
  body * { visibility: hidden !important; }
  .certificate-sheet, .certificate-sheet * { visibility: visible !important; }
  .certificate-sheet {
    position: fixed !important; left: 0; top: 0; width: 100% !important;
    border: none !important; box-shadow: none !important; margin: 0 !important; padding: 0 !important;
  }
}
.certificate-sheet {
  background: #fff; color: #000; border: 1px solid var(--border, #bbb); border-radius: 6px;
  padding: 8mm; max-width: 148mm; box-sizing: border-box; font-family: Georgia, 'Times New Roman', serif;
  line-height: 1.35;
}
.certificate-sheet .cs-top { display: flex; justify-content: space-between; gap: 6mm; align-items: flex-start; }
.certificate-sheet .cs-facility { font-size: 9.5pt; }
.certificate-sheet .cs-facility strong { font-size: 11pt; }
.certificate-sheet h3 { font-size: 15pt; letter-spacing: 0.06em; text-align: center; margin: 5mm 0 1mm; }
.certificate-sheet .cs-kind { text-align: center; font-size: 11pt; margin-bottom: 4mm; }
.certificate-sheet dl { display: grid; grid-template-columns: 38% 1fr; gap: 1.2mm 3mm; margin: 0; font-size: 10pt; }
.certificate-sheet dt { color: #333; }
.certificate-sheet dd { margin: 0; font-weight: 600; }
.certificate-sheet .cs-bottom { display: flex; justify-content: space-between; align-items: flex-end; gap: 6mm; margin-top: 8mm; font-size: 9pt; }
.certificate-sheet .cs-sign { border-top: 0.3mm solid #000; padding-top: 1mm; min-width: 55mm; text-align: center; }
.certificate-sheet img { width: 26mm; height: 26mm; image-rendering: pixelated; }
.certificate-sheet .cs-qr { text-align: center; font-size: 7.5pt; max-width: 34mm; word-break: break-all; }
.certificate-sheet .cs-revoked { border: 0.6mm solid #b00; color: #b00; text-align: center; font-weight: 700; padding: 1.5mm; margin-bottom: 3mm; font-family: Arial, sans-serif; }
`;

/** "Albanian / English" (or Serbian / English) for the printed certificate. */
function bi(text: string): string {
  const other = getLocale() === 'sr' ? sr : sq;
  const english = text.replace(/\|[\w -]+$/, '');
  const local = other[text] ?? english;
  return local === english ? english : `${local} / ${english}`;
}

export function useQrCode(value: string | undefined) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    if (!value) return;
    let live = true;
    QRCode.toDataURL(value, { margin: 0, width: 240, errorCorrectionLevel: 'M' })
      .then((s) => live && setSrc(s))
      .catch(() => live && setSrc(null));
    return () => {
      live = false;
    };
  }, [value]);
  return value ? src : null;
}

export function CertificateSheet({ c }: { c: CertificateDetail }) {
  const qr = useQrCode(c.verificationUrl);
  const fitness = FITNESS_KINDS.includes(c.kind);
  const period =
    c.kind === 'SICK_LEAVE' || c.kind === 'SCHOOL_ABSENCE'
      ? c.endDate
        ? `${formatDate(c.startDate)} – ${formatDate(c.endDate)} (${c.days})`
        : formatDate(c.startDate)
      : null;
  return (
    <div className="certificate-sheet" aria-label={t('Certificate preview')}>
      <div className="cs-top">
        <div className="cs-facility">
          <strong>{c.facility.name}</strong>
          <div>
            {c.facility.address ? `${c.facility.address}, ` : ''}
            {c.facility.municipality}
          </div>
          {c.facility.phone && <div>{c.facility.phone}</div>}
        </div>
        <div className="cs-facility" style={{ textAlign: 'right' }}>
          {bi('No.')} <strong>{c.serialNumber}</strong>
          <div>{formatDateTime(c.issuedAt)}</div>
        </div>
      </div>
      <h3>{bi('MEDICAL CERTIFICATE').toUpperCase()}</h3>
      <div className="cs-kind">{bi(kindSource(c.kind))}</div>
      {c.status === 'REVOKED' && <div className="cs-revoked">{bi('REVOKED – NOT VALID')}</div>}
      <dl>
        <dt>{bi('Name')}</dt>
        <dd>
          {c.patient.firstName} {c.patient.lastName}
        </dd>
        <dt>{bi('Date of birth')}</dt>
        <dd>{formatDate(c.patient.dateOfBirth)}</dd>
        <dt>{bi('Personal number')}</dt>
        <dd>{c.patient.nationalId}</dd>
        {period && (
          <>
            <dt>{bi(c.kind === 'SICK_LEAVE' ? 'Unable to work' : 'Absent from school')}</dt>
            <dd>{period}</dd>
          </>
        )}
        {fitness && c.outcome && (
          <>
            <dt>{bi('Assessment')}</dt>
            <dd>{outcomeLabel(c.outcome)}</dd>
            {c.restrictions && (
              <>
                <dt>{bi('Restrictions')}</dt>
                <dd>{c.restrictions}</dd>
              </>
            )}
            <dt>{bi('Examined on')}</dt>
            <dd>{formatDate(c.startDate)}</dd>
            {c.endDate && (
              <>
                <dt>{bi('Valid until|certificate')}</dt>
                <dd>{formatDate(c.endDate)}</dd>
              </>
            )}
          </>
        )}
        {!fitness && !period && (
          <>
            <dt>{bi('Date')}</dt>
            <dd>
              {formatDate(c.startDate)}
              {c.endDate ? ` – ${formatDate(c.endDate)}` : ''}
            </dd>
          </>
        )}
        {c.purpose && (
          <>
            <dt>{bi('Issued for')}</dt>
            <dd>{c.purpose}</dd>
          </>
        )}
        {c.diagnosisOnCertificate && c.icd10Code && (
          <>
            <dt>{bi('Diagnosis (ICD-10)')}</dt>
            <dd>{c.icd10Code}</dd>
          </>
        )}
      </dl>
      <div className="cs-bottom">
        <div className="cs-qr">
          {qr && <img src={qr} alt={t('Verification QR code')} />}
          <div>{bi('Verify this certificate')}</div>
          <div>{c.verificationUrl.split('/verify/')[1]}</div>
        </div>
        <div className="cs-sign">
          <div>
            <strong>{c.doctor.fullName}</strong>
          </div>
          {c.doctor.specialty && <div>{c.doctor.specialty}</div>}
          {c.doctor.licenseNumber && (
            <div>
              {bi('Licence')} {c.doctor.licenseNumber}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Dialog showing one certificate with a print button. */
export function CertificatePrintDialog({
  id,
  onClose,
}: {
  id: string | null;
  onClose: () => void;
}) {
  const q = useCertificate(id);
  return (
    <Dialog open={Boolean(id)} onClose={onClose} title={t('Medical certificate')} wide>
      <style>{PRINT_CSS}</style>
      {q.isLoading && <Loading />}
      <ErrorAlert error={q.error} />
      {q.data && (
        <div className="stack">
          {q.data.status === 'REVOKED' && (
            <Alert tone="danger" title={t('This certificate was revoked')}>
              {q.data.revokeReason}
            </Alert>
          )}
          <CertificateSheet c={q.data} />
          <div className="form-actions no-print">
            <Button variant="secondary" onClick={onClose}>
              {t('Close')}
            </Button>
            <Button onClick={() => window.print()}>{t('Print')}</Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
