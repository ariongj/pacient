import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import {
  erxStatusLabel,
  erxStatusTone,
  suppliesLabel,
  type Dispensing,
  type EPrescription,
  type EPrescriptionStatus,
} from '../../api/erx';
import { Badge, Table } from '../../components/ui';
import { formatDate, formatDateTime } from '../../format';
import { t } from '../../i18n';

export function ErxStatusBadge({ status }: { status: EPrescriptionStatus }) {
  return <Badge tone={erxStatusTone(status)}>{erxStatusLabel(status)}</Badge>;
}

/** The e-prescription code as a QR code (pharmacies can scan it instead of typing it). */
export function CodeQr({ code, size = 160 }: { code: string; size?: number }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    QRCode.toDataURL(code.replace(/-/g, ''), {
      margin: 1,
      width: size * 2,
      errorCorrectionLevel: 'M',
    })
      .then((s) => live && setSrc(s))
      .catch(() => live && setSrc(null));
    return () => {
      live = false;
    };
  }, [code, size]);
  if (!src) return null;
  return (
    <img
      src={src}
      width={size}
      height={size}
      alt={t('QR code of e-prescription {code}', { code })}
      style={{ background: '#fff', borderRadius: 6 }}
    />
  );
}

/** Large, spaced code that is easy to read out at the pharmacy counter. */
export function CodeText({ code }: { code: string }) {
  return (
    <span
      className="mono"
      style={{ fontSize: '1.5rem', fontWeight: 700, letterSpacing: '0.12em' }}
      aria-label={t('E-prescription code {code}', { code: code.split('').join(' ') })}
    >
      {code}
    </span>
  );
}

/** Validity, supplies and status in one line. */
export function ErxSummary({ e }: { e: EPrescription }) {
  return (
    <span className="row" style={{ flexWrap: 'wrap', gap: '0.4rem' }}>
      <ErxStatusBadge status={e.status} />
      <span className="muted">{suppliesLabel(e)}</span>
      {e.validUntil && (
        <span className="muted">{t('Valid until {date}', { date: formatDate(e.validUntil) })}</span>
      )}
    </span>
  );
}

export function DispensingTable({ items, caption }: { items: Dispensing[]; caption: string }) {
  if (!items.length) return <p className="muted">{t('Not dispensed yet.')}</p>;
  return (
    <Table caption={caption}>
      <thead>
        <tr>
          <th>{t('Supply')}</th>
          <th>{t('Date')}</th>
          <th>{t('Pharmacy|community')}</th>
          <th>{t('Product handed over')}</th>
          <th>{t('Quantity')}</th>
        </tr>
      </thead>
      <tbody>
        {items.map((d) => (
          <tr key={d.id}>
            <td>
              {d.supplyNumber === 0 ? t('First supply') : t('Repeat {n}', { n: d.supplyNumber })}
            </td>
            <td>{formatDateTime(d.dispensedAt)}</td>
            <td>
              {d.pharmacyName}
              <div className="muted">{d.pharmacistName}</div>
            </td>
            <td>
              {d.productName}
              {d.reversedAt && (
                <div>
                  <Badge tone="neutral">{t('Reversed')}</Badge>{' '}
                  <span className="muted">{d.reversalReason}</span>
                </div>
              )}
            </td>
            <td>{d.quantity}</td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}
