import { useMemo, useState, type FormEvent } from 'react';
import {
  addDays,
  CERTIFICATE_KINDS,
  daysCovered,
  FITNESS_KINDS,
  kindLabel,
  MAX_DAYS_PER_CERTIFICATE,
  MEDICAL_COMMISSION_DAYS,
  outcomeLabel,
  todayKosovo,
  useIssueCertificate,
  type CertificateKind,
  type CertificateListItem,
  type FitnessOutcome,
  type IssuedCertificate,
} from '../../api/certificates';
import {
  Alert,
  Button,
  Dialog,
  ErrorAlert,
  SelectField,
  TextAreaField,
  TextField,
} from '../../components/ui';
import { formatDate } from '../../format';
import { t, tn } from '../../i18n';

const OUTCOMES: FitnessOutcome[] = ['FIT', 'FIT_WITH_RESTRICTIONS', 'UNFIT'];

/** Issue a certificate; sick leave can extend the latest certificate of an absence. */
export function IssueCertificateDialog({
  open,
  onClose,
  patientId,
  existing,
  onIssued,
}: {
  open: boolean;
  onClose: () => void;
  patientId: string;
  existing: CertificateListItem[];
  onIssued: (c: IssuedCertificate) => void;
}) {
  const issue = useIssueCertificate(patientId);
  const today = todayKosovo();
  const [kind, setKind] = useState<CertificateKind>('SICK_LEAVE');
  const [extendsId, setExtendsId] = useState('');
  const [startDate, setStartDate] = useState(today);
  const [endDate, setEndDate] = useState(addDays(today, 2));
  const [outcome, setOutcome] = useState<FitnessOutcome>('FIT');

  // Sick leave that is still open for extension: issued, not yet extended.
  const extendable = existing.filter(
    (c) => c.kind === 'SICK_LEAVE' && c.status === 'ISSUED' && !c.extendedById && c.endDate,
  );
  const previous = extendable.find((c) => c.id === extendsId) ?? null;
  const absence = kind === 'SICK_LEAVE' || kind === 'SCHOOL_ABSENCE';
  const fitness = FITNESS_KINDS.includes(kind);
  const effectiveStart = previous ? addDays(previous.endDate!, 1) : startDate;
  const days = endDate && endDate >= effectiveStart ? daysCovered(effectiveStart, endDate) : null;
  const chain = previous && days ? (previous.chainDays ?? 0) + days : days;
  const backdated = effectiveStart < addDays(today, -3);

  const kindOptions = useMemo(
    () => CERTIFICATE_KINDS.map((k) => ({ value: k, label: kindLabel(k) })),
    [],
  );

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const text = (name: string) => String(f.get(name) ?? '').trim() || null;
    issue.mutate(
      {
        kind,
        startDate: effectiveStart,
        endDate: absence || fitness || kind === 'GENERAL' ? endDate || null : null,
        icd10Code: text('icd10Code'),
        diagnosisOnCertificate: f.get('diagnosisOnCertificate') === 'on',
        outcome: fitness ? outcome : null,
        restrictions: fitness && outcome === 'FIT_WITH_RESTRICTIONS' ? text('restrictions') : null,
        purpose: text('purpose'),
        remarks: text('remarks'),
        extendsCertificateId: kind === 'SICK_LEAVE' && previous ? previous.id : null,
      },
      {
        onSuccess: (c) => {
          onIssued(c);
          onClose();
        },
      },
    );
  }

  function changeKind(k: CertificateKind) {
    setKind(k);
    setExtendsId('');
    if (k === 'SICK_LEAVE' || k === 'SCHOOL_ABSENCE') setEndDate(addDays(startDate, 2));
    else if (FITNESS_KINDS.includes(k)) setEndDate(addDays(startDate, 364));
    else setEndDate('');
  }

  return (
    <Dialog open={open} onClose={onClose} title={t('Issue a medical certificate')} wide>
      <form onSubmit={onSubmit} className="stack">
        <div className="form-grid">
          <SelectField
            label={t('Kind of certificate')}
            name="kind"
            value={kind}
            onChange={(e) => changeKind(e.target.value as CertificateKind)}
            options={kindOptions}
          />
          {kind === 'SICK_LEAVE' && extendable.length > 0 && (
            <SelectField
              label={t('Extends')}
              name="extends"
              value={extendsId}
              onChange={(e) => {
                setExtendsId(e.target.value);
                const prev = extendable.find((c) => c.id === e.target.value);
                if (prev?.endDate) setEndDate(addDays(prev.endDate, 7));
              }}
              options={[
                { value: '', label: t('New sick leave') },
                ...extendable.map((c) => ({
                  value: c.id,
                  label: t('Extension of {serial} (until {date})', {
                    serial: c.serialNumber,
                    date: formatDate(c.endDate),
                  }),
                })),
              ]}
            />
          )}
        </div>
        <div className="form-grid">
          <TextField
            label={fitness ? t('Examined on') : t('From')}
            name="startDate"
            type="date"
            required
            value={effectiveStart}
            disabled={Boolean(previous)}
            onChange={(e) => setStartDate(e.target.value)}
            hint={
              previous
                ? t('An extension starts the day after the previous certificate.')
                : undefined
            }
          />
          {(absence || fitness || kind === 'GENERAL') && (
            <TextField
              label={absence ? t('Until (last day)') : t('Valid until|certificate')}
              name="endDate"
              type="date"
              required={absence}
              value={endDate}
              min={effectiveStart}
              onChange={(e) => setEndDate(e.target.value)}
              hint={
                absence && days
                  ? tn(days, '{count} day', '{count} days', { count: days })
                  : undefined
              }
            />
          )}
        </div>
        {absence && days !== null && days > MAX_DAYS_PER_CERTIFICATE && (
          <Alert tone="warning" title={t('At most 30 days per certificate')}>
            {t('Issue the first 30 days now and an extension later.')}
          </Alert>
        )}
        {kind === 'SICK_LEAVE' && chain !== null && chain > MEDICAL_COMMISSION_DAYS && (
          <Alert tone="warning" title={t('Medical commission required')}>
            {t(
              'This absence will reach {count} days in a row. Sick leave of more than 90 days in a row needs assessment by a medical commission.',
              { count: chain },
            )}
          </Alert>
        )}
        {fitness && (
          <div className="form-grid">
            <SelectField
              label={t('Assessment')}
              name="outcome"
              value={outcome}
              onChange={(e) => setOutcome(e.target.value as FitnessOutcome)}
              options={OUTCOMES.map((o) => ({ value: o, label: outcomeLabel(o) }))}
            />
            {outcome === 'FIT_WITH_RESTRICTIONS' && (
              <TextField label={t('Restrictions')} name="restrictions" required maxLength={500} />
            )}
          </div>
        )}
        <TextField
          label={kind === 'GENERAL' ? t('Issued for') : t('Issued for (optional)')}
          name="purpose"
          required={kind === 'GENERAL'}
          maxLength={200}
          hint={t('e.g. for the employer, the school, the sports club')}
        />
        <div className="form-grid">
          <TextField
            label={t('Diagnosis (ICD-10, internal)')}
            name="icd10Code"
            maxLength={10}
            hint={t('Kept in the record; not printed unless the patient asks.')}
          />
          <label className="checkbox" style={{ alignSelf: 'center' }}>
            <input type="checkbox" name="diagnosisOnCertificate" />{' '}
            {t('The patient asked for the diagnosis on the certificate')}
          </label>
        </div>
        <TextAreaField
          label={backdated ? t('Remarks (required: why it starts in the past)') : t('Remarks')}
          name="remarks"
          rows={2}
          maxLength={2000}
          required={backdated}
          hint={t('Internal – not shown when the certificate is verified.')}
        />
        <ErrorAlert error={issue.error} />
        <div className="form-actions">
          <Button variant="secondary" onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button type="submit" loading={issue.isPending}>
            {t('Issue certificate')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
