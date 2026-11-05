import { useState, type FormEvent } from 'react';
import {
  categoryLabel,
  harmLabel,
  useReportIncident,
  type IncidentMeta,
} from '../../api/incidents';
import {
  Alert,
  Button,
  Card,
  compact,
  ErrorAlert,
  formValues,
  SelectField,
  TextAreaField,
  TextField,
} from '../../components/ui';
import { t } from '../../i18n';

/** "2026-11-02T09:00" for a datetime-local input, in local time. */
export function localInput(d: Date) {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Short, mobile-friendly report form for every member of staff. */
export function ReportForm({ meta, onReported }: { meta: IncidentMeta; onReported: () => void }) {
  const report = useReportIncident();
  const [anonymous, setAnonymous] = useState(false);
  const [done, setDone] = useState<{ reference: string; anonymous: boolean } | null>(null);
  const [formKey, setFormKey] = useState(0);

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const v = formValues(e.currentTarget);
    report.mutate(
      compact({
        occurredAt: v.occurredAt ? new Date(v.occurredAt).toISOString() : undefined,
        category: v.category,
        harm: v.harm,
        unitId: v.unitId,
        location: v.location,
        description: v.description,
        immediateAction: v.immediateAction,
        patientNationalId: v.patientNationalId,
        anonymous,
      }),
      {
        onSuccess: (r) => {
          setDone({ reference: r.reference, anonymous: r.anonymous });
          setAnonymous(false);
          setFormKey((k) => k + 1);
          onReported();
        },
      },
    );
  }

  return (
    <div className="stack">
      <Alert tone="info" title={t('Reporting is about learning, not blame')}>
        {t(
          'Report anything that harmed or could have harmed a patient – including near misses that were caught in time. Reports are read only by the facility’s incident reviewers, who look for what in the system can be improved.',
        )}
      </Alert>
      {done && (
        <Alert
          tone="success"
          title={t('Thank you – report {reference} was sent', { reference: done.reference })}
        >
          {done.anonymous
            ? t(
                'You reported anonymously: the report is not linked to you, so it will not appear under “My reports” and you will not be told the outcome.',
              )
            : t('You will be told when the reviewers have looked at it and what was learned.')}
        </Alert>
      )}
      <Card title={t('Report an incident or near miss')}>
        <form key={formKey} onSubmit={onSubmit} className="stack">
          <div className="form-grid">
            <TextField
              label={t('When did it happen?')}
              name="occurredAt"
              type="datetime-local"
              required
              defaultValue={localInput(new Date())}
              max={localInput(new Date(Date.now() + 5 * 60_000))}
            />
            <SelectField
              label={t('What kind of incident?')}
              name="category"
              required
              placeholder={t('Choose…')}
              options={meta.categories.map((c) => ({ value: c, label: categoryLabel(c) }))}
            />
            <SelectField
              label={t('Harm to the patient (your estimate)')}
              name="harm"
              required
              placeholder={t('Choose…')}
              hint={t('The reviewers confirm the level of harm.')}
              options={meta.harmLevels.map((h) => ({ value: h, label: harmLabel(h) }))}
            />
            <SelectField
              label={t('Ward or unit')}
              name="unitId"
              placeholder={t('Not on a ward / not sure')}
              options={meta.units.map((u) => ({ value: u.id, label: u.name }))}
            />
            <TextField
              label={t('Where exactly?')}
              name="location"
              maxLength={200}
              hint={t('e.g. room 4, pharmacy counter, car park')}
            />
          </div>
          <TextAreaField
            label={t('What happened?')}
            name="description"
            required
            minLength={20}
            maxLength={5000}
            rows={5}
            hint={t(
              'Facts only: what happened, in what order. Do not write patient names here – use the field below.',
            )}
          />
          <TextAreaField
            label={t('What was done straight away?')}
            name="immediateAction"
            maxLength={2000}
            rows={2}
          />
          {meta.canAttachPatient ? (
            <TextField
              label={t('Patient involved (national ID number, optional)')}
              name="patientNationalId"
              maxLength={20}
              inputMode="numeric"
              hint={t(
                'Only for a patient in your care. Only the reviewers see who the patient is; the patient’s record is not changed.',
              )}
            />
          ) : (
            <p className="muted">
              {t(
                'If a patient was involved, describe them without names (e.g. “woman in her 70s, bed 3”). The reviewers can identify them.',
              )}
            </p>
          )}
          <label className="checkbox">
            <input
              type="checkbox"
              checked={anonymous}
              onChange={(e) => setAnonymous(e.target.checked)}
            />
            {t('Report anonymously')}
          </label>
          {anonymous && (
            <Alert tone="warning">
              {t(
                'Your name is not stored with the report or in the audit trail. Your role is kept, and the details you write may still point to you. You will not receive feedback on an anonymous report.',
              )}
            </Alert>
          )}
          <ErrorAlert error={report.error} />
          <div className="form-actions">
            <Button type="submit" loading={report.isPending}>
              {t('Send report')}
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
