import { useState, type FormEvent } from 'react';
import {
  APPROVAL_STATUS,
  HAI_STATUS,
  HAI_TYPES,
  haiCriteria,
  haiTypeLabel,
  PRECAUTIONS,
  precautionGuidance,
  precautionLabel,
  REVIEW_OUTCOMES,
  reviewOutcomeLabel,
  useEndIsolation,
  usePatientInfection,
  useReportHai,
  useReviewAntimicrobial,
  useReviewHai,
  useStartIsolation,
  type Approval,
  type HaiType,
  type Precaution,
  type ReviewOutcome,
} from '../../../api/infection';
import {
  Alert,
  Badge,
  Button,
  Card,
  Dialog,
  EmptyState,
  ErrorAlert,
  QueryView,
  SelectField,
  Table,
  TextAreaField,
  TextField,
} from '../../../components/ui';
import { formatDateTime } from '../../../format';
import { t } from '../../../i18n';
import { IsolationBadge } from '../../infection/IsolationBadge';
import { useChartRole } from './shared';

/** Infection prevention in the chart: isolation precautions, infections and restricted antibiotics. */
export function InfectionTab({ patientId }: { patientId: string }) {
  const query = usePatientInfection(patientId);
  return (
    <QueryView query={query}>
      {(d) => (
        <div className="stack">
          <IsolationCard patientId={patientId} data={d} />
          <HaiCard patientId={patientId} data={d} />
          <AntimicrobialCard patientId={patientId} items={d.antimicrobials} />
        </div>
      )}
    </QueryView>
  );
}

type Data = NonNullable<ReturnType<typeof usePatientInfection>['data']>;

function IsolationCard({ patientId, data }: { patientId: string; data: Data }) {
  const start = useStartIsolation(patientId);
  const end = useEndIsolation(patientId);
  const [precaution, setPrecaution] = useState<Precaution>('CONTACT');
  const [reason, setReason] = useState('');
  const [ending, setEnding] = useState<string | null>(null);
  const [endReason, setEndReason] = useState('');
  return (
    <Card title={t('Isolation precautions')}>
      {data.activeIsolations.length ? (
        <ul className="stack" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {data.activeIsolations.map((i) => (
            <li key={i.id} className="stack" style={{ gap: '0.25rem' }}>
              <div
                className="row"
                style={{ gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}
              >
                <IsolationBadge precaution={i.precaution} reason={i.reason} />
                <span className="muted">
                  {t('Since {date} · {name}', {
                    date: formatDateTime(i.startedAt),
                    name: i.orderedBy,
                  })}
                </span>
                <Button size="sm" variant="secondary" onClick={() => setEnding(i.id)}>
                  {t('End precautions')}
                </Button>
              </div>
              <span className="muted">{precautionGuidance(i.precaution)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">{t('No isolation precautions')}</p>
      )}
      <form
        className="form-grid"
        style={{ marginTop: '1rem' }}
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          start.mutate({ precaution, reason }, { onSuccess: () => setReason('') });
        }}
      >
        <SelectField
          label={t('Precautions')}
          name="precaution"
          value={precaution}
          onChange={(e) => setPrecaution(e.target.value as Precaution)}
          options={PRECAUTIONS.map((p) => ({ value: p, label: precautionLabel(p) }))}
        />
        <TextField
          label={t('Organism or reason')}
          name="reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder={t('e.g. MRSA, suspected TB, neutropenia')}
          required
          minLength={2}
          maxLength={200}
        />
        <div className="form-actions">
          <Button type="submit" loading={start.isPending}>
            {t('Start precautions')}
          </Button>
        </div>
      </form>
      <ErrorAlert error={start.error} />
      {data.isolationHistory.length > 0 && (
        <details style={{ marginTop: '1rem' }}>
          <summary>
            {t('Earlier precautions ({count})', { count: data.isolationHistory.length })}
          </summary>
          <Table caption={t('Earlier precautions')}>
            <thead>
              <tr>
                <th>{t('Precautions')}</th>
                <th>{t('Started')}</th>
                <th>{t('Ended')}</th>
                <th>{t('Reason for ending')}</th>
              </tr>
            </thead>
            <tbody>
              {data.isolationHistory.map((i) => (
                <tr key={i.id}>
                  <td>
                    {precautionLabel(i.precaution)} · {i.reason}
                  </td>
                  <td>{formatDateTime(i.startedAt)}</td>
                  <td>{i.endedAt ? formatDateTime(i.endedAt) : '—'}</td>
                  <td>{i.endReason}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        </details>
      )}
      <Dialog open={ending !== null} onClose={() => setEnding(null)} title={t('End precautions')}>
        <form
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (!ending) return;
            end.mutate(
              { id: ending, reason: endReason },
              {
                onSuccess: () => {
                  setEnding(null);
                  setEndReason('');
                },
              },
            );
          }}
        >
          <TextAreaField
            label={t('Reason for ending')}
            name="reason"
            value={endReason}
            onChange={(e) => setEndReason(e.target.value)}
            required
            minLength={3}
            maxLength={300}
            rows={2}
            hint={t('e.g. three negative screens, treatment completed, diagnosis excluded')}
          />
          <ErrorAlert error={end.error} />
          <div className="form-actions">
            <Button variant="secondary" onClick={() => setEnding(null)}>
              {t('Cancel')}
            </Button>
            <Button type="submit" loading={end.isPending}>
              {t('End precautions')}
            </Button>
          </div>
        </form>
      </Dialog>
    </Card>
  );
}

function HaiCard({ patientId, data }: { patientId: string; data: Data }) {
  const report = useReportHai(patientId);
  const review = useReviewHai(patientId);
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<HaiType>('CAUTI');
  const [device, setDevice] = useState(false);
  return (
    <Card
      title={t('Healthcare-associated infections')}
      actions={
        <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
          {t('Report a possible infection')}
        </Button>
      }
    >
      {data.hai.length ? (
        <Table caption={t('Healthcare-associated infections')}>
          <thead>
            <tr>
              <th>{t('Infection')}</th>
              <th>{t('Onset')}</th>
              <th>{t('Ward')}</th>
              <th>{t('Status')}</th>
              {data.infectionControl && <th>{t('Review')}</th>}
            </tr>
          </thead>
          <tbody>
            {data.hai.map((h) => (
              <tr key={h.id}>
                <td>
                  {haiTypeLabel(h.type)}
                  {h.organism && <div className="muted">{h.organism}</div>}
                  {h.deviceRelated && <div className="muted">{t('Device-related')}</div>}
                </td>
                <td>{formatDateTime(h.onsetAt)}</td>
                <td>{h.unitName ?? '—'}</td>
                <td>
                  <Badge tone={HAI_STATUS[h.status].tone}>{t(HAI_STATUS[h.status].label)}</Badge>
                </td>
                {data.infectionControl && (
                  <td>
                    {h.status === 'SUSPECTED' && (
                      <div className="row" style={{ gap: '0.25rem' }}>
                        <Button
                          size="sm"
                          onClick={() => review.mutate({ id: h.id, status: 'CONFIRMED' })}
                        >
                          {t('Confirm')}
                        </Button>
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => review.mutate({ id: h.id, status: 'RULED_OUT' })}
                        >
                          {t('Rule out')}
                        </Button>
                      </div>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </Table>
      ) : (
        <p className="muted">{t('No healthcare-associated infections recorded')}</p>
      )}
      <ErrorAlert error={review.error} />
      <Dialog open={open} onClose={() => setOpen(false)} title={t('Report a possible infection')}>
        <form
          onSubmit={(e: FormEvent<HTMLFormElement>) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            const onset = String(f.get('onsetAt') ?? '');
            report.mutate(
              {
                type,
                organism: String(f.get('organism') ?? '') || undefined,
                onsetAt: new Date(onset).toISOString(),
                deviceRelated: device,
                notes: String(f.get('notes') ?? '') || undefined,
              },
              { onSuccess: () => setOpen(false) },
            );
          }}
        >
          <SelectField
            label={t('Type of infection')}
            name="type"
            value={type}
            onChange={(e) => setType(e.target.value as HaiType)}
            options={HAI_TYPES.map((h) => ({ value: h, label: haiTypeLabel(h) }))}
            hint={haiCriteria(type)}
          />
          <div className="form-grid">
            <TextField label={t('Organism')} name="organism" maxLength={120} />
            <TextField label={t('Onset')} name="onsetAt" type="datetime-local" required />
          </div>
          <label className="row" style={{ gap: '0.5rem' }}>
            <input type="checkbox" checked={device} onChange={(e) => setDevice(e.target.checked)} />
            {t('Related to a device (line, catheter, ventilator)')}
          </label>
          <TextAreaField label={t('Notes')} name="notes" maxLength={2000} rows={3} />
          <Alert tone="info">
            {t('The infection control team reviews the report and confirms or rules it out.')}
          </Alert>
          <ErrorAlert error={report.error} />
          <div className="form-actions">
            <Button variant="secondary" onClick={() => setOpen(false)}>
              {t('Cancel')}
            </Button>
            <Button type="submit" loading={report.isPending}>
              {t('Report')}
            </Button>
          </div>
        </form>
      </Dialog>
    </Card>
  );
}

function AntimicrobialCard({ patientId, items }: { patientId: string; items: Approval[] }) {
  const { isDoctor } = useChartRole();
  const review = useReviewAntimicrobial(patientId);
  const [reviewing, setReviewing] = useState<Approval | null>(null);
  const [outcome, setOutcome] = useState<ReviewOutcome>('CONTINUE');
  return (
    <Card title={t('Restricted antibiotics')}>
      {items.length ? (
        <Table caption={t('Restricted antibiotics')}>
          <thead>
            <tr>
              <th>{t('Medicine')}</th>
              <th>{t('Indication')}</th>
              <th>{t('Approval')}</th>
              <th>{t('72-hour review')}</th>
            </tr>
          </thead>
          <tbody>
            {items.map((a) => (
              <tr key={a.id}>
                <td>
                  {a.medication}
                  <div className="muted">
                    {a.dosage} · {a.frequency}
                  </div>
                </td>
                <td>
                  {a.indication}
                  <div className="muted">{a.justification}</div>
                </td>
                <td>
                  <Badge tone={APPROVAL_STATUS[a.status].tone}>
                    {t(APPROVAL_STATUS[a.status].label)}
                  </Badge>
                  {a.decisionNote && <div className="muted">{a.decisionNote}</div>}
                </td>
                <td>
                  {a.reviewOutcome ? (
                    reviewOutcomeLabel(a.reviewOutcome)
                  ) : a.reviewNeeded ? (
                    <div className="stack" style={{ gap: '0.25rem' }}>
                      {a.reviewOverdue ? (
                        <Badge tone="danger">{t('Review overdue')}</Badge>
                      ) : (
                        <span className="muted">
                          {t('Due {date}', {
                            date: a.reviewDueAt ? formatDateTime(a.reviewDueAt) : '—',
                          })}
                        </span>
                      )}
                      {isDoctor && (
                        <Button size="sm" variant="secondary" onClick={() => setReviewing(a)}>
                          {t('Record the review')}
                        </Button>
                      )}
                    </div>
                  ) : (
                    '—'
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      ) : (
        <EmptyState title={t('No restricted antibiotics')}>
          {t(
            'Reserve antibiotics (e.g. meropenem, vancomycin IV, colistin) need the indication and a justification when prescribed; the stewardship team approves them.',
          )}
        </EmptyState>
      )}
      <Dialog
        open={reviewing !== null}
        onClose={() => setReviewing(null)}
        title={t('72-hour antibiotic review')}
      >
        <form
          onSubmit={(e: FormEvent<HTMLFormElement>) => {
            e.preventDefault();
            if (!reviewing) return;
            const note = String(new FormData(e.currentTarget).get('note') ?? '');
            review.mutate(
              { id: reviewing.id, outcome, note: note || undefined },
              { onSuccess: () => setReviewing(null) },
            );
          }}
        >
          <p>
            <strong>{reviewing?.medication}</strong>
          </p>
          <SelectField
            label={t('Decision')}
            name="outcome"
            value={outcome}
            onChange={(e) => setOutcome(e.target.value as ReviewOutcome)}
            options={REVIEW_OUTCOMES.map((o) => ({ value: o, label: reviewOutcomeLabel(o) }))}
            hint={t(
              'Review the cultures and the clinical response: continue, narrow, switch to oral or stop.',
            )}
          />
          {outcome === 'STOP' && (
            <Alert tone="info">{t('Stop the prescription in the Medications tab as well.')}</Alert>
          )}
          <TextAreaField label={t('Notes')} name="note" maxLength={500} rows={2} />
          <ErrorAlert error={review.error} />
          <div className="form-actions">
            <Button variant="secondary" onClick={() => setReviewing(null)}>
              {t('Cancel')}
            </Button>
            <Button type="submit" loading={review.isPending}>
              {t('Save')}
            </Button>
          </div>
        </form>
      </Dialog>
    </Card>
  );
}
