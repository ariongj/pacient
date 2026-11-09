import { useState, type FormEvent } from 'react';
import type { Allergy, Demographics } from '../../../api/types';
import {
  Alert,
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
  TextField,
} from '../../../components/ui';
import { formatDate, humanize } from '../../../format';
import { useChartMutation, useChartRole } from './shared';
import { useSection } from './useSection';
import { t } from '../../../i18n';
import { RecordHistory } from '../../history/RecordHistory';

const SEVERITIES = ['MILD', 'MODERATE', 'SEVERE', 'LIFE_THREATENING'] as const;
const VERIFICATION = ['UNCONFIRMED', 'CONFIRMED', 'REFUTED', 'ENTERED_IN_ERROR'] as const;

export const ALLERGY_ASSESSMENT_TEXT: Record<Demographics['allergyAssessment'], string> = {
  NOT_RECORDED: 'Allergies not recorded — ask the patient',
  NO_KNOWN_ALLERGIES: 'No known allergies (assessed)',
  ALLERGIES_RECORDED: 'Allergies recorded',
  UNKNOWN: 'Allergy status unknown (could not be assessed)',
};

export function AllergiesTab({
  patientId,
  assessment,
}: {
  patientId: string;
  assessment: Demographics['allergyAssessment'];
}) {
  const list = useSection<Allergy>(patientId, 'allergies');
  const [open, setOpen] = useState(false);
  const create = useChartMutation(
    patientId,
    (body: Record<string, unknown>) => ({ path: '/allergies', method: 'POST', body }),
    () => setOpen(false),
  );
  const verify = useChartMutation(
    patientId,
    ({ id, verificationStatus }: { id: string; verificationStatus: string }) => ({
      path: `/allergies/${id}`,
      method: 'PATCH',
      body: { verificationStatus },
    }),
  );
  const assess = useChartMutation(patientId, (status: 'NO_KNOWN_ALLERGIES' | 'UNKNOWN') => ({
    path: '/allergy-assessment',
    method: 'PUT',
    body: { status },
  }));

  const { isDoctor } = useChartRole();

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const v = compact(formValues(e.currentTarget));
    // Nurses record allergies as unconfirmed; a doctor confirms them.
    create.mutate(isDoctor ? v : { ...v, verificationStatus: 'UNCONFIRMED' });
  }

  return (
    <Card
      title={t('Allergies & intolerances')}
      actions={
        <>
          {isDoctor && (
            <>
              <Button
                size="sm"
                variant="secondary"
                loading={assess.isPending && assess.variables === 'NO_KNOWN_ALLERGIES'}
                onClick={() => assess.mutate('NO_KNOWN_ALLERGIES')}
              >
                {t('Record no known allergies')}
              </Button>
              <Button
                size="sm"
                variant="secondary"
                loading={assess.isPending && assess.variables === 'UNKNOWN'}
                onClick={() => assess.mutate('UNKNOWN')}
              >
                {t('Record unknown')}
              </Button>
            </>
          )}
          <Button size="sm" onClick={() => setOpen(true)}>
            {t('Add allergy')}
          </Button>
        </>
      }
    >
      <Alert tone={assessment === 'NOT_RECORDED' || assessment === 'UNKNOWN' ? 'warning' : 'info'}>
        {t('Assessment:')} <strong>{t(ALLERGY_ASSESSMENT_TEXT[assessment])}</strong>
      </Alert>
      <ErrorAlert error={assess.error ?? verify.error} />
      <QueryView query={list}>
        {(items) =>
          items.length === 0 ? (
            <EmptyState title={t('No allergy entries')} />
          ) : (
            <Table caption={t('Allergies')}>
              <thead>
                <tr>
                  <th>{t('Substance')}</th>
                  <th>{t('Reaction')}</th>
                  <th>{t('Severity')}</th>
                  <th>{t('Verification')}</th>
                  <th>{t('Source')}</th>
                  <th>{t('Recorded')}</th>
                  {isDoctor && <th>{t('Change verification')}</th>}
                </tr>
              </thead>
              <tbody>
                {items.map((a) => (
                  <tr key={a.id}>
                    <td>
                      <strong>{a.substance}</strong>
                      <div>
                        <RecordHistory
                          patientId={patientId}
                          table="allergies"
                          resourceId={a.id}
                          label={a.substance}
                        />
                      </div>
                    </td>
                    <td>{a.reaction ?? '—'}</td>
                    <td>
                      <StatusBadge value={a.severity} />
                    </td>
                    <td>
                      <StatusBadge value={a.verificationStatus} />
                    </td>
                    <td>{humanize(a.source)}</td>
                    <td>
                      {formatDate(a.recordedAt)}
                      <div className="muted">{a.recordedBy}</div>
                    </td>
                    {isDoctor && (
                      <td>
                        <label className="sr-only" htmlFor={`al-${a.id}`}>
                          {t('Verification of {name}', { name: a.substance })}
                        </label>
                        <select
                          id={`al-${a.id}`}
                          value={a.verificationStatus}
                          disabled={verify.isPending}
                          onChange={(e) =>
                            verify.mutate({ id: a.id, verificationStatus: e.target.value })
                          }
                        >
                          {VERIFICATION.map((v) => (
                            <option key={v} value={v}>
                              {humanize(v)}
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
      <Dialog open={open} onClose={() => setOpen(false)} title={t('Add allergy')}>
        <form onSubmit={onSubmit}>
          <TextField
            label={t('Substance')}
            name="substance"
            required
            minLength={2}
            maxLength={200}
          />
          <TextField label={t('Reaction')} name="reaction" maxLength={300} />
          <div className="form-grid">
            <SelectField
              label={t('Severity')}
              name="severity"
              required
              options={enumOptions(SEVERITIES)}
              placeholder={t('Select…')}
            />
            {isDoctor && (
              <SelectField
                label={t('Verification')}
                name="verificationStatus"
                options={enumOptions(['UNCONFIRMED', 'CONFIRMED'])}
              />
            )}
            <SelectField
              label={t('Source')}
              name="source"
              options={enumOptions(['CLINICIAN', 'PATIENT_REPORTED'])}
            />
          </div>
          {!isDoctor && (
            <p className="muted">{t('Recorded as unconfirmed until a doctor verifies it.')}</p>
          )}
          <ErrorAlert error={create.error} />
          <div className="form-actions">
            <Button variant="secondary" onClick={() => setOpen(false)}>
              {t('Cancel')}
            </Button>
            <Button type="submit" loading={create.isPending}>
              {t('Add allergy')}
            </Button>
          </div>
        </form>
      </Dialog>
    </Card>
  );
}
