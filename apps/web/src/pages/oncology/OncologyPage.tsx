import { useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useHospitalDoctors } from '../../api/hospital';
import {
  LATERALITIES,
  LATERALITY_LABEL,
  MEETING_STATUS_LABEL,
  MORPHOLOGY,
  RECOMMENDATION_LABEL,
  RECOMMENDATIONS,
  REVIEW_STATUS_LABEL,
  REVIEW_TONE,
  STAGE_LABEL,
  TOPOGRAPHY,
  TUMOUR_GROUP_LABEL,
  TUMOUR_GROUPS,
  useCancelMeeting,
  useDcoCandidates,
  useHoldMeeting,
  useMarkInformed,
  useMeeting,
  useMeetings,
  useOncologyDefinitions,
  useRecordDecision,
  useRegisterDco,
  useRegistryStats,
  useScheduleMeeting,
  useUpdateMeeting,
  type AgendaCase,
  type DcoCandidate,
  type Laterality,
  type MeetingDetail,
  type Recommendation,
  type RegistryStats,
  type TumourGroup,
} from '../../api/oncology';
import { useUser } from '../../auth/AuthContext';
import { BarChart, RankedBars, StackedBars } from '../../components/charts';
import {
  Alert,
  Badge,
  Button,
  Card,
  Dialog,
  EmptyState,
  ErrorAlert,
  Grid,
  PageHeader,
  QueryView,
  SelectField,
  Stat,
  Table,
  TabPanel,
  Tabs,
  TextAreaField,
  TextField,
  formValues,
} from '../../components/ui';
import { formatDate, formatDateTime, formatNumber } from '../../format';
import { t } from '../../i18n';

/* ------------------------------------------------------------------ statistics ---------- */

function Statistics({ stats }: { stats: RegistryStats }) {
  const defs = useOncologyDefinitions();
  const n = stats.smallCellThreshold;
  const show = (v: number | null) => (v === null ? t('fewer than {n}', { n }) : formatNumber(v));
  const pct = (v: number | null) => (v === null ? '—' : `${formatNumber(v)} %`);
  const national = stats.scope === 'NATIONAL';
  const siteName = (code: string, label: string | null) =>
    label ? t(label) : (defs.data?.siteGroups.find((s) => s.code === code)?.label ?? code);
  return (
    <div className="stack">
      <Grid>
        <Stat
          label={t('New cancers {from}–{to}', { from: stats.fromYear, to: stats.toYear })}
          value={show(stats.total)}
        />
        <Stat
          label={t('Histologically verified')}
          value={pct(stats.quality.histologicallyVerifiedPct)}
          hint={t('Microscopically verified: {pct}', {
            pct: pct(stats.quality.microscopicallyVerifiedPct),
          })}
        />
        <Stat
          label={t('Death certificate only')}
          value={pct(stats.quality.deathCertificateOnlyPct)}
          tone={(stats.quality.deathCertificateOnlyPct ?? 0) > 10 ? 'warning' : undefined}
        />
        {stats.deathCertificateOnlyCandidates !== null && (
          <Stat
            label={t('Cancer deaths not yet registered')}
            value={formatNumber(stats.deathCertificateOnlyCandidates)}
            hint={t('Signed death certificates with a cancer as underlying cause')}
          />
        )}
      </Grid>
      <Alert tone="info">
        {t(
          'Counts below {n} are not shown, so that no person can be recognised. Only active registrations count (duplicates and withdrawn registrations are excluded).',
          { n },
        )}
      </Alert>
      <Card title={t('New cancers by year of diagnosis')}>
        <BarChart
          title={t('New cancers by year of diagnosis')}
          data={stats.byYear.map((y) => ({ label: String(y.year), value: y.count ?? 0 }))}
        />
      </Card>
      <Card title={t('Incidence by site')}>
        {stats.bySite.length === 0 ? (
          <EmptyState title={t('No cancers registered in the period')} />
        ) : (
          <>
            <RankedBars
              label={t('Incidence by site')}
              rows={stats.bySite.map((s) => ({
                key: s.code,
                label: siteName(s.code, s.label),
                sublabel: s.code,
                value: s.total,
                suppressed: s.total === null,
              }))}
            />
            <Table caption={t('Incidence by site and sex')}>
              <thead>
                <tr>
                  <th scope="col">{t('Site|cancer')}</th>
                  <th scope="col">{t('Men')}</th>
                  <th scope="col">{t('Women')}</th>
                  <th scope="col">{t('Total')}</th>
                </tr>
              </thead>
              <tbody>
                {stats.bySite.map((s) => (
                  <tr key={s.code}>
                    <th scope="row">
                      <code>{s.code}</code> {siteName(s.code, s.label)}
                    </th>
                    <td>{show(s.male)}</td>
                    <td>{show(s.female)}</td>
                    <td>{show(s.total)}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </>
        )}
      </Card>
      <Card title={t('Age at diagnosis and sex')}>
        <StackedBars
          title={t('Age at diagnosis and sex')}
          series={[
            { key: 'male', label: t('Men') },
            { key: 'female', label: t('Women') },
          ]}
          rows={stats.byAgeBand
            .filter((b) => b.male !== 0 || b.female !== 0)
            .map((b) => ({ label: b.band, values: { male: b.male ?? 0, female: b.female ?? 0 } }))}
        />
        {stats.byAgeBand.some((b) => b.male === null || b.female === null) && (
          <p className="muted">{t('Counts below {n} are shown as 0 in this chart.', { n })}</p>
        )}
      </Card>
      <Card title={t('Stage at diagnosis')}>
        <RankedBars
          label={t('Stage at diagnosis')}
          rows={stats.byStage.map((s) => ({
            key: s.stage,
            label: t(STAGE_LABEL[s.stage]),
            value: s.count,
            suppressed: s.count === null,
          }))}
        />
      </Card>
      <Card title={t('By municipality of residence')}>
        <Table caption={t('By municipality of residence')}>
          <thead>
            <tr>
              <th scope="col">{t('Municipality')}</th>
              <th scope="col">{t('New cancers')}</th>
              {national && <th scope="col">{t('Registered population')}</th>}
              {national && <th scope="col">{t('Crude rate per 100 000 per year')}</th>}
            </tr>
          </thead>
          <tbody>
            {stats.byMunicipality.map((m) => (
              <tr key={m.municipality}>
                <th scope="row">{m.municipality}</th>
                <td>{show(m.count)}</td>
                {national && <td>{m.population === null ? '—' : formatNumber(m.population)}</td>}
                {national && <td>{m.ratePer100k === null ? '—' : formatNumber(m.ratePer100k)}</td>}
              </tr>
            ))}
          </tbody>
        </Table>
        {national && (
          <p className="muted">
            {t(
              'Rates use the number of people registered in Pacient in each municipality, not the census population, and are not age-standardised. Treat them as indicative until census figures are loaded.',
            )}
          </p>
        )}
      </Card>
    </div>
  );
}

function StatsSection() {
  const thisYear = new Date().getFullYear();
  const [toYear, setToYear] = useState(thisYear);
  const [fromYear, setFromYear] = useState(thisYear - 4);
  const stats = useRegistryStats(fromYear, toYear);
  const years = Array.from({ length: 25 }, (_, i) => thisYear - i).map((y) => ({
    value: String(y),
    label: String(y),
  }));
  return (
    <div className="stack">
      <div className="form-grid no-print">
        <SelectField
          label={t('From year')}
          value={String(fromYear)}
          options={years}
          onChange={(e) => setFromYear(Number(e.target.value))}
        />
        <SelectField
          label={t('To year')}
          value={String(toYear)}
          options={years}
          onChange={(e) => setToYear(Number(e.target.value))}
        />
      </div>
      <QueryView query={stats}>{(s) => <Statistics stats={s} />}</QueryView>
    </div>
  );
}

/* ------------------------------------------------------------------ DCO ----------------- */

function DcoSection() {
  const list = useDcoCandidates();
  const register = useRegisterDco();
  const [chosen, setChosen] = useState<DcoCandidate | null>(null);
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!chosen) return;
    const v = formValues(e.currentTarget);
    register.mutate(
      {
        deathRecordId: chosen.deathRecordId,
        topography: v.topography || undefined,
        morphology: v.morphology || undefined,
        laterality: (v.laterality || undefined) as Laterality | undefined,
      },
      { onSuccess: () => setChosen(null) },
    );
  };
  return (
    <Card title={t('Cancer deaths without a registration')}>
      <p className="muted">
        {t(
          'Signed death certificates you issued, or of patients in your care, with a cancer as underlying cause and no registered cancer. Register the cancer from the chart if it was diagnosed in life; otherwise register it here as death certificate only.',
        )}
      </p>
      {register.isSuccess && (
        <Alert tone="success" title={t('Registered as death certificate only')} />
      )}
      <QueryView query={list}>
        {(data) =>
          data.items.length === 0 ? (
            <EmptyState title={t('No unregistered cancer deaths')} />
          ) : (
            <Table caption={t('Cancer deaths without a registration')}>
              <thead>
                <tr>
                  <th scope="col">{t('Person')}</th>
                  <th scope="col">{t('Date of death')}</th>
                  <th scope="col">{t('Underlying cause')}</th>
                  <th scope="col">{t('Death certificate number')}</th>
                  <th scope="col">{t('Actions')}</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((c) => (
                  <tr key={c.deathRecordId}>
                    <td>
                      <Link to={`/doctor/patients/${c.patientId}?tab=oncology`}>
                        {c.patient.lastName}, {c.patient.firstName}
                      </Link>
                      <div className="muted">
                        {formatDate(c.patient.dateOfBirth)} · <code>{c.patient.nationalId}</code>
                      </div>
                    </td>
                    <td>{formatDate(c.diedAt)}</td>
                    <td>
                      <code>{c.underlyingCauseIcd10}</code>
                    </td>
                    <td>{c.certificateNumber ?? '—'}</td>
                    <td>
                      <Button size="sm" variant="secondary" onClick={() => setChosen(c)}>
                        {t('Register as death certificate only')}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )
        }
      </QueryView>
      <Dialog
        open={Boolean(chosen)}
        onClose={() => {
          register.reset();
          setChosen(null);
        }}
        title={t('Register as death certificate only')}
      >
        {chosen && (
          <form className="stack" onSubmit={submit}>
            <p>
              {t(
                '{name}, died {date}. Underlying cause {code}. The date of death is used as the date of diagnosis.',
                {
                  name: `${chosen.patient.firstName} ${chosen.patient.lastName}`,
                  date: formatDate(chosen.diedAt),
                  code: chosen.underlyingCauseIcd10,
                },
              )}
            </p>
            <div className="form-grid">
              <TextField
                label={t('Topography (ICD-O-3)')}
                name="topography"
                pattern={TOPOGRAPHY.source}
                placeholder="C34.9"
                hint={t('Leave empty to derive it from the ICD-10 code')}
              />
              <TextField
                label={t('Morphology (ICD-O-3)')}
                name="morphology"
                pattern={MORPHOLOGY.source}
                defaultValue="8000/3"
              />
              <SelectField
                label={t('Laterality')}
                name="laterality"
                defaultValue="UNKNOWN"
                options={LATERALITIES.map((l) => ({ value: l, label: t(LATERALITY_LABEL[l]) }))}
              />
            </div>
            <ErrorAlert error={register.error} />
            <div className="form-actions">
              <Button variant="secondary" onClick={() => setChosen(null)}>
                {t('Cancel')}
              </Button>
              <Button type="submit" loading={register.isPending}>
                {t('Register')}
              </Button>
            </div>
          </form>
        )}
      </Dialog>
    </Card>
  );
}

/* ------------------------------------------------------------------ meetings ------------ */

const toLocalInput = (iso: string) => {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

function ScheduleDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const user = useUser();
  const doctors = useHospitalDoctors();
  const schedule = useScheduleMeeting();
  const close = () => {
    schedule.reset();
    onClose();
  };
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const v = formValues(e.currentTarget);
    schedule.mutate(
      {
        tumourGroup: v.tumourGroup as TumourGroup,
        scheduledFor: new Date(v.scheduledFor!).toISOString(),
        chairId: v.chairId || undefined,
      },
      { onSuccess: close },
    );
  };
  return (
    <Dialog open={open} onClose={close} title={t('Schedule a tumour board')}>
      <form className="stack" onSubmit={submit}>
        <SelectField
          label={t('Tumour group')}
          name="tumourGroup"
          required
          options={TUMOUR_GROUPS.map((g) => ({ value: g, label: t(TUMOUR_GROUP_LABEL[g]) }))}
        />
        <TextField label={t('Date and time')} name="scheduledFor" type="datetime-local" required />
        <SelectField
          label={t('Chair')}
          name="chairId"
          defaultValue={user.id}
          options={(
            doctors.data ?? [{ id: user.id, fullName: user.fullName, specialty: null }]
          ).map((d) => ({
            value: d.id,
            label: d.specialty ? `${d.fullName} – ${d.specialty}` : d.fullName,
          }))}
        />
        <ErrorAlert error={schedule.error} />
        <div className="form-actions">
          <Button variant="secondary" onClick={close}>
            {t('Cancel')}
          </Button>
          <Button type="submit" loading={schedule.isPending}>
            {t('Schedule|meeting')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function DecisionDialog({
  meeting,
  item,
  onClose,
}: {
  meeting: MeetingDetail;
  item: AgendaCase | null;
  onClose: () => void;
}) {
  const decide = useRecordDecision();
  const others = useMeetings('upcoming');
  const [mode, setMode] = useState<'DISCUSSED' | 'DEFERRED'>('DISCUSSED');
  const close = () => {
    decide.reset();
    setMode('DISCUSSED');
    onClose();
  };
  if (!item) return null;
  const targets = (others.data?.items ?? []).filter(
    (m) => m.id !== meeting.id && m.status === 'PLANNED',
  );
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const v = formValues(e.currentTarget);
    decide.mutate(
      mode === 'DISCUSSED'
        ? {
            reviewId: item.id,
            status: 'DISCUSSED',
            recommendation: v.recommendation as Recommendation,
            recommendationText: v.recommendationText!,
          }
        : { reviewId: item.id, status: 'DEFERRED', deferToMeetingId: v.deferToMeetingId! },
      { onSuccess: close },
    );
  };
  return (
    <Dialog
      open
      onClose={close}
      title={t('Tumour board decision for {name}', {
        name: `${item.patient.firstName} ${item.patient.lastName}`,
      })}
      wide
    >
      <form className="stack" onSubmit={submit}>
        {item.details && (
          <Alert tone="info" title={item.details.question}>
            {item.details.summary}
          </Alert>
        )}
        <Tabs<'DISCUSSED' | 'DEFERRED'>
          label={t('Outcome')}
          active={mode}
          withPanels={false}
          onChange={setMode}
          tabs={[
            { id: 'DISCUSSED', label: t('Recommendation') },
            { id: 'DEFERRED', label: t('Defer to another meeting') },
          ]}
        />
        {mode === 'DISCUSSED' ? (
          <>
            <SelectField
              label={t('Recommendation')}
              name="recommendation"
              required
              options={RECOMMENDATIONS.map((r) => ({
                value: r,
                label: t(RECOMMENDATION_LABEL[r]),
              }))}
            />
            <TextAreaField
              label={t('Recommendation of the tumour board')}
              name="recommendationText"
              required
              minLength={10}
              maxLength={5000}
              rows={5}
              hint={t('The referring doctor is notified and sees it in the patient’s chart.')}
            />
          </>
        ) : targets.length === 0 ? (
          <Alert tone="warning">{t('Schedule the next meeting first.')}</Alert>
        ) : (
          <SelectField
            label={t('Move to meeting')}
            name="deferToMeetingId"
            required
            options={targets.map((m) => ({
              value: m.id,
              label: `${formatDateTime(m.scheduledFor)} · ${t(TUMOUR_GROUP_LABEL[m.tumourGroup])}`,
            }))}
          />
        )}
        <ErrorAlert error={decide.error} />
        <div className="form-actions">
          <Button variant="secondary" onClick={close}>
            {t('Cancel')}
          </Button>
          <Button
            type="submit"
            loading={decide.isPending}
            disabled={mode === 'DEFERRED' && targets.length === 0}
          >
            {mode === 'DISCUSSED' ? t('Record the recommendation') : t('Defer')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

type ChairAction = 'hold' | 'cancel' | 'reschedule';

function ChairDialog({
  meeting,
  action,
  onClose,
}: {
  meeting: MeetingDetail;
  action: ChairAction | null;
  onClose: () => void;
}) {
  const hold = useHoldMeeting();
  const cancel = useCancelMeeting();
  const update = useUpdateMeeting();
  const doctors = useHospitalDoctors();
  const close = () => {
    hold.reset();
    cancel.reset();
    update.reset();
    onClose();
  };
  if (!action) return null;
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const v = formValues(e.currentTarget);
    if (action === 'hold') {
      const attendees = (v.attendees ?? '')
        .split('\n')
        .map((a) => a.trim())
        .filter(Boolean);
      hold.mutate({ id: meeting.id, attendees }, { onSuccess: close });
    } else if (action === 'cancel') {
      cancel.mutate({ id: meeting.id, reason: v.reason! }, { onSuccess: close });
    } else {
      update.mutate(
        {
          id: meeting.id,
          scheduledFor: v.scheduledFor ? new Date(v.scheduledFor).toISOString() : undefined,
          chairId: v.chairId && v.chairId !== meeting.chairId ? v.chairId : undefined,
        },
        { onSuccess: close },
      );
    }
  };
  const title =
    action === 'hold'
      ? t('Record the meeting')
      : action === 'cancel'
        ? t('Cancel the meeting')
        : t('Reschedule or hand over the chair');
  return (
    <Dialog open onClose={close} title={title}>
      <form className="stack" onSubmit={submit}>
        {action === 'hold' && (
          <TextAreaField
            label={t('Attendees')}
            name="attendees"
            required
            rows={6}
            defaultValue={meeting.attendees.join('\n')}
            hint={t('One per line: name and specialty. At least two.')}
          />
        )}
        {action === 'cancel' && (
          <TextAreaField
            label={t('Reason')}
            name="reason"
            required
            minLength={10}
            maxLength={500}
            rows={3}
            hint={t('Patients still on the agenda must first be deferred to another meeting.')}
          />
        )}
        {action === 'reschedule' && (
          <>
            <TextField
              label={t('Date and time')}
              name="scheduledFor"
              type="datetime-local"
              defaultValue={toLocalInput(meeting.scheduledFor)}
            />
            <SelectField
              label={t('Chair')}
              name="chairId"
              defaultValue={meeting.chairId}
              options={(doctors.data ?? []).map((d) => ({ value: d.id, label: d.fullName }))}
            />
          </>
        )}
        <ErrorAlert error={hold.error ?? cancel.error ?? update.error} />
        <div className="form-actions">
          <Button variant="secondary" onClick={close}>
            {t('Close')}
          </Button>
          <Button
            type="submit"
            variant={action === 'cancel' ? 'danger' : 'primary'}
            loading={hold.isPending || cancel.isPending || update.isPending}
          >
            {action === 'hold'
              ? t('Mark as held')
              : action === 'cancel'
                ? t('Cancel the meeting')
                : t('Save')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

const MEETING_TONE = { PLANNED: 'info', HELD: 'success', CANCELLED: 'neutral' } as const;

function MeetingView({ id, onBack }: { id: string; onBack: () => void }) {
  const user = useUser();
  const meeting = useMeeting(id);
  const informed = useMarkInformed();
  const [deciding, setDeciding] = useState<AgendaCase | null>(null);
  const [chairAction, setChairAction] = useState<ChairAction | null>(null);
  return (
    <QueryView query={meeting}>
      {(m) => (
        <div className="stack">
          <div className="row no-print">
            <Button variant="ghost" size="sm" onClick={onBack}>
              {t('← All meetings')}
            </Button>
            <Button variant="secondary" size="sm" onClick={() => window.print()}>
              {t('Print the agenda')}
            </Button>
            {m.isChair && m.status === 'PLANNED' && (
              <>
                <Button size="sm" onClick={() => setChairAction('hold')}>
                  {t('Record the meeting')}
                </Button>
                <Button size="sm" variant="secondary" onClick={() => setChairAction('reschedule')}>
                  {t('Reschedule')}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setChairAction('cancel')}>
                  {t('Cancel the meeting')}
                </Button>
              </>
            )}
          </div>
          <Card
            title={t('Tumour board – {group}', { group: t(TUMOUR_GROUP_LABEL[m.tumourGroup]) })}
          >
            <dl className="dl">
              <div>
                <dt>{t('Date and time')}</dt>
                <dd>{formatDateTime(m.scheduledFor)}</dd>
              </div>
              <div>
                <dt>{t('Chair')}</dt>
                <dd>{m.chair ?? '—'}</dd>
              </div>
              <div>
                <dt>{t('Status')}</dt>
                <dd>
                  <Badge tone={MEETING_TONE[m.status]}>{t(MEETING_STATUS_LABEL[m.status])}</Badge>
                </dd>
              </div>
              {m.attendees.length > 0 && (
                <div>
                  <dt>{t('Attendees')}</dt>
                  <dd>{m.attendees.join(', ')}</dd>
                </div>
              )}
            </dl>
            <p className="muted no-print">
              {t(
                'Everyone of the facility sees who is on the agenda. The question, summary and recommendation are shown only to the chair, the referring doctor and the patient’s care team.',
              )}
            </p>
          </Card>
          <Card title={t('Agenda')}>
            {m.cases.length === 0 ? (
              <EmptyState title={t('No patients on the agenda yet')}>
                {t('Doctors add their patients from the patient’s chart (Cancer registry tab).')}
              </EmptyState>
            ) : (
              <ol className="stack" style={{ listStyle: 'none', padding: 0 }}>
                {m.cases.map((c, i) => (
                  <li key={c.id} className="card">
                    <div className="row">
                      <strong>
                        {i + 1}. {c.patient.lastName}, {c.patient.firstName}
                      </strong>
                      <span className="muted">
                        {formatDate(c.patient.dateOfBirth)} · <code>{c.patient.nationalId}</code>
                      </span>
                      <Badge tone={REVIEW_TONE[c.status]}>{t(REVIEW_STATUS_LABEL[c.status])}</Badge>
                    </div>
                    <div className="muted">{t('Referred by {name}', { name: c.referredBy })}</div>
                    {c.details ? (
                      <div className="stack">
                        {c.details.cancerCase && (
                          <div>
                            <code>{c.details.cancerCase.topography}</code>{' '}
                            <code>{c.details.cancerCase.morphology}</code>{' '}
                            {c.details.cancerCase.stage &&
                              t(STAGE_LABEL[c.details.cancerCase.stage])}
                          </div>
                        )}
                        <div>
                          <strong>{t('Question')}:</strong> {c.details.question}
                        </div>
                        {c.details.summary && <p>{c.details.summary}</p>}
                        {c.details.recommendation && (
                          <Alert
                            tone="success"
                            title={t(RECOMMENDATION_LABEL[c.details.recommendation])}
                          >
                            {c.details.recommendationText}
                          </Alert>
                        )}
                      </div>
                    ) : (
                      <p className="muted">{t('Clinical details are visible to the care team.')}</p>
                    )}
                    <div className="row no-print">
                      {m.isChair && c.status === 'PENDING' && m.status !== 'CANCELLED' && (
                        <Button size="sm" onClick={() => setDeciding(c)}>
                          {t('Record the decision')}
                        </Button>
                      )}
                      {c.status === 'DISCUSSED' &&
                        !c.patientInformedAt &&
                        c.details &&
                        user.role === 'DOCTOR' && (
                          <Button
                            size="sm"
                            variant="secondary"
                            loading={informed.isPending && informed.variables === c.id}
                            onClick={() =>
                              informed.mutate(c.id, { onSuccess: () => void meeting.refetch() })
                            }
                          >
                            {t('Mark as informed')}
                          </Button>
                        )}
                      {c.patientInformedAt && (
                        <span className="muted">
                          {t('Patient informed {date}', {
                            date: formatDateTime(c.patientInformedAt),
                          })}
                        </span>
                      )}
                      {c.details && user.role === 'DOCTOR' && (
                        <Link to={`/doctor/patients/${c.patientId}?tab=oncology`}>
                          {t('Open the chart')}
                        </Link>
                      )}
                    </div>
                  </li>
                ))}
              </ol>
            )}
            <ErrorAlert error={informed.error} />
          </Card>
          <DecisionDialog meeting={m} item={deciding} onClose={() => setDeciding(null)} />
          <ChairDialog meeting={m} action={chairAction} onClose={() => setChairAction(null)} />
        </div>
      )}
    </QueryView>
  );
}

function MeetingList({ onOpen }: { onOpen: (id: string) => void }) {
  const user = useUser();
  const [when, setWhen] = useState<'upcoming' | 'past'>('upcoming');
  const [scheduling, setScheduling] = useState(false);
  const list = useMeetings(when);
  return (
    <Card
      title={t('Tumour board meetings')}
      actions={
        user.role === 'DOCTOR' ? (
          <Button size="sm" onClick={() => setScheduling(true)}>
            {t('Schedule a tumour board')}
          </Button>
        ) : null
      }
    >
      <Tabs<'upcoming' | 'past'>
        label={t('Meetings')}
        active={when}
        withPanels={false}
        onChange={setWhen}
        tabs={[
          { id: 'upcoming', label: t('Upcoming') },
          { id: 'past', label: t('Past') },
        ]}
      />
      <QueryView query={list}>
        {(data) =>
          data.items.length === 0 ? (
            <EmptyState title={t('No meetings')} />
          ) : (
            <Table caption={t('Tumour board meetings')}>
              <thead>
                <tr>
                  <th scope="col">{t('Date and time')}</th>
                  <th scope="col">{t('Tumour group')}</th>
                  <th scope="col">{t('Chair')}</th>
                  <th scope="col">{t('Patients')}</th>
                  <th scope="col">{t('Status')}</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((m) => (
                  <tr key={m.id}>
                    <td>
                      <Button variant="ghost" size="sm" onClick={() => onOpen(m.id)}>
                        {formatDateTime(m.scheduledFor)}
                      </Button>
                    </td>
                    <td>{t(TUMOUR_GROUP_LABEL[m.tumourGroup])}</td>
                    <td>
                      {m.chair}
                      {m.isChair && (
                        <div>
                          <Badge tone="info">{t('You chair')}</Badge>
                        </div>
                      )}
                    </td>
                    <td>
                      {formatNumber(m.caseCount ?? 0)}
                      {(m.pendingCount ?? 0) > 0 && m.status === 'PLANNED' && (
                        <div className="muted">
                          {t('{count} to discuss', { count: m.pendingCount ?? 0 })}
                        </div>
                      )}
                    </td>
                    <td>
                      <Badge tone={MEETING_TONE[m.status]}>
                        {t(MEETING_STATUS_LABEL[m.status])}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )
        }
      </QueryView>
      <ScheduleDialog open={scheduling} onClose={() => setScheduling(false)} />
    </Card>
  );
}

function TumourBoards() {
  const [params, setParams] = useSearchParams();
  const meetingId = params.get('meeting');
  const open = (id: string | null) => {
    const next = new URLSearchParams(params);
    if (id) next.set('meeting', id);
    else next.delete('meeting');
    setParams(next);
  };
  return meetingId ? (
    <MeetingView id={meetingId} onBack={() => open(null)} />
  ) : (
    <MeetingList onOpen={open} />
  );
}

/* ------------------------------------------------------------------ page ---------------- */

export function OncologyPage() {
  const user = useUser();
  const [tab, setTab] = useState<'boards' | 'dco'>('boards');
  if (user.role === 'MINISTRY' || user.role === 'DIRECTOR') {
    return (
      <>
        <PageHeader
          title={t('Cancer registry')}
          subtitle={
            user.role === 'MINISTRY'
              ? t('National cancer incidence from registered cases (no names).')
              : t('New cancers registered at your facility (no names).')
          }
        />
        <StatsSection />
      </>
    );
  }
  if (user.role !== 'DOCTOR') {
    return (
      <>
        <PageHeader title={t('Cancer registry')} subtitle={t('Tumour boards of your facility.')} />
        <TumourBoards />
      </>
    );
  }
  return (
    <>
      <PageHeader
        title={t('Cancer registry')}
        subtitle={t(
          'Tumour boards of your facility and cancer deaths still to register. Cancers are registered from the patient’s chart.',
        )}
      />
      <Tabs
        label={t('Cancer registry')}
        active={tab}
        onChange={setTab}
        tabs={[
          { id: 'boards', label: t('Tumour boards') },
          { id: 'dco', label: t('Death certificate only') },
        ]}
      />
      <TabPanel id={tab}>{tab === 'boards' ? <TumourBoards /> : <DcoSection />}</TabPanel>
    </>
  );
}
