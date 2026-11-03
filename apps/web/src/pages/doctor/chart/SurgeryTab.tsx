import { useState, type FormEvent } from 'react';
import { useConsents } from '../../../api/consent';
import {
  ANAESTHESIA_LABELS,
  LATERALITY_LABELS,
  PRIORITY_LABELS,
  STATUS_LABELS,
  STATUS_TONES,
  procedureLabel,
  useFacilityDoctors,
  usePatientSurgeries,
  useTheatreAction,
  type AnaesthesiaType,
  type Laterality,
  type SurgeryPriority,
  type SurgicalCase,
} from '../../../api/theatre';
import { useUser } from '../../../auth/AuthContext';
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
import { formatDate, formatDateTime } from '../../../format';
import { t, tn } from '../../../i18n';
import { NoteView } from '../../theatre/dialogs';
import { useChartRole } from './shared';

const LATERALITIES: Laterality[] = ['NOT_APPLICABLE', 'LEFT', 'RIGHT', 'BILATERAL'];
const PRIORITIES: SurgeryPriority[] = ['ELECTIVE', 'URGENT', 'EMERGENCY'];
const ANAESTHESIA: AnaesthesiaType[] = [
  'GENERAL',
  'SPINAL',
  'EPIDURAL',
  'REGIONAL_BLOCK',
  'LOCAL',
  'SEDATION',
];

function RequestDialog({
  patientId,
  open,
  onClose,
}: {
  patientId: string;
  open: boolean;
  onClose: () => void;
}) {
  const user = useUser();
  const doctors = useFacilityDoctors();
  const consents = useConsents(open ? patientId : null);
  const [priority, setPriority] = useState<SurgeryPriority>('ELECTIVE');
  const [consentId, setConsentId] = useState('');
  const request = useTheatreAction(
    (body: Record<string, unknown>) => ({ path: '/cases', body }),
    onClose,
  );
  const granted = (consents.data?.treatment ?? []).filter((c) => c.decision === 'GRANTED' && c.id);
  const doctorOptions = (doctors.data ?? []).map((d) => ({
    value: d.id,
    label: d.specialty ? `${d.fullName} · ${d.specialty}` : d.fullName,
  }));

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const get = (k: string) => String(f.get(k) ?? '').trim();
    request.mutate({
      patientId,
      procedure: get('procedure'),
      procedureCode: get('procedureCode') || null,
      laterality: get('laterality'),
      priority,
      indication: get('indication'),
      primarySurgeonId: get('primarySurgeonId'),
      assistantId: get('assistantId') || null,
      anaesthetistId: get('anaesthetistId') || null,
      anaesthesiaType: get('anaesthesiaType') || null,
      estimatedMinutes: Number(get('estimatedMinutes') || 60),
      consentRecordId: consentId || null,
    });
  }

  return (
    <Dialog open={open} onClose={onClose} title={t('Request operation')} wide>
      <form onSubmit={onSubmit}>
        <div className="form-grid">
          <TextField
            label={t('Procedure')}
            name="procedure"
            required
            minLength={3}
            maxLength={300}
          />
          <TextField label={t('Procedure code (optional)')} name="procedureCode" maxLength={20} />
          <SelectField
            label={t('Side')}
            name="laterality"
            required
            placeholder={t('Choose the side')}
            options={LATERALITIES.map((l) => ({ value: l, label: LATERALITY_LABELS[l]() }))}
          />
          <SelectField
            label={t('Priority')}
            name="priority"
            required
            value={priority}
            onChange={(e) => setPriority(e.target.value as SurgeryPriority)}
            options={PRIORITIES.map((p) => ({ value: p, label: PRIORITY_LABELS[p]() }))}
          />
          <SelectField
            label={t('Surgeon')}
            name="primarySurgeonId"
            required
            defaultValue={user.id}
            options={doctorOptions}
          />
          <SelectField
            label={t('Assistant surgeon')}
            name="assistantId"
            placeholder={t('None')}
            options={doctorOptions}
          />
          <SelectField
            label={t('Anaesthetist')}
            name="anaesthetistId"
            placeholder={t('Not yet assigned')}
            options={doctorOptions}
          />
          <SelectField
            label={t('Anaesthesia')}
            name="anaesthesiaType"
            placeholder={t('To be decided')}
            options={ANAESTHESIA.map((a) => ({ value: a, label: ANAESTHESIA_LABELS[a]() }))}
          />
          <TextField
            label={t('Estimated duration (minutes)')}
            name="estimatedMinutes"
            type="number"
            min={5}
            max={1440}
            defaultValue={60}
            required
          />
        </div>
        <TextAreaField
          label={t('Indication')}
          name="indication"
          rows={3}
          minLength={5}
          maxLength={1000}
          required
        />
        <SelectField
          label={t('Treatment consent')}
          name="consentRecordId"
          value={consentId}
          onChange={(e) => setConsentId(e.target.value)}
          placeholder={t('No consent recorded yet')}
          options={granted.map((c) => ({
            value: c.id!,
            label: `${c.procedure ?? ''} · ${formatDate(c.recordedAt)}`,
          }))}
        />
        {!consentId && (
          <Alert tone="warning" title={t('No treatment consent selected')}>
            {priority === 'ELECTIVE'
              ? t(
                  'An elective operation cannot be scheduled until the patient’s treatment consent is recorded (Consent tab).',
                )
              : t(
                  'For urgent and emergency operations the theatre team must record why the operation goes ahead without consent.',
                )}
          </Alert>
        )}
        <ErrorAlert error={request.error ?? doctors.error} />
        <div className="form-actions">
          <Button variant="secondary" onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button type="submit" loading={request.isPending}>
            {t('Request operation')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** The patient's operations: requests, scheduled lists and signed operation notes. */
export function SurgeryTab({ patientId }: { patientId: string }) {
  const { isDoctor } = useChartRole();
  const list = usePatientSurgeries(patientId);
  const [open, setOpen] = useState(false);
  const [viewing, setViewing] = useState<SurgicalCase | null>(null);

  return (
    <Card
      title={t('Operations')}
      actions={
        isDoctor ? (
          <Button size="sm" onClick={() => setOpen(true)}>
            {t('Request operation')}
          </Button>
        ) : undefined
      }
    >
      <QueryView query={list}>
        {(items) =>
          items.length === 0 ? (
            <EmptyState title={t('No operations')} />
          ) : (
            <Table caption={t('Operations')}>
              <thead>
                <tr>
                  <th>{t('Procedure')}</th>
                  <th>{t('Status')}</th>
                  <th>{t('Date')}</th>
                  <th>{t('Team')}</th>
                  <th>
                    <span className="sr-only">{t('Actions')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {(items as SurgicalCase[]).map((c) => (
                  <tr key={c.id}>
                    <td>
                      <strong>{procedureLabel(c)}</strong>
                      {c.procedureCode && <div className="muted mono">{c.procedureCode}</div>}
                      {c.indication && <div className="muted">{c.indication}</div>}
                    </td>
                    <td>
                      <div className="stack" style={{ gap: '0.25rem' }}>
                        <Badge tone={STATUS_TONES[c.status]}>{STATUS_LABELS[c.status]()}</Badge>
                        {c.priority && c.priority !== 'ELECTIVE' && (
                          <Badge tone={c.priority === 'EMERGENCY' ? 'danger' : 'warning'}>
                            {PRIORITY_LABELS[c.priority]()}
                          </Badge>
                        )}
                        {c.status === 'REQUESTED' && !c.consentRecordId && (
                          <small className="muted">{t('No treatment consent recorded')}</small>
                        )}
                      </div>
                    </td>
                    <td>
                      {formatDateTime(c.outOfTheatreAt ?? c.scheduledStart ?? c.createdAt)}
                      {c.estimatedMinutes && c.status !== 'COMPLETED' && (
                        <div className="muted">
                          {tn(c.estimatedMinutes, '{count} minute', '{count} minutes')}
                        </div>
                      )}
                    </td>
                    <td>
                      {t('Surgeon: {name}', { name: c.surgeon })}
                      {c.anaesthetist && (
                        <div className="muted">
                          {t('Anaesthetist: {name}', { name: c.anaesthetist })}
                        </div>
                      )}
                      {c.anaesthesiaType && (
                        <div className="muted">{ANAESTHESIA_LABELS[c.anaesthesiaType]()}</div>
                      )}
                    </td>
                    <td>
                      {c.status === 'COMPLETED' && c.operationNote && (
                        <Button size="sm" variant="secondary" onClick={() => setViewing(c)}>
                          {t('Operation note')}
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )
        }
      </QueryView>
      {isDoctor && (
        <RequestDialog patientId={patientId} open={open} onClose={() => setOpen(false)} />
      )}
      <Dialog
        open={Boolean(viewing)}
        onClose={() => setViewing(null)}
        title={viewing ? procedureLabel(viewing) : ''}
        wide
      >
        {viewing && (
          <>
            <NoteView item={viewing} />
            <div className="form-actions">
              <Button variant="secondary" onClick={() => window.print()}>
                {t('Print')}
              </Button>
            </div>
          </>
        )}
      </Dialog>
    </Card>
  );
}
