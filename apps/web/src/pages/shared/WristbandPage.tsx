import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { usePrintWristband, type Wristband } from '../../api/bcma';
import { Alert, Button, Card, ErrorAlert, PageHeader } from '../../components/ui';
import { formatDate, formatDateTime, humanize } from '../../format';
import { t } from '../../i18n';

/** Wristband label: 280 × 25 mm thermal label (adult band); prints only the band itself. */
const PRINT_CSS = `
@media print {
  @page { size: 280mm 25mm; margin: 0; }
  html, body { margin: 0 !important; padding: 0 !important; background: #fff !important; }
  body * { visibility: hidden !important; }
  .wristband-label, .wristband-label * { visibility: visible !important; }
  .wristband-label {
    position: fixed !important; left: 0; top: 0;
    width: 280mm !important; height: 25mm !important;
    border: none !important; border-radius: 0 !important; box-shadow: none !important;
    margin: 0 !important;
  }
}
.wristband-label {
  display: flex; align-items: center; gap: 3mm;
  width: 280mm; max-width: 100%; height: 25mm; box-sizing: border-box;
  padding: 1.5mm 4mm 1.5mm 30mm; /* left margin: the band's clasp */
  border: 1px dashed var(--border, #bbb); border-radius: 4px;
  background: #fff; color: #000; overflow: hidden;
  font-family: Arial, Helvetica, sans-serif; line-height: 1.15;
}
.wristband-label img { width: 22mm; height: 22mm; flex: none; image-rendering: pixelated; }
.wristband-label .wb-main { flex: 1; min-width: 0; }
.wristband-label .wb-name { font-size: 13pt; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.wristband-label .wb-line { font-size: 8.5pt; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.wristband-label .wb-flag {
  flex: none; padding: 1mm 2.5mm; font-weight: 800; font-size: 12pt; letter-spacing: 0.04em;
  background: #000; color: #fff; border-radius: 1mm;
  -webkit-print-color-adjust: exact; print-color-adjust: exact;
}
.wristband-label .wb-blood { flex: none; font-size: 11pt; font-weight: 700; border: 0.4mm solid #000; padding: 0.6mm 1.6mm; border-radius: 1mm; }
`;

function useQr(value: string | undefined) {
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

function identifierLabel(b: Wristband) {
  if (b.patient.identifierKind === 'NATIONAL_ID') return t('National ID');
  return b.patient.temporaryIdentity === 'NEWBORN' ? t('Temporary number (newborn)') : t('Temporary number');
}

function Label({ band }: { band: Wristband }) {
  const qr = useQr(band.token);
  const sexShort = band.patient.sex === 'FEMALE' ? t('F') : band.patient.sex === 'MALE' ? t('M') : '';
  return (
    <div className="wristband-label" aria-label={t('Wristband preview')}>
      {qr && <img src={qr} alt={t('Wristband code')} />}
      <div className="wb-main">
        <div className="wb-name">
          {band.patient.lastName.toUpperCase()}, {band.patient.firstName}
        </div>
        <div className="wb-line">
          {t('DOB')} {formatDate(band.patient.dateOfBirth)} {sexShort && `· ${sexShort}`}
        </div>
        <div className="wb-line">
          {identifierLabel(band)}: <strong>{band.patient.identifier}</strong>
        </div>
        <div className="wb-line">
          {band.stay.facility} · {band.stay.unit}
          {band.stay.bed ? ` · ${t('Bed {bed}', { bed: band.stay.bed })}` : ''}
        </div>
      </div>
      {band.allergyStatus === 'ALLERGIES' && <div className="wb-flag">{t('ALLERGY')}</div>}
      {band.bloodGroup && <div className="wb-blood">{band.bloodGroup}</div>}
    </div>
  );
}

/**
 * Prints a patient wristband. Every print issues a new signed code and is audited; the band
 * carries only identification, an allergy flag and a laboratory-confirmed blood group.
 */
export function WristbandPage() {
  const { patientId = '' } = useParams();
  const issue = usePrintWristband(patientId);
  const band = issue.data;
  const [printRequested, setPrintRequested] = useState(false);
  const qrReady = useQr(band?.token);

  // Print once the label (and its QR code) has rendered.
  useEffect(() => {
    if (printRequested && band && qrReady) {
      setPrintRequested(false);
      const id = window.setTimeout(() => window.print(), 50);
      return () => window.clearTimeout(id);
    }
  }, [printRequested, band, qrReady]);

  function createAndPrint() {
    issue.mutate(undefined, { onSuccess: () => setPrintRequested(true) });
  }

  return (
    <div className="stack">
      <style>{PRINT_CSS}</style>
      <PageHeader
        title={t('Patient wristband')}
        subtitle={t('A wristband identifies the patient at every dose, sample and transfusion.')}
        actions={
          <Link to={`/patients/${patientId}`} className="btn btn-secondary btn-md">
            {t('Back to chart')}
          </Link>
        }
      />
      <Card title={band ? t('Wristband ready') : t('Print wristband')}>
        {!band && (
          <p className="muted">
            {t(
              'Printing creates a new signed code for this patient and is recorded in the audit log. Check the patient’s name and date of birth with the patient before putting the band on.',
            )}
          </p>
        )}
        <ErrorAlert error={issue.error} />
        {band && (
          <>
            <Label band={band} />
            <dl className="definition-list" style={{ marginTop: '1rem' }}>
              <dt>{t('Allergies')}</dt>
              <dd>
                {band.allergyStatus === 'ALLERGIES'
                  ? band.allergies.join(', ')
                  : band.allergyStatus === 'NONE_KNOWN'
                    ? t('No known allergies')
                    : t('Not recorded')}
              </dd>
              <dt>{t('Blood group')}</dt>
              <dd>{band.bloodGroup ?? t('Not confirmed by the laboratory – not printed')}</dd>
              <dt>{t('Stay')}</dt>
              <dd>
                {humanize(band.stay.kind)} · {formatDateTime(band.stay.since)}
              </dd>
              <dt>{t('Issued')}</dt>
              <dd>{formatDateTime(band.issuedAt)}</dd>
            </dl>
            {band.allergyStatus === 'NOT_RECORDED' && (
              <Alert tone="warning" title={t('Allergies not recorded')}>
                {t('Record the allergy status in the chart as soon as possible.')}
              </Alert>
            )}
          </>
        )}
        <div className="form-actions no-print">
          {band && (
            <Button variant="secondary" onClick={() => window.print()}>
              {t('Print again')}
            </Button>
          )}
          <Button onClick={createAndPrint} loading={issue.isPending}>
            {band ? t('Issue a new wristband') : t('Create and print wristband')}
          </Button>
        </div>
      </Card>
    </div>
  );
}
