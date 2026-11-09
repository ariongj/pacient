import { useState, type FormEvent } from 'react';
import type { Diagnosis, Encounter } from '../../../api/types';
import {
  Button,
  Card,
  compact,
  Dialog,
  EmptyState,
  enumOptions,
  ErrorAlert,
  formValues,
  QueryView,
  SelectField,
  StatusBadge,
  Table,
  TextAreaField,
  TextField,
  Alert,
} from '../../../components/ui';
import { formatDate, humanize } from '../../../format';
import { EncounterSelect, useChartMutation, useChartRole } from './shared';
import { useSection } from './useSection';
import { t } from '../../../i18n';
import { Link } from 'react-router-dom';
import { diseaseName, usePatientCases } from '../../../api/surveillance';
import { RecordHistory } from '../../history/RecordHistory';

const STATUSES = ['ACTIVE', 'CHRONIC', 'RESOLVED'] as const;

export function ProblemsTab({
  patientId,
  encounters,
}: {
  patientId: string;
  encounters: Encounter[];
}) {
  const list = useSection<Diagnosis>(patientId, 'diagnoses');
  const [open, setOpen] = useState(false);
  const create = useChartMutation(
    patientId,
    (body: Record<string, unknown>) => ({ path: '/diagnoses', method: 'POST', body }),
    () => setOpen(false),
  );
  const update = useChartMutation(patientId, ({ id, status }: { id: string; status: string }) => ({
    path: `/diagnoses/${id}`,
    method: 'PATCH',
    body: { status },
  }));

  const { isDoctor } = useChartRole();

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    create.mutate(compact(formValues(e.currentTarget)));
  }

  return (
    <Card
      title={t('Problems & diagnoses')}
      actions={
        isDoctor ? (
          <Button size="sm" onClick={() => setOpen(true)}>
            {t('Add diagnosis')}
          </Button>
        ) : undefined
      }
    >
      <ErrorAlert error={update.error} />
      {isDoctor && <CaseReportNotice patientId={patientId} />}
      <QueryView query={list}>
        {(items) =>
          items.length === 0 ? (
            <EmptyState title={t('No diagnoses recorded')} />
          ) : (
            <Table caption={t('Diagnoses')}>
              <thead>
                <tr>
                  <th>{t('ICD-10')}</th>
                  <th>{t('Description')}</th>
                  <th>{t('Status')}</th>
                  <th>{t('Diagnosed')}</th>
                  <th>{t('By')}</th>
                  {isDoctor && <th>{t('Change status')}</th>}
                </tr>
              </thead>
              <tbody>
                {items.map((d) => (
                  <tr key={d.id}>
                    <td>
                      <code>{d.icd10Code}</code>
                      <div>
                        <RecordHistory
                          patientId={patientId}
                          table="diagnoses"
                          resourceId={d.id}
                          label={d.description}
                        />
                      </div>
                    </td>
                    <td>
                      {d.description}
                      {d.notes && <div className="muted">{d.notes}</div>}
                    </td>
                    <td>
                      <StatusBadge value={d.status} />
                    </td>
                    <td>
                      {formatDate(d.diagnosedAt)}
                      {d.resolvedAt && (
                        <div className="muted">
                          {t('Resolved {date}', { date: formatDate(d.resolvedAt) })}
                        </div>
                      )}
                    </td>
                    <td>{d.doctorName}</td>
                    {isDoctor && (
                      <td>
                        <label className="sr-only" htmlFor={`dx-${d.id}`}>
                          {t('Status of {name}', { name: d.description })}
                        </label>
                        <select
                          id={`dx-${d.id}`}
                          value={d.status}
                          disabled={update.isPending}
                          onChange={(e) => update.mutate({ id: d.id, status: e.target.value })}
                        >
                          {STATUSES.map((s) => (
                            <option key={s} value={s}>
                              {humanize(s)}
                            </option>
                          ))}
                        </select>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </Table>
          )
        }
      </QueryView>
      <Dialog open={open} onClose={() => setOpen(false)} title={t('Add diagnosis')}>
        <form onSubmit={onSubmit}>
          <div className="form-grid">
            <TextField
              label={t('ICD-10 code')}
              name="icd10Code"
              required
              pattern="[A-Za-z][0-9]{2}(\.[0-9A-Za-z]{1,4})?"
              hint={t('e.g. E11.9')}
              maxLength={10}
            />
            <SelectField label={t('Status')} name="status" options={enumOptions(STATUSES)} />
          </div>
          <TextField
            label={t('Description')}
            name="description"
            required
            minLength={2}
            maxLength={300}
          />
          <EncounterSelect encounters={encounters} />
          <TextAreaField label={t('Notes')} name="notes" maxLength={5000} rows={3} />
          <ErrorAlert error={create.error} />
          <div className="form-actions">
            <Button variant="secondary" onClick={() => setOpen(false)}>
              {t('Cancel')}
            </Button>
            <Button type="submit" loading={create.isPending}>
              {t('Add diagnosis')}
            </Button>
          </div>
        </form>
      </Dialog>
    </Card>
  );
}

/** Reminds the doctor that a notifiable disease on this list needs a case report. */
function CaseReportNotice({ patientId }: { patientId: string }) {
  const cases = usePatientCases(patientId);
  const drafts = (cases.data ?? []).filter((c) => c.status === 'DRAFT');
  if (!drafts.length) return null;
  return (
    <Alert tone="warning" title={t('Notifiable disease: case report to complete')}>
      {drafts.map((c) => diseaseName(c.diseaseName)).join(', ')} –{' '}
      <Link to="/surveillance">{t('Complete the case report')}</Link>
    </Alert>
  );
}
