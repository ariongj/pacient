import { useState, type FormEvent } from 'react';
import type { Encounter, Immunization } from '../../../api/types';
import {
  Button,
  Card,
  Dialog,
  EmptyState,
  ErrorAlert,
  formValues,
  QueryView,
  Table,
  TextAreaField,
  TextField,
} from '../../../components/ui';
import { formatDateTime } from '../../../format';
import { EncounterSelect, useChartMutation } from './shared';
import { useSection } from './useSection';
import { t } from '../../../i18n';
import {
  doseName,
  useLinkDose,
  useRecordDose,
  useVaccinationStatus,
  type DoseStatus,
} from '../../../api/vaccination';
import { SelectField } from '../../../components/ui';
import { VaccinationSummary, VaccinationTimeline } from '../../vaccination/VaccinationCard';
import '../../vaccination/vaccination.css';
import { RecordHistory } from '../../history/RecordHistory';

/** Local "now" for a datetime-local input's max attribute. */
function localNow() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function RecordedVaccinations({
  patientId,
  encounters,
}: {
  patientId: string;
  encounters: Encounter[];
}) {
  const list = useSection<Immunization>(patientId, 'immunizations');
  const [open, setOpen] = useState(false);
  const create = useChartMutation(
    patientId,
    (body: Record<string, unknown>) => ({ path: '/immunizations', method: 'POST', body }),
    () => setOpen(false),
  );

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const v = formValues(e.currentTarget);
    create.mutate({
      vaccine: v.vaccine,
      ...(v.doseNumber ? { doseNumber: Number(v.doseNumber) } : {}),
      ...(v.lotNumber ? { lotNumber: v.lotNumber } : {}),
      ...(v.site ? { site: v.site } : {}),
      ...(v.administeredAt ? { administeredAt: new Date(v.administeredAt).toISOString() } : {}),
      ...(v.notes ? { notes: v.notes } : {}),
      ...(v.encounterId ? { encounterId: v.encounterId } : {}),
    });
  }

  return (
    <Card
      title={t('Vaccinations')}
      actions={
        <Button size="sm" onClick={() => setOpen(true)}>
          {t('Record vaccination')}
        </Button>
      }
    >
      <QueryView query={list}>
        {(items) =>
          items.length === 0 ? (
            <EmptyState title={t('No vaccinations recorded')} />
          ) : (
            <Table caption={t('Vaccinations')}>
              <thead>
                <tr>
                  <th>{t('Vaccine')}</th>
                  <th className="num">{t('Dose')}</th>
                  <th>{t('Lot')}</th>
                  <th>{t('Site')}</th>
                  <th>{t('Given')}</th>
                  <th>{t('By / where')}</th>
                </tr>
              </thead>
              <tbody>
                {items.map((i) => (
                  <tr key={i.id}>
                    <td>
                      <strong>{i.vaccine}</strong>
                      {i.notes && <div className="muted">{i.notes}</div>}
                      <RecordHistory
                        patientId={patientId}
                        table="immunizations"
                        resourceId={i.id}
                        label={i.vaccine}
                      />
                    </td>
                    <td className="num">{i.doseNumber ?? '—'}</td>
                    <td>{i.lotNumber ?? '—'}</td>
                    <td>{i.site ?? '—'}</td>
                    <td>{formatDateTime(i.administeredAt)}</td>
                    <td>
                      {i.administeredBy}
                      <div className="muted">{i.facilityName}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )
        }
      </QueryView>
      <Dialog open={open} onClose={() => setOpen(false)} title={t('Record vaccination')} wide>
        <form onSubmit={onSubmit}>
          <div className="form-grid">
            <TextField label={t('Vaccine')} name="vaccine" required minLength={2} maxLength={200} />
            <TextField label={t('Dose number')} name="doseNumber" type="number" min={1} max={20} />
            <TextField label={t('Lot number')} name="lotNumber" maxLength={60} />
            <TextField label={t('Site')} name="site" maxLength={60} hint={t('e.g. Left deltoid')} />
            <TextField
              label={t('Given at')}
              name="administeredAt"
              type="datetime-local"
              max={localNow()}
              hint={t('Leave empty for now')}
            />
          </div>
          <TextAreaField label={t('Notes')} name="notes" maxLength={2000} rows={2} />
          <EncounterSelect encounters={encounters} />
          <ErrorAlert error={create.error} />
          <div className="form-actions">
            <Button variant="secondary" onClick={() => setOpen(false)}>
              {t('Cancel')}
            </Button>
            <Button type="submit" loading={create.isPending}>
              {t('Save')}
            </Button>
          </div>
        </form>
      </Dialog>
    </Card>
  );
}

/** National-calendar status of the child plus the full list of recorded vaccinations. */
export function ImmunizationsTab({
  patientId,
  encounters,
}: {
  patientId: string;
  encounters: Encounter[];
}) {
  return (
    <div className="stack">
      <ScheduleCard patientId={patientId} />
      <RecordedVaccinations patientId={patientId} encounters={encounters} />
    </div>
  );
}

function ScheduleCard({ patientId }: { patientId: string }) {
  const status = useVaccinationStatus(patientId);
  const [recording, setRecording] = useState<DoseStatus | null>(null);
  const link = useLinkDose(patientId);
  const record = useRecordDose(patientId, () => setRecording(null));

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!recording) return;
    const v = formValues(e.currentTarget);
    record.mutate({
      scheduleItemId: recording.scheduleItemId,
      ...(v.lotNumber ? { lotNumber: v.lotNumber } : {}),
      ...(v.site ? { site: v.site } : {}),
      ...(v.administeredAt ? { administeredAt: new Date(v.administeredAt).toISOString() } : {}),
      ...(v.notes ? { notes: v.notes } : {}),
    });
  }

  return (
    <Card title={t('National vaccination calendar')}>
      <QueryView query={status}>
        {(s) =>
          s.ageDays >= 6570 && !s.doses.some((d) => d.given) ? (
            <p className="muted">{t('The childhood calendar does not apply to adults.')}</p>
          ) : (
            <>
              <VaccinationSummary status={s} />
              <VaccinationTimeline
                status={s}
                actions={(d) =>
                  d.state === 'DUE' || d.state === 'OVERDUE' || d.state === 'UPCOMING' ? (
                    <Button
                      size="sm"
                      variant={d.state === 'UPCOMING' ? 'secondary' : 'primary'}
                      onClick={() => setRecording(d)}
                    >
                      {t('Record this dose')}
                    </Button>
                  ) : null
                }
              />
              {s.other && s.other.length > 0 && (
                <>
                  <h3>{t('Not counted for a calendar dose')}</h3>
                  <p className="muted small">
                    {t('Link a vaccination recorded by hand to the calendar dose it counts for.')}
                  </p>
                  <ErrorAlert error={link.error} />
                  <ul className="list">
                    {s.other.map((o) => (
                      <li key={o.immunizationId} className="row-between">
                        <span>
                          <strong>{o.vaccine}</strong>
                          {o.doseNumber
                            ? ` · ${t('dose {dose}', { dose: o.doseNumber })}`
                            : ''}{' '}
                          <span className="muted">{formatDateTime(o.administeredAt)}</span>
                        </span>
                        <SelectField
                          label={t('Counts for')}
                          value=""
                          placeholder={t('Choose a calendar dose')}
                          onChange={(e) => {
                            const scheduleItemId = e.currentTarget.value;
                            if (scheduleItemId)
                              link.mutate({ immunizationId: o.immunizationId, scheduleItemId });
                          }}
                          options={s.doses
                            .filter((d) => !d.given)
                            .map((d) => ({ value: d.scheduleItemId, label: doseName(d) }))}
                        />
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </>
          )
        }
      </QueryView>
      <Dialog
        open={Boolean(recording)}
        onClose={() => setRecording(null)}
        title={
          recording ? t('Record {dose}', { dose: doseName(recording) }) : t('Record this dose')
        }
        wide
      >
        <form onSubmit={onSubmit}>
          <div className="form-grid">
            <TextField label={t('Lot number')} name="lotNumber" maxLength={60} />
            <TextField label={t('Site')} name="site" maxLength={60} hint={t('e.g. Left deltoid')} />
            <TextField
              label={t('Given at')}
              name="administeredAt"
              type="datetime-local"
              max={localNow()}
              hint={t('Leave empty for now')}
            />
          </div>
          <TextAreaField label={t('Notes')} name="notes" maxLength={2000} rows={2} />
          <ErrorAlert error={record.error} />
          <div className="form-actions">
            <Button variant="secondary" onClick={() => setRecording(null)}>
              {t('Cancel')}
            </Button>
            <Button type="submit" loading={record.isPending}>
              {t('Save')}
            </Button>
          </div>
        </form>
      </Dialog>
    </Card>
  );
}
