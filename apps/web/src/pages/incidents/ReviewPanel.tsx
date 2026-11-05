import { useState, type FormEvent } from 'react';
import { useUser } from '../../auth/AuthContext';
import {
  categoryLabel,
  factorLabel,
  harmLabel,
  harmShort,
  harmTone,
  statusLabel,
  statusTone,
  useAddAction,
  useIncident,
  useIncidentStaff,
  useUpdateAction,
  useUpdateIncident,
  type ContributingFactor,
  type IncidentDetail,
  type IncidentMeta,
  type OwnReport,
} from '../../api/incidents';
import {
  Alert,
  Badge,
  Button,
  compact,
  DefinitionList,
  ErrorAlert,
  formValues,
  QueryView,
  SelectField,
  TextAreaField,
  TextField,
} from '../../components/ui';
import { formatDate, formatDateTime } from '../../format';
import { t } from '../../i18n';
import { localInput } from './ReportForm';

/** Incident detail: the full review for reviewers, the report and its outcome for the reporter. */
export function IncidentView({ id, meta }: { id: string; meta: IncidentMeta }) {
  const query = useIncident(id);
  return (
    <QueryView query={query}>
      {(data) =>
        data.viewerIsReviewer ? (
          <Review incident={data} meta={meta} />
        ) : (
          <OwnReportView report={data} />
        )
      }
    </QueryView>
  );
}

function OwnReportView({ report }: { report: OwnReport }) {
  return (
    <div className="stack">
      <div className="row">
        <Badge tone={statusTone(report.status)}>{statusLabel(report.status)}</Badge>
        <Badge tone={harmTone(report.harm)}>{harmShort(report.harm)}</Badge>
      </div>
      <DefinitionList
        items={[
          [t('Reference|incident number'), report.reference],
          [t('Kind of incident'), categoryLabel(report.category)],
          [t('When it happened'), formatDateTime(report.occurredAt)],
          [t('Reported'), formatDateTime(report.reportedAt)],
          [t('What happened'), report.description],
          [t('What was done straight away'), report.immediateAction],
        ]}
      />
      {report.status === 'CLOSED' ? (
        <Alert tone="success" title={t('What was learned')}>
          {report.lessons ?? t('The review is closed.')}
        </Alert>
      ) : (
        <p className="muted">
          {t('The reviewers will tell you when the review is finished and what was learned.')}
        </p>
      )}
    </div>
  );
}

function Review({ incident, meta }: { incident: IncidentDetail; meta: IncidentMeta }) {
  const user = useUser();
  const update = useUpdateIncident();
  const staffQuery = useIncidentStaff(true);
  const staff = staffQuery.data?.staff ?? [];
  const reviewerIds = new Set(staffQuery.data?.reviewerIds ?? []);
  const closed = incident.status === 'CLOSED';
  const [factors, setFactors] = useState<ContributingFactor[]>(incident.contributingFactors ?? []);
  const [reviewedHarm, setReviewedHarm] = useState<string>(incident.reviewedHarm ?? incident.harm);
  const [carry, setCarry] = useState<string[]>([]);
  const [reopening, setReopening] = useState(false);
  const openActions = incident.actions.filter((a) => !a.completedAt);
  const needsDisclosure = (meta.disclosureHarm as string[]).includes(reviewedHarm);
  const formId = `incident-review-${incident.id}`;

  function reviewBody(form: HTMLFormElement) {
    const v = formValues(form);
    return {
      reviewedHarm,
      contributingFactors: factors,
      findings: v.findings,
      lessons: v.lessons,
      hazardRef: v.hazardRef ? v.hazardRef.toUpperCase() : null,
      patientInformedAt: v.patientInformedAt ? new Date(v.patientInformedAt).toISOString() : null,
      ...(v.reviewerId ? { reviewerId: v.reviewerId } : {}),
    };
  }

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const submitter = (e.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
    const status = submitter?.value || undefined;
    update.mutate({
      id: incident.id,
      body: {
        ...reviewBody(e.currentTarget),
        ...(status ? { status } : {}),
        ...(status === 'CLOSED' ? { carryOverActionIds: carry } : {}),
      },
    });
  }

  return (
    <div className="stack">
      <div className="row">
        <Badge tone={statusTone(incident.status)}>{statusLabel(incident.status)}</Badge>
        <Badge tone={harmTone(incident.harm)}>
          {t('Reported: {harm}', { harm: harmShort(incident.harm) })}
        </Badge>
        {incident.anonymous && <Badge tone="neutral">{t('Anonymous')}</Badge>}
      </div>
      <DefinitionList
        items={[
          [t('Reference|incident number'), incident.reference],
          [t('Kind of incident'), categoryLabel(incident.category)],
          [t('When it happened'), formatDateTime(incident.occurredAt)],
          [t('Reported'), formatDateTime(incident.reportedAt)],
          [
            t('Reported by'),
            incident.anonymous
              ? t('Anonymous ({role})', { role: t(roleName(incident.reporterRole)) })
              : `${incident.reporterName ?? '—'} (${t(roleName(incident.reporterRole))})`,
          ],
          [t('Ward or unit'), incident.unitName],
          [t('Where exactly'), incident.location],
          [
            t('Patient'),
            incident.patient
              ? `${incident.patient.firstName} ${incident.patient.lastName} (${incident.patient.nationalId})`
              : null,
          ],
          [t('What happened'), incident.description],
          [t('What was done straight away'), incident.immediateAction],
        ]}
      />

      <form
        id={formId}
        onSubmit={submit}
        className="stack"
        key={`${incident.id}-${incident.status}`}
      >
        <fieldset disabled={closed} className="stack" style={{ border: 0, padding: 0, margin: 0 }}>
          <div className="form-grid">
            <SelectField
              label={t('Reviewer')}
              name="reviewerId"
              defaultValue={incident.reviewerId ?? ''}
              placeholder={incident.status === 'NEW' ? t('Me') : t('Not assigned')}
              options={staff
                .filter((s) => reviewerIds.has(s.id))
                .map((s) => ({
                  value: s.id,
                  label: s.id === user.id ? `${s.fullName} (${t('me')})` : s.fullName,
                }))}
            />
            <SelectField
              label={t('Confirmed harm')}
              name="reviewedHarmSelect"
              value={reviewedHarm}
              onChange={(e) => setReviewedHarm(e.target.value)}
              options={meta.harmLevels.map((h) => ({ value: h, label: harmLabel(h) }))}
            />
            <TextField
              label={t('Clinical safety hazard')}
              name="hazardRef"
              defaultValue={incident.hazardRef ?? ''}
              maxLength={3}
              placeholder="H17"
              hint={
                incident.category === 'IT_SYSTEM'
                  ? t(
                      'This incident involves the system: link the hazard from the clinical safety case (e.g. H17) so the safety officer can update the hazard log.',
                    )
                  : t('Only for incidents involving the system, e.g. H17.')
              }
            />
            {needsDisclosure && (
              <TextField
                label={t('Patient or family told (open disclosure)')}
                name="patientInformedAt"
                type="datetime-local"
                required
                defaultValue={
                  incident.patientInformedAt ? localInput(new Date(incident.patientInformedAt)) : ''
                }
                hint={t('Required before closing for moderate or greater harm.')}
              />
            )}
          </div>
          <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend>
              <strong>{t('Contributing factors')}</strong>
            </legend>
            <div className="row">
              {meta.contributingFactors.map((f) => (
                <label key={f} className="checkbox">
                  <input
                    type="checkbox"
                    checked={factors.includes(f)}
                    onChange={(e) =>
                      setFactors((cur) =>
                        e.target.checked ? [...cur, f] : cur.filter((x) => x !== f),
                      )
                    }
                  />
                  {factorLabel(f)}
                </label>
              ))}
            </div>
          </fieldset>
          <TextAreaField
            label={t('Findings|incident review')}
            name="findings"
            defaultValue={incident.findings ?? ''}
            maxLength={10_000}
            rows={4}
            hint={t('What happened and why – the system, not the person.')}
          />
          <TextAreaField
            label={t('What was learned (shared with the reporter)')}
            name="lessons"
            defaultValue={incident.lessons ?? ''}
            maxLength={5000}
            rows={3}
            hint={
              incident.category === 'IT_SYSTEM'
                ? t(
                    'For system incidents the text is shared with the national clinical safety officer once the review is closed – leave out names and identifiers.',
                  )
                : undefined
            }
          />
        </fieldset>
      </form>

      <Actions incident={incident} staff={staff} carry={carry} setCarry={setCarry} />

      <ErrorAlert error={update.error} />
      {!closed && (
        <div className="form-actions">
          <Button type="submit" form={formId} variant="secondary" loading={update.isPending}>
            {t('Save')}
          </Button>
          {incident.status === 'NEW' && (
            <Button type="submit" form={formId} value="UNDER_REVIEW" loading={update.isPending}>
              {t('Start review')}
            </Button>
          )}
          {incident.status === 'UNDER_REVIEW' && (
            <Button type="submit" form={formId} value="ACTION_PLANNED" loading={update.isPending}>
              {t('Action plan agreed')}
            </Button>
          )}
          {incident.status === 'ACTION_PLANNED' && (
            <Button
              type="submit"
              form={formId}
              variant="secondary"
              value="UNDER_REVIEW"
              loading={update.isPending}
            >
              {t('Back to review')}
            </Button>
          )}
          {incident.status !== 'NEW' && (
            <Button type="submit" form={formId} value="CLOSED" loading={update.isPending}>
              {openActions.length > carry.length
                ? t('Close review (complete or carry over open actions first)')
                : t('Close review')}
            </Button>
          )}
        </div>
      )}

      {closed && (
        <Alert
          tone="success"
          title={t('Review closed {date}', { date: formatDate(incident.closedAt) })}
        >
          {incident.lessons}
        </Alert>
      )}
      {closed && meta.canManageReviewers && (
        <ReopenForm id={incident.id} open={reopening} setOpen={setReopening} />
      )}
    </div>
  );
}

function roleName(role: string) {
  return (
    {
      DOCTOR: 'Doctor',
      NURSE: 'Nurse',
      PHARMACIST: 'Pharmacist',
      RECEPTION: 'Reception',
      DIRECTOR: 'Director',
    }[role] ?? role
  );
}

function Actions({
  incident,
  staff,
  carry,
  setCarry,
}: {
  incident: IncidentDetail;
  staff: { id: string; fullName: string }[];
  carry: string[];
  setCarry: (ids: string[]) => void;
}) {
  const add = useAddAction();
  const change = useUpdateAction();
  const closed = incident.status === 'CLOSED';
  const [formKey, setFormKey] = useState(0);

  function onAdd(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    e.stopPropagation();
    const v = formValues(e.currentTarget);
    add.mutate(
      {
        id: incident.id,
        body: compact({ description: v.description, ownerId: v.ownerId, dueDate: v.dueDate }),
      },
      { onSuccess: () => setFormKey((k) => k + 1) },
    );
  }

  return (
    <section className="stack" aria-labelledby={`actions-${incident.id}`}>
      <h3 id={`actions-${incident.id}`}>{t('Actions')}</h3>
      {incident.actions.length === 0 ? (
        <p className="muted">{t('No actions yet.')}</p>
      ) : (
        <ul className="stack" style={{ listStyle: 'none', padding: 0, margin: 0, gap: '0.5rem' }}>
          {incident.actions.map((a) => (
            <li key={a.id} className="row-between">
              <span>
                {a.completedAt ? '✓ ' : ''}
                <strong>{a.description}</strong>{' '}
                <span className="muted">
                  {a.ownerName ?? t('No owner')} ·{' '}
                  {a.dueDate ? t('due {date}', { date: formatDate(a.dueDate) }) : t('no due date')}
                  {a.completedAt &&
                    ` · ${t('completed {date}', { date: formatDate(a.completedAt) })}`}
                </span>
              </span>
              <span className="row">
                {!a.completedAt && !closed && (
                  <label className="checkbox">
                    <input
                      type="checkbox"
                      checked={carry.includes(a.id)}
                      onChange={(e) =>
                        setCarry(
                          e.target.checked ? [...carry, a.id] : carry.filter((x) => x !== a.id),
                        )
                      }
                    />
                    {t('Carry over when closing')}
                  </label>
                )}
                <Button
                  size="sm"
                  variant="secondary"
                  loading={change.isPending}
                  onClick={() => change.mutate({ id: a.id, body: { completed: !a.completedAt } })}
                >
                  {a.completedAt ? t('Reopen action') : t('Mark done')}
                </Button>
              </span>
            </li>
          ))}
        </ul>
      )}
      <ErrorAlert error={change.error} />
      {!closed && (
        <form key={formKey} onSubmit={onAdd} className="form-grid" aria-label={t('Add an action')}>
          <TextField
            label={t('New action')}
            name="description"
            required
            minLength={3}
            maxLength={500}
          />
          <SelectField
            label={t('Owner')}
            name="ownerId"
            placeholder={t('No owner')}
            options={staff.map((s) => ({ value: s.id, label: s.fullName }))}
          />
          <TextField label={t('Due date')} name="dueDate" type="date" />
          <div className="form-actions" style={{ alignSelf: 'end' }}>
            <Button type="submit" variant="secondary" loading={add.isPending}>
              {t('Add action')}
            </Button>
          </div>
          <ErrorAlert error={add.error} />
        </form>
      )}
    </section>
  );
}

function ReopenForm({
  id,
  open,
  setOpen,
}: {
  id: string;
  open: boolean;
  setOpen: (v: boolean) => void;
}) {
  const update = useUpdateIncident();
  if (!open) {
    return (
      <div>
        <Button variant="secondary" onClick={() => setOpen(true)}>
          {t('Reopen review')}
        </Button>
      </div>
    );
  }
  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        const v = formValues(e.currentTarget);
        update.mutate(
          { id, body: { status: 'UNDER_REVIEW', reopenReason: v.reopenReason } },
          { onSuccess: () => setOpen(false) },
        );
      }}
    >
      <TextAreaField
        label={t('Why is the review reopened?')}
        name="reopenReason"
        required
        minLength={10}
        maxLength={500}
        rows={2}
      />
      <ErrorAlert error={update.error} />
      <div className="form-actions">
        <Button variant="secondary" onClick={() => setOpen(false)}>
          {t('Cancel')}
        </Button>
        <Button type="submit" loading={update.isPending}>
          {t('Reopen review')}
        </Button>
      </div>
    </form>
  );
}
