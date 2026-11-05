import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactNode } from 'react';
import { api } from '../../../api/client';
import {
  AUTOPSY_LABEL,
  AUTOPSY_STATUSES,
  FORENSIC_MANNERS,
  LINE_LABEL,
  lowestPartOneCode,
  MANNER_LABEL,
  MANNERS_OF_DEATH,
  PLACE_LABEL,
  PLACES_OF_DEATH,
  PREGNANCY_LABEL,
  PREGNANCY_STATUSES,
  useAmendDeath,
  useDiscardDeath,
  usePatientDeath,
  useSaveDeath,
  useSignDeath,
  type CauseLine,
  type DeathCheck,
  type DeathFields,
  type DeathRecord,
} from '../../../api/deaths';
import {
  Alert,
  Badge,
  Button,
  Card,
  DefinitionList,
  Dialog,
  EmptyState,
  ErrorAlert,
  QueryView,
  SelectField,
  Table,
  TextAreaField,
  TextField,
} from '../../../components/ui';
import { formatDate, formatDateTime } from '../../../format';
import { t } from '../../../i18n';

const LINES: CauseLine[] = ['a', 'b', 'c', 'd', 'II'];

interface Demographics {
  firstName: string;
  lastName: string;
  dateOfBirth: string;
  sex: string;
  nationalId: string;
}

const ageAt = (dob: string, at: Date) => {
  const d = new Date(`${dob}T00:00:00Z`);
  let a = at.getUTCFullYear() - d.getUTCFullYear();
  const m = at.getUTCMonth() - d.getUTCMonth();
  if (m < 0 || (m === 0 && at.getUTCDate() < d.getUTCDate())) a--;
  return a;
};

/** ISO instant → value for <input type="datetime-local"> in local time. */
function toLocalInput(iso: string | undefined) {
  const d = iso ? new Date(iso) : new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

type CauseState = Record<CauseLine, { text: string; icd10: string; interval: string }>;

function causeState(fields?: Partial<DeathFields>): CauseState {
  const empty = () => ({ text: '', icd10: '', interval: '' });
  const s = { a: empty(), b: empty(), c: empty(), d: empty(), II: empty() } as CauseState;
  for (const c of fields?.causes ?? []) {
    s[c.line] = { text: c.text, icd10: c.icd10 ?? '', interval: c.interval ?? '' };
  }
  return s;
}

/** The WHO form (Part I a–d, Part II, manner, autopsy, pregnancy, perinatal, forensic report). */
function DeathForm({
  initial,
  patient,
  submitLabel,
  pending,
  error,
  onSubmit,
  children,
}: {
  initial?: Partial<DeathFields>;
  patient: Demographics;
  submitLabel: string;
  pending: boolean;
  error: unknown;
  onSubmit: (fields: DeathFields) => void;
  children?: ReactNode;
}) {
  const [diedAt, setDiedAt] = useState(toLocalInput(initial?.diedAt));
  const [causes, setCauses] = useState<CauseState>(causeState(initial));
  const [underlying, setUnderlying] = useState(initial?.underlyingCauseIcd10 ?? '');
  const [manner, setManner] = useState<string>(initial?.mannerOfDeath ?? 'NATURAL');
  const [forensics, setForensics] = useState(Boolean(initial?.reportedToForensics));
  const [perinatal, setPerinatal] = useState({
    birthWeightGrams: initial?.perinatal?.birthWeightGrams?.toString() ?? '',
    gestationWeeks: initial?.perinatal?.gestationWeeks?.toString() ?? '',
    hoursSurvived: initial?.perinatal?.hoursSurvived?.toString() ?? '',
    maternalConditions: initial?.perinatal?.maternalConditions ?? '',
  });

  const at = diedAt ? new Date(diedAt) : new Date();
  const age = ageAt(patient.dateOfBirth, at);
  const ageDays =
    (at.getTime() - new Date(`${patient.dateOfBirth}T00:00:00Z`).getTime()) / 86_400_000;
  const askPregnancy = patient.sex === 'FEMALE' && age >= 10 && age <= 54;
  const askPerinatal = ageDays < 365;
  const fieldsCauses = LINES.filter((l) => causes[l].text.trim()).map((line) => ({
    line,
    text: causes[line].text.trim(),
    icd10: causes[line].icd10.trim().toUpperCase() || null,
    interval: causes[line].interval.trim() || null,
  }));
  const suggested = lowestPartOneCode(fieldsCauses);

  const setCause = (line: CauseLine, key: 'text' | 'icd10' | 'interval', value: string) =>
    setCauses((s) => ({ ...s, [line]: { ...s[line], [key]: value } }));

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const num = (v: string) => (v.trim() ? Number(v) : null);
    onSubmit({
      diedAt: new Date(diedAt).toISOString(),
      placeOfDeath: form.get('placeOfDeath') as DeathFields['placeOfDeath'],
      placeDetail: String(form.get('placeDetail') ?? '').trim() || null,
      causes: fieldsCauses,
      underlyingCauseIcd10: (underlying.trim() || suggested || '').toUpperCase(),
      mannerOfDeath: manner as DeathFields['mannerOfDeath'],
      autopsy: form.get('autopsy') as DeathFields['autopsy'],
      pregnancyStatus: askPregnancy
        ? (form.get('pregnancyStatus') as DeathFields['pregnancyStatus']) || null
        : null,
      perinatal: askPerinatal
        ? {
            birthWeightGrams: num(perinatal.birthWeightGrams),
            gestationWeeks: num(perinatal.gestationWeeks),
            hoursSurvived: num(perinatal.hoursSurvived),
            maternalConditions: perinatal.maternalConditions.trim() || null,
          }
        : null,
      reportedToForensics: forensics,
    });
  };

  return (
    <form onSubmit={submit} className="stack">
      <div className="form-grid">
        <TextField
          label={t('Date and time of death')}
          type="datetime-local"
          required
          value={diedAt}
          onChange={(e) => setDiedAt(e.target.value)}
        />
        <SelectField
          label={t('Place of death')}
          name="placeOfDeath"
          required
          defaultValue={initial?.placeOfDeath ?? 'HOSPITAL'}
          options={PLACES_OF_DEATH.map((p) => ({ value: p, label: t(PLACE_LABEL[p]) }))}
        />
        <TextField
          label={t('Place details')}
          name="placeDetail"
          maxLength={200}
          defaultValue={initial?.placeDetail ?? ''}
          hint={t('e.g. ward, address or road')}
        />
      </div>

      <fieldset className="stack">
        <legend>{t('Part I – the chain of events leading directly to death')}</legend>
        <p className="muted">
          {t(
            'Start with the immediate cause on line (a) and go down to the condition that started the sequence. Do not enter the mode of dying (e.g. cardiac arrest) alone.',
          )}
        </p>
        {LINES.map((line) => (
          <div key={line} className="form-grid" role="group" aria-label={t(LINE_LABEL[line])}>
            {line === 'II' && (
              <p className="muted" style={{ gridColumn: '1 / -1', margin: 0 }}>
                <strong>{t('Part II')}</strong> –{' '}
                {t('other significant conditions contributing to death, not in the chain')}
              </p>
            )}
            <TextField
              label={t(LINE_LABEL[line])}
              value={causes[line].text}
              required={line === 'a'}
              maxLength={300}
              onChange={(e) => setCause(line, 'text', e.target.value)}
            />
            <TextField
              label={t('ICD-10 code')}
              value={causes[line].icd10}
              maxLength={7}
              pattern="[A-Za-z][0-9]{2}(\.[0-9A-Za-z]{1,2})?"
              required={line !== 'II' && Boolean(causes[line].text.trim())}
              onChange={(e) => setCause(line, 'icd10', e.target.value)}
            />
            <TextField
              label={t('Interval from onset to death')}
              value={causes[line].interval}
              maxLength={50}
              hint={t('e.g. 2 hours, 5 years')}
              onChange={(e) => setCause(line, 'interval', e.target.value)}
            />
          </div>
        ))}
      </fieldset>

      <div className="form-grid">
        <TextField
          label={t('Underlying cause of death (ICD-10)')}
          value={underlying}
          required
          maxLength={7}
          pattern="[A-Za-z][0-9]{2}(\.[0-9A-Za-z]{1,2})?"
          onChange={(e) => setUnderlying(e.target.value)}
          hint={
            suggested
              ? t('Normally the lowest completed line of Part I: {code}', { code: suggested })
              : t('Normally the lowest completed line of Part I')
          }
        />
        <SelectField
          label={t('Manner of death')}
          required
          value={manner}
          onChange={(e) => {
            setManner(e.target.value);
            if (FORENSIC_MANNERS.has(e.target.value)) setForensics(true);
          }}
          options={MANNERS_OF_DEATH.map((m) => ({ value: m, label: t(MANNER_LABEL[m]) }))}
        />
        <SelectField
          label={t('Autopsy')}
          name="autopsy"
          defaultValue={initial?.autopsy ?? 'NONE'}
          options={AUTOPSY_STATUSES.map((a) => ({ value: a, label: t(AUTOPSY_LABEL[a]) }))}
        />
        {askPregnancy && (
          <SelectField
            label={t('Pregnancy status')}
            name="pregnancyStatus"
            required
            defaultValue={initial?.pregnancyStatus ?? ''}
            placeholder={t('Choose…')}
            options={PREGNANCY_STATUSES.map((p) => ({ value: p, label: t(PREGNANCY_LABEL[p]) }))}
          />
        )}
      </div>

      {askPerinatal && (
        <fieldset className="form-grid">
          <legend>{t('Death in the first year of life')}</legend>
          <TextField
            label={t('Birth weight (g)')}
            type="number"
            min={100}
            max={7000}
            required
            value={perinatal.birthWeightGrams}
            onChange={(e) => setPerinatal((p) => ({ ...p, birthWeightGrams: e.target.value }))}
          />
          <TextField
            label={t('Gestation (completed weeks)')}
            type="number"
            min={16}
            max={45}
            required
            value={perinatal.gestationWeeks}
            onChange={(e) => setPerinatal((p) => ({ ...p, gestationWeeks: e.target.value }))}
          />
          <TextField
            label={t('Hours survived')}
            type="number"
            min={0}
            value={perinatal.hoursSurvived}
            onChange={(e) => setPerinatal((p) => ({ ...p, hoursSurvived: e.target.value }))}
          />
          <TextField
            label={t('Conditions of the mother')}
            maxLength={500}
            value={perinatal.maternalConditions}
            onChange={(e) => setPerinatal((p) => ({ ...p, maternalConditions: e.target.value }))}
          />
        </fieldset>
      )}

      <label className="row" style={{ gap: '0.5rem' }}>
        <input
          type="checkbox"
          checked={forensics}
          onChange={(e) => setForensics(e.target.checked)}
        />
        {t('Reported to the prosecutor and forensic medicine')}
      </label>
      {FORENSIC_MANNERS.has(manner) && !forensics && (
        <Alert tone="warning">
          {t(
            'Deaths from external causes or under investigation must be reported to the prosecutor and forensic medicine',
          )}
        </Alert>
      )}
      {children}
      <ErrorAlert error={error} />
      <div className="form-actions">
        <Button type="submit" loading={pending}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}

function CheckList({ items, tone }: { items: DeathCheck[]; tone: 'danger' | 'warning' }) {
  if (!items.length) return null;
  return (
    <Alert
      tone={tone}
      title={tone === 'danger' ? t('To complete before signing') : t('Check before signing')}
    >
      <ul>
        {items.map((i) => (
          <li key={i.code}>{t(i.message)}</li>
        ))}
      </ul>
    </Alert>
  );
}

/** Printable certificate view (effective values; amendments listed below). */
function CertificateView({ record, patient }: { record: DeathRecord; patient: Demographics }) {
  return (
    <div className="stack death-certificate">
      <DefinitionList
        items={[
          [t('Death certificate number'), record.certificateNumber ?? t('Draft – not yet signed')],
          [t('Name'), `${patient.firstName} ${patient.lastName}`],
          [t('National ID'), patient.nationalId],
          [t('Date of birth'), formatDate(patient.dateOfBirth)],
          [t('Date and time of death'), formatDateTime(record.diedAt)],
          [
            t('Place of death'),
            `${t(PLACE_LABEL[record.placeOfDeath])}${record.placeDetail ? ` – ${record.placeDetail}` : ''}`,
          ],
          [t('Manner of death'), t(MANNER_LABEL[record.mannerOfDeath])],
          [t('Autopsy'), t(AUTOPSY_LABEL[record.autopsy])],
          ...(record.pregnancyStatus
            ? ([[t('Pregnancy status'), t(PREGNANCY_LABEL[record.pregnancyStatus])]] as [
                string,
                string,
              ][])
            : []),
          [
            t('Reported to the prosecutor and forensic medicine'),
            record.reportedToForensics ? t('Yes') : t('No'),
          ],
        ]}
      />
      <Table caption={t('Cause of death')}>
        <thead>
          <tr>
            <th scope="col">{t('Line')}</th>
            <th scope="col">{t('Condition')}</th>
            <th scope="col">{t('ICD-10 code')}</th>
            <th scope="col">{t('Interval from onset to death')}</th>
          </tr>
        </thead>
        <tbody>
          {record.causes.map((c) => (
            <tr key={c.line}>
              <td>{c.line === 'II' ? t('Part II') : `I (${c.line})`}</td>
              <td>{c.text}</td>
              <td>
                <code>{c.icd10 ?? '—'}</code>
              </td>
              <td>{c.interval ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </Table>
      <p>
        <strong>{t('Underlying cause of death (ICD-10)')}:</strong>{' '}
        <code>{record.underlyingCauseIcd10}</code>
      </p>
      <p className="muted">
        {record.signedAt
          ? t('Certified by {doctor}, {facility} – signed {date}', {
              doctor: record.certifiedBy.name ?? '—',
              facility: record.facility.name ?? '—',
              date: formatDateTime(record.signedAt),
            })
          : t('Drafted by {doctor}', { doctor: record.certifiedBy.name ?? '—' })}
      </p>
      {record.civilRegistryAcknowledgedAt && (
        <p className="muted">
          {t('Registered by the civil registry on {date} (reference {reference})', {
            date: formatDateTime(record.civilRegistryAcknowledgedAt),
            reference: record.civilRegistryReference ?? '—',
          })}
        </p>
      )}
    </div>
  );
}

const FIELD_LABEL: Record<string, string> = {
  diedAt: 'Date and time of death',
  placeOfDeath: 'Place of death',
  placeDetail: 'Place details',
  causes: 'Cause of death',
  underlyingCauseIcd10: 'Underlying cause of death (ICD-10)',
  mannerOfDeath: 'Manner of death',
  autopsy: 'Autopsy',
  pregnancyStatus: 'Pregnancy status',
  perinatal: 'Death in the first year of life',
  reportedToForensics: 'Reported to the prosecutor and forensic medicine',
};

function showValue(field: string, v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  if (field === 'diedAt') return formatDateTime(String(v));
  if (field === 'causes' && Array.isArray(v)) {
    return (v as { line: string; icd10: string | null }[])
      .map((c) => `${c.line}: ${c.icd10 ?? '—'}`)
      .join(', ');
  }
  if (field === 'placeOfDeath') return t(PLACE_LABEL[v as keyof typeof PLACE_LABEL] ?? String(v));
  if (field === 'mannerOfDeath')
    return t(MANNER_LABEL[v as keyof typeof MANNER_LABEL] ?? String(v));
  if (field === 'autopsy') return t(AUTOPSY_LABEL[v as keyof typeof AUTOPSY_LABEL] ?? String(v));
  if (typeof v === 'boolean') return v ? t('Yes') : t('No');
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

export function DeathTab({ patientId }: { patientId: string }) {
  const death = usePatientDeath(patientId);
  const demographics = useQuery({
    queryKey: ['patient', patientId, 'demographics'],
    queryFn: () => api<Demographics>(`/patients/${patientId}`),
  });
  const save = useSaveDeath(patientId);
  const discard = useDiscardDeath(patientId);
  const sign = useSignDeath(patientId);
  const amend = useAmendDeath(patientId);
  const [starting, setStarting] = useState(false);
  const [signing, setSigning] = useState(false);
  const [acknowledged, setAcknowledged] = useState<string[]>([]);
  const [amending, setAmending] = useState(false);
  const [reason, setReason] = useState('');
  const [effects, setEffects] = useState<DeathRecord['effects']>();

  return (
    <QueryView query={death}>
      {(d) => {
        const patient = demographics.data;
        if (!patient) return null;
        const r = d.record;
        if (!r) {
          if (!d.canCertify) return <EmptyState title={t('No death certificate')} />;
          return (
            <Card title={t('Death certificate')}>
              {d.openAdmission && (
                <Alert tone="warning" title={t('The patient is still admitted')}>
                  {t(
                    'You can prepare the certificate now. It can be signed after the ward discharges the patient with the outcome “Deceased”.',
                  )}
                </Alert>
              )}
              {!starting ? (
                <div className="stack">
                  <p className="muted">
                    {t(
                      'Certify a death following the WHO medical certificate of cause of death. Signing records the death, cancels future appointments and waiting-list entries and stops reminders.',
                    )}
                  </p>
                  <div>
                    <Button onClick={() => setStarting(true)}>
                      {t('Start a death certificate')}
                    </Button>
                  </div>
                </div>
              ) : (
                <DeathForm
                  patient={patient}
                  submitLabel={t('Save draft')}
                  pending={save.isPending}
                  error={save.error}
                  onSubmit={(fields) =>
                    save.mutate({ fields }, { onSuccess: () => setStarting(false) })
                  }
                />
              )}
            </Card>
          );
        }

        if (r.status === 'DRAFT') {
          return (
            <Card
              title={t('Death certificate – draft')}
              actions={<Badge tone="warning">{t('Draft')}</Badge>}
            >
              {d.openAdmission && (
                <Alert tone="warning" title={t('The patient is still admitted')}>
                  {t(
                    'You can prepare the certificate now. It can be signed after the ward discharges the patient with the outcome “Deceased”.',
                  )}
                </Alert>
              )}
              <CheckList items={r.checks.problems} tone="danger" />
              <CheckList items={r.checks.warnings} tone="warning" />
              {r.canEdit ? (
                <DeathForm
                  key={r.updatedAt}
                  initial={r}
                  patient={patient}
                  submitLabel={t('Save draft')}
                  pending={save.isPending}
                  error={save.error}
                  onSubmit={(fields) => save.mutate({ id: r.id, fields })}
                >
                  <div className="row">
                    <Button
                      variant="secondary"
                      disabled={r.checks.problems.length > 0 || d.openAdmission}
                      onClick={() => {
                        setAcknowledged([]);
                        sign.reset();
                        setSigning(true);
                      }}
                    >
                      {t('Sign the certificate…')}
                    </Button>
                    <Button
                      variant="ghost"
                      loading={discard.isPending}
                      onClick={() => {
                        if (window.confirm(t('Discard this draft?'))) discard.mutate(r.id);
                      }}
                    >
                      {t('Discard draft')}
                    </Button>
                  </div>
                </DeathForm>
              ) : (
                <CertificateView record={r} patient={patient} />
              )}
              <Dialog
                open={signing}
                onClose={() => setSigning(false)}
                title={t('Sign the death certificate')}
              >
                <div className="stack">
                  <p>
                    {t(
                      'Signing is final: the certificate gets its number, the death is recorded, future appointments and waiting-list entries are cancelled and the patient’s portal account is closed. Later corrections are amendments.',
                    )}
                  </p>
                  {r.checks.warnings.length > 0 && (
                    <fieldset className="stack">
                      <legend>{t('Confirm each warning')}</legend>
                      {r.checks.warnings.map((w) => (
                        <label key={w.code} className="row" style={{ gap: '0.5rem' }}>
                          <input
                            type="checkbox"
                            checked={acknowledged.includes(w.code)}
                            onChange={(e) =>
                              setAcknowledged((a) =>
                                e.target.checked ? [...a, w.code] : a.filter((x) => x !== w.code),
                              )
                            }
                          />
                          {t(w.message)}
                        </label>
                      ))}
                    </fieldset>
                  )}
                  <ErrorAlert error={sign.error} />
                  <div className="form-actions">
                    <Button variant="secondary" onClick={() => setSigning(false)}>
                      {t('Cancel')}
                    </Button>
                    <Button
                      variant="danger"
                      loading={sign.isPending}
                      disabled={acknowledged.length < r.checks.warnings.length}
                      onClick={() =>
                        sign.mutate(
                          { id: r.id, acknowledgedWarnings: acknowledged },
                          {
                            onSuccess: (signed) => {
                              setEffects(signed.effects);
                              setSigning(false);
                            },
                          },
                        )
                      }
                    >
                      {t('Sign')}
                    </Button>
                  </div>
                </div>
              </Dialog>
            </Card>
          );
        }

        return (
          <Card
            title={t('Death certificate {number}', { number: r.certificateNumber ?? '' })}
            actions={
              <div className="row no-print">
                <Button variant="secondary" size="sm" onClick={() => window.print()}>
                  {t('Print')}
                </Button>
                {r.canAmend && (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      amend.reset();
                      setReason('');
                      setAmending(true);
                    }}
                  >
                    {t('Amend…')}
                  </Button>
                )}
              </div>
            }
          >
            {effects && (
              <Alert tone="success" title={t('The death certificate is signed')}>
                {t(
                  'Appointments cancelled: {appointments}. Waiting-list entries removed: {waiting}. Registers closed: {registers}.',
                  {
                    appointments: effects.appointmentsCancelled,
                    waiting: effects.waitingListRemoved,
                    registers: effects.registersLeft,
                  },
                )}
              </Alert>
            )}
            <CertificateView record={r} patient={patient} />
            {r.amendments.length > 0 && (
              <Table caption={t('Amendments')}>
                <thead>
                  <tr>
                    <th scope="col">{t('Date')}</th>
                    <th scope="col">{t('Changes')}</th>
                    <th scope="col">{t('Reason')}</th>
                    <th scope="col">{t('By')}</th>
                  </tr>
                </thead>
                <tbody>
                  {r.amendments.map((a) => (
                    <tr key={a.id}>
                      <td>{formatDateTime(a.createdAt)}</td>
                      <td>
                        <ul>
                          {Object.entries(a.changes).map(([field, [from, to]]) => (
                            <li key={field}>
                              {t(FIELD_LABEL[field] ?? field)}: {showValue(field, from)} →{' '}
                              {showValue(field, to)}
                            </li>
                          ))}
                        </ul>
                      </td>
                      <td>{a.reason}</td>
                      <td>{a.amendedBy ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
            <Dialog
              open={amending}
              onClose={() => setAmending(false)}
              title={t('Amend the death certificate')}
              wide
            >
              <DeathForm
                initial={r}
                patient={patient}
                submitLabel={t('Record the amendment')}
                pending={amend.isPending}
                error={amend.error}
                onSubmit={(fields) => {
                  const { admissionId: _admission, ...changes } = fields;
                  amend.mutate(
                    { id: r.id, changes, reason },
                    { onSuccess: () => setAmending(false) },
                  );
                }}
              >
                <TextAreaField
                  label={t('Reason for the amendment')}
                  required
                  minLength={10}
                  maxLength={500}
                  rows={2}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  hint={t('e.g. autopsy findings, a corrected time of death')}
                />
              </DeathForm>
            </Dialog>
          </Card>
        );
      }}
    </QueryView>
  );
}
