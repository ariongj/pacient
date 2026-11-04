import { useState, type FormEvent } from 'react';
import {
  caseStatusLabel,
  classificationLabel,
  diseaseName,
  urgencyLabel,
  useCaseAction,
  useCases,
  useDashboard,
  useDiseases,
  useMyCases,
  useSaveDisease,
  useUpdateCase,
  type CaseClassification,
  type CaseReport,
  type Dashboard,
  type NotifiableDisease,
} from '../../api/surveillance';
import { useUser } from '../../auth/AuthContext';
import { LineChart } from '../../components/charts';
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
  Pagination,
  QueryView,
  SelectField,
  Stat,
  Table,
  Tabs,
  TabPanel,
  TextAreaField,
  TextField,
  type Tone,
} from '../../components/ui';
import { formatDate, formatDateTime, formatNumber, humanize } from '../../format';
import { t } from '../../i18n';

const CLASSIFICATIONS: CaseClassification[] = ['SUSPECTED', 'PROBABLE', 'CONFIRMED'];
const classificationTone: Record<CaseClassification, Tone> = {
  SUSPECTED: 'warning',
  PROBABLE: 'info',
  CONFIRMED: 'danger',
  DISCARDED: 'neutral',
};

function CaseBadges({ c }: { c: CaseReport }) {
  return (
    <span className="row" style={{ flexWrap: 'wrap', gap: '0.35rem' }}>
      {c.disease.urgency === 'IMMEDIATE' && (
        <Badge tone="danger">{t('Report within 24 hours')}</Badge>
      )}
      <Badge tone={classificationTone[c.classification]}>
        {classificationLabel(c.classification)}
      </Badge>
      <Badge tone={c.status === 'DRAFT' ? 'warning' : 'success'}>{caseStatusLabel(c.status)}</Badge>
    </span>
  );
}

/* --------------------------------------------------------------------------------- doctor ---- */

function CaseForm({ c, onClose }: { c: CaseReport; onClose: () => void }) {
  const update = useUpdateCase();
  const action = useCaseAction();
  const [discarding, setDiscarding] = useState(false);
  const readOnly = c.status !== 'DRAFT';
  const d = c.details ?? {};

  function values(form: HTMLFormElement) {
    const f = new FormData(form);
    const str = (k: string) => String(f.get(k) ?? '').trim();
    const contacts = str('contactsCount');
    return {
      onsetDate: str('onsetDate') || undefined,
      classification: str('classification') || undefined,
      details: {
        symptoms: str('symptoms')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        hospitalised: f.get('hospitalised') === 'on',
        outbreakSuspected: f.get('outbreakSuspected') === 'on',
        travelHistory: str('travelHistory') || undefined,
        contactsCount: contacts ? Number(contacts) : undefined,
        vaccinationStatus: str('vaccinationStatus') || undefined,
        labConfirmation: str('labConfirmation') || undefined,
        notes: str('notes') || undefined,
      },
    };
  }

  async function save(e: FormEvent<HTMLFormElement>, submit: boolean) {
    e.preventDefault();
    await update.mutateAsync({ id: c.id, body: values(e.currentTarget) });
    if (submit) await action.mutateAsync({ id: c.id, action: 'submit' });
    onClose();
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={t('Case report: {disease}', { disease: diseaseName(c.disease.name) })}
      wide
    >
      <p className="muted">
        {c.patient.name} · {t('{age} y', { age: c.patient.age })} · {humanize(c.patient.sex)}
        {c.patient.municipality ? ` · ${c.patient.municipality}` : ''} · ICD-10 {c.icd10Code}
      </p>
      <p className="muted">{urgencyLabel(c.disease.urgency)}</p>
      {discarding ? (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            const reason = String(new FormData(e.currentTarget).get('reason') ?? '');
            await action.mutateAsync({ id: c.id, action: 'discard', body: { reason } });
            onClose();
          }}
        >
          <TextAreaField
            label={t('Why is this not a notifiable case?')}
            name="reason"
            required
            minLength={5}
            maxLength={500}
            rows={3}
          />
          <ErrorAlert error={action.error} />
          <div className="form-actions">
            <Button variant="secondary" onClick={() => setDiscarding(false)}>
              {t('Back')}
            </Button>
            <Button type="submit" variant="danger" loading={action.isPending}>
              {t('Discard case report')}
            </Button>
          </div>
        </form>
      ) : (
        <form
          onSubmit={(e) => {
            const submitter = (e.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
            void save(e, submitter?.value === 'submit');
          }}
        >
          <fieldset disabled={readOnly} style={{ border: 0, padding: 0, margin: 0 }}>
            <div className="form-grid">
              <TextField
                label={t('Date of onset')}
                name="onsetDate"
                type="date"
                required
                defaultValue={c.onsetDate ?? ''}
                max={new Date().toISOString().slice(0, 10)}
              />
              <SelectField
                label={t('Classification')}
                name="classification"
                defaultValue={c.classification === 'DISCARDED' ? 'SUSPECTED' : c.classification}
                options={CLASSIFICATIONS.map((v) => ({ value: v, label: classificationLabel(v) }))}
              />
              <TextField
                label={t('Symptoms')}
                name="symptoms"
                hint={t('Separate with commas')}
                defaultValue={(d.symptoms ?? []).join(', ')}
                maxLength={1000}
              />
              <SelectField
                label={t('Vaccination status')}
                name="vaccinationStatus"
                defaultValue={d.vaccinationStatus ?? 'UNKNOWN'}
                options={[
                  { value: 'VACCINATED', label: t('Vaccinated') },
                  { value: 'PARTIALLY', label: t('Partially vaccinated') },
                  { value: 'NOT_VACCINATED', label: t('Not vaccinated') },
                  { value: 'UNKNOWN', label: t('Unknown') },
                ]}
              />
              <TextField
                label={t('Close contacts')}
                name="contactsCount"
                type="number"
                min={0}
                max={10000}
                defaultValue={d.contactsCount ?? ''}
              />
              <TextField
                label={t('Laboratory confirmation')}
                name="labConfirmation"
                defaultValue={d.labConfirmation ?? ''}
                maxLength={300}
              />
            </div>
            <TextField
              label={t('Travel history (last 4 weeks)')}
              name="travelHistory"
              defaultValue={d.travelHistory ?? ''}
              maxLength={500}
            />
            <label className="checkbox">
              <input type="checkbox" name="hospitalised" defaultChecked={Boolean(d.hospitalised)} />
              <span>{t('Hospitalised')}</span>
            </label>
            <label className="checkbox">
              <input
                type="checkbox"
                name="outbreakSuspected"
                defaultChecked={Boolean(d.outbreakSuspected)}
              />
              <span>{t('Outbreak suspected (linked cases)')}</span>
            </label>
            <TextAreaField
              label={t('Notes')}
              name="notes"
              rows={3}
              maxLength={2000}
              defaultValue={d.notes ?? ''}
            />
          </fieldset>
          <ErrorAlert error={update.error ?? action.error} />
          <div className="form-actions">
            <Button variant="secondary" onClick={onClose}>
              {t('Close')}
            </Button>
            {!readOnly && (
              <>
                <Button variant="ghost" onClick={() => setDiscarding(true)}>
                  {t('Not a case')}
                </Button>
                <Button type="submit" variant="secondary" value="save" loading={update.isPending}>
                  {t('Save draft')}
                </Button>
                <Button type="submit" value="submit" loading={action.isPending}>
                  {t('Submit to public health')}
                </Button>
              </>
            )}
          </div>
        </form>
      )}
    </Dialog>
  );
}

function DoctorView() {
  const mine = useMyCases();
  const [open, setOpen] = useState<CaseReport | null>(null);
  return (
    <Card title={t('My case reports')}>
      <p className="muted">
        {t(
          'Diagnoses of notifiable infectious diseases create a draft case report automatically. Complete and submit it – immediately notifiable diseases within 24 hours.',
        )}
      </p>
      <QueryView query={mine}>
        {({ items }) =>
          items.length === 0 ? (
            <EmptyState title={t('No case reports to complete')} />
          ) : (
            <ul className="list">
              {items.map((c) => (
                <li key={c.id} className="row-between" style={{ flexWrap: 'wrap', gap: '0.5rem' }}>
                  <span>
                    <strong>{diseaseName(c.disease.name)}</strong> · {c.patient.name}
                    <span className="muted" style={{ display: 'block' }}>
                      ICD-10 {c.icd10Code} ·{' '}
                      {t('Created {date}', { date: formatDateTime(c.createdAt) })}
                    </span>
                    <CaseBadges c={c} />
                  </span>
                  <Button
                    size="sm"
                    variant={c.status === 'DRAFT' ? 'primary' : 'secondary'}
                    onClick={() => setOpen(c)}
                  >
                    {c.status === 'DRAFT' ? t('Complete report') : t('View')}
                  </Button>
                </li>
              ))}
            </ul>
          )
        }
      </QueryView>
      {open && <CaseForm c={open} onClose={() => setOpen(null)} />}
    </Card>
  );
}

/* ------------------------------------------------------------------------------ dashboard ---- */

function DashboardView({ d }: { d: Dashboard }) {
  const weekLabel = (w: string) => w.slice(5);
  return (
    <div className="stack">
      {d.alerts.length > 0 && (
        <Alert tone="danger" title={t('Alerts')}>
          <ul style={{ margin: 0 }}>
            {d.alerts.map((a) => (
              <li key={`${a.diseaseCode}-${a.kind}`}>
                {a.kind === 'IMMEDIATE'
                  ? t('{disease}: immediately notifiable case ({week})', {
                      disease: diseaseName(a.diseaseName),
                      week: a.week,
                    })
                  : t(
                      '{disease}: {count} cases this week, more than twice the usual ({baseline})',
                      {
                        disease: diseaseName(a.diseaseName),
                        count: a.count,
                        baseline: a.baseline ?? 0,
                      },
                    )}
              </li>
            ))}
          </ul>
        </Alert>
      )}
      <Grid min={170}>
        <Stat
          label={t('Cases in the period')}
          value={formatNumber(d.diseases.reduce((s, x) => s + x.total, 0))}
        />
        <Stat label={t('Diseases reported')} value={formatNumber(d.diseases.length)} />
        <Stat
          label={t('Drafts not yet submitted')}
          value={formatNumber(d.timeliness.drafts)}
          tone={d.timeliness.overdueDrafts ? 'warning' : undefined}
          hint={t('{count} overdue', { count: d.timeliness.overdueDrafts })}
        />
        <Stat
          label={t('Submitted on time')}
          value={d.timeliness.onTimePct === null ? '—' : `${d.timeliness.onTimePct}%`}
          hint={t('24 hours for immediate, 7 days for weekly diseases')}
        />
      </Grid>
      {d.diseases.length === 0 ? (
        <EmptyState title={t('No cases in this period')} />
      ) : (
        <>
          <Grid min={300}>
            {d.diseases.slice(0, 6).map((x) => (
              <Card key={x.code} title={diseaseName(x.name)}>
                <LineChart
                  title={t('Cases per week: {disease}', { disease: diseaseName(x.name) })}
                  data={d.weeks.map((w, i) => ({ label: weekLabel(w), value: x.counts[i] ?? 0 }))}
                  height={120}
                />
              </Card>
            ))}
          </Grid>
          <Card title={t('Cases per week')}>
            <Table caption={t('Cases per week')}>
              <thead>
                <tr>
                  <th>{t('Disease')}</th>
                  {d.weeks.map((w) => (
                    <th key={w}>{weekLabel(w)}</th>
                  ))}
                  <th>{t('Total')}</th>
                </tr>
              </thead>
              <tbody>
                {d.diseases.map((x) => (
                  <tr key={x.code}>
                    <td>
                      {diseaseName(x.name)}
                      {x.urgency === 'IMMEDIATE' && (
                        <span className="muted"> · {t('immediate')}</span>
                      )}
                    </td>
                    {x.counts.map((n, i) => (
                      <td key={i}>{n || ''}</td>
                    ))}
                    <td>
                      <strong>{x.total}</strong>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Card>
          <Card title={t('By municipality')}>
            <p className="muted">
              {t('Counts below {n} are hidden ("<{n}") to protect privacy.', {
                n: d.suppressionThreshold,
              })}
            </p>
            <Table caption={t('By municipality')}>
              <thead>
                <tr>
                  <th>{t('Municipality')}</th>
                  {d.diseases.map((x) => (
                    <th key={x.code}>{diseaseName(x.name)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {d.municipalities.map((m) => (
                  <tr key={m.municipality}>
                    <td>{m.municipality}</td>
                    {d.diseases.map((x) => {
                      const v = m.counts[x.code];
                      return (
                        <td key={x.code}>
                          {v === undefined ? '' : v === null ? `<${d.suppressionThreshold}` : v}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </Table>
          </Card>
        </>
      )}
    </div>
  );
}

/* --------------------------------------------------------------------------- case list ---- */

function ReviewDialog({ c, onClose }: { c: CaseReport; onClose: () => void }) {
  const action = useCaseAction();
  return (
    <Dialog open onClose={onClose} title={t('Review case report')} wide>
      <p>
        <strong>{diseaseName(c.disease.name)}</strong> · {c.patient.name} ({c.patient.nationalId}) ·{' '}
        {t('{age} y', { age: c.patient.age })} · {c.patient.municipality ?? '—'}
      </p>
      <p className="muted">
        {c.facilityName} · {c.reporterName ?? '—'} ·{' '}
        {t('Onset {date}', { date: formatDate(c.onsetDate) })}
      </p>
      {c.details?.symptoms?.length ? (
        <p>
          {t('Symptoms')}: {c.details.symptoms.join(', ')}
        </p>
      ) : null}
      {c.details?.labConfirmation && (
        <p>
          {t('Laboratory confirmation')}: {c.details.labConfirmation}
        </p>
      )}
      {c.details?.notes && <p className="muted">{c.details.notes}</p>}
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          await action.mutateAsync({
            id: c.id,
            action: 'review',
            body: {
              classification: f.get('classification'),
              note: String(f.get('note') ?? '') || undefined,
            },
          });
          onClose();
        }}
      >
        <SelectField
          label={t('Final classification')}
          name="classification"
          defaultValue={c.classification}
          options={[...CLASSIFICATIONS, 'DISCARDED' as const].map((v) => ({
            value: v,
            label: classificationLabel(v),
          }))}
        />
        <TextAreaField label={t('Review note')} name="note" rows={3} maxLength={1000} />
        <ErrorAlert error={action.error} />
        <div className="form-actions">
          <Button variant="secondary" onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button type="submit" loading={action.isPending}>
            {t('Mark as reviewed')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function CaseList({ identifiable }: { identifiable: boolean }) {
  const [page, setPage] = useState(1);
  const [disease, setDisease] = useState('');
  const [status, setStatus] = useState('');
  const diseases = useDiseases();
  const cases = useCases({ page, disease: disease || undefined, status: status || undefined });
  const [reviewing, setReviewing] = useState<CaseReport | null>(null);
  return (
    <Card title={t('Case reports')}>
      {!identifiable && (
        <p className="muted">
          {t('Patient identities are only visible to the care team and public health.')}
        </p>
      )}
      <div className="form-grid">
        <SelectField
          label={t('Disease')}
          value={disease}
          onChange={(e) => {
            setDisease(e.target.value);
            setPage(1);
          }}
          placeholder={t('All diseases')}
          options={(diseases.data ?? []).map((d) => ({
            value: d.code,
            label: diseaseName(d.name),
          }))}
        />
        <SelectField
          label={t('Status')}
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            setPage(1);
          }}
          placeholder={t('All')}
          options={(['DRAFT', 'SUBMITTED', 'REVIEWED'] as const).map((s) => ({
            value: s,
            label: caseStatusLabel(s),
          }))}
        />
      </div>
      <QueryView query={cases}>
        {(data) =>
          data.items.length === 0 ? (
            <EmptyState title={t('No case reports')} />
          ) : (
            <>
              <Table caption={t('Case reports')}>
                <thead>
                  <tr>
                    <th>{t('Disease')}</th>
                    <th>{t('Patient')}</th>
                    <th>{t('Facility')}</th>
                    <th>{t('Onset')}</th>
                    <th>{t('Status')}</th>
                    {identifiable && (
                      <th>
                        <span className="sr-only">{t('Actions')}</span>
                      </th>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((c) => (
                    <tr key={c.id}>
                      <td>
                        <strong>{diseaseName(c.disease.name)}</strong>
                        <div className="muted">ICD-10 {c.icd10Code}</div>
                      </td>
                      <td>
                        {identifiable && c.patient.name ? (
                          <>
                            {c.patient.name}
                            <div className="muted">{c.patient.nationalId}</div>
                          </>
                        ) : null}
                        <div className="muted">
                          {t('{age} y', { age: c.patient.age })} · {humanize(c.patient.sex)} ·{' '}
                          {c.patient.municipality ?? '—'}
                        </div>
                      </td>
                      <td>{c.facilityName}</td>
                      <td>{formatDate(c.onsetDate)}</td>
                      <td>
                        <CaseBadges c={c} />
                      </td>
                      {identifiable && (
                        <td>
                          {c.status === 'SUBMITTED' && (
                            <Button size="sm" onClick={() => setReviewing(c)}>
                              {t('Review')}
                            </Button>
                          )}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </Table>
              <Pagination page={data.page} totalPages={data.totalPages} onChange={setPage} />
            </>
          )
        }
      </QueryView>
      {reviewing && <ReviewDialog c={reviewing} onClose={() => setReviewing(null)} />}
    </Card>
  );
}

/* ---------------------------------------------------------------------------- diseases ---- */

function DiseaseEditor() {
  const diseases = useDiseases();
  const save = useSaveDisease();
  const [editing, setEditing] = useState<NotifiableDisease | 'new' | null>(null);
  const current = editing && editing !== 'new' ? editing : null;
  return (
    <Card
      title={t('Notifiable diseases')}
      actions={
        <Button size="sm" onClick={() => setEditing('new')}>
          {t('Add disease')}
        </Button>
      }
    >
      <Alert tone="warning">
        {t(
          'This list is illustrative and must be verified against the current official list of the National Institute of Public Health of Kosovo (IKShPK).',
        )}
      </Alert>
      <QueryView query={diseases}>
        {(items) => (
          <Table caption={t('Notifiable diseases')}>
            <thead>
              <tr>
                <th>{t('Disease')}</th>
                <th>ICD-10</th>
                <th>{t('Reporting')}</th>
                <th>{t('Status')}</th>
                <th>
                  <span className="sr-only">{t('Actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((d) => (
                <tr key={d.id}>
                  <td>{diseaseName(d.name)}</td>
                  <td className="mono">{d.icd10Prefixes.join(', ')}</td>
                  <td>
                    <Badge tone={d.urgency === 'IMMEDIATE' ? 'danger' : 'info'}>
                      {urgencyLabel(d.urgency)}
                    </Badge>
                  </td>
                  <td>{d.isActive ? t('Active') : t('Inactive')}</td>
                  <td>
                    <Button size="sm" variant="secondary" onClick={() => setEditing(d)}>
                      {t('Edit')}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </QueryView>
      {editing && (
        <Dialog
          open
          onClose={() => setEditing(null)}
          title={current ? t('Edit disease') : t('Add disease')}
        >
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              const prefixes = String(f.get('icd10Prefixes') ?? '')
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean);
              const body: Record<string, unknown> = {
                name: String(f.get('name') ?? '').trim(),
                icd10Prefixes: prefixes,
                urgency: f.get('urgency'),
              };
              if (current) body.isActive = f.get('isActive') === 'on';
              else body.code = String(f.get('code') ?? '').trim();
              await save.mutateAsync({ id: current?.id, body });
              setEditing(null);
            }}
          >
            {!current && (
              <TextField label={t('Code')} name="code" required pattern="[A-Za-z0-9_]{2,30}" />
            )}
            <TextField
              label={t('Name (English)')}
              name="name"
              required
              defaultValue={current?.name ?? ''}
            />
            <TextField
              label={t('ICD-10 codes or categories')}
              name="icd10Prefixes"
              required
              hint={t('Separate with commas, e.g. A23, A05.1')}
              defaultValue={current?.icd10Prefixes.join(', ') ?? ''}
            />
            <SelectField
              label={t('Reporting')}
              name="urgency"
              defaultValue={current?.urgency ?? 'WEEKLY'}
              options={[
                { value: 'IMMEDIATE', label: urgencyLabel('IMMEDIATE') },
                { value: 'WEEKLY', label: urgencyLabel('WEEKLY') },
              ]}
            />
            {current && (
              <label className="checkbox">
                <input type="checkbox" name="isActive" defaultChecked={current.isActive} />
                <span>{t('Active')}</span>
              </label>
            )}
            <ErrorAlert error={save.error} />
            <div className="form-actions">
              <Button variant="secondary" onClick={() => setEditing(null)}>
                {t('Cancel')}
              </Button>
              <Button type="submit" loading={save.isPending}>
                {t('Save')}
              </Button>
            </div>
          </form>
        </Dialog>
      )}
    </Card>
  );
}

/* --------------------------------------------------------------------------------- page ---- */

type MinistryTab = 'dashboard' | 'cases' | 'diseases';

export function SurveillancePage() {
  const user = useUser();
  const [weeks, setWeeks] = useState(12);
  const [tab, setTab] = useState<MinistryTab>('dashboard');
  const isMinistry = user.role === 'MINISTRY';
  const isDirector = user.role === 'DIRECTOR';
  const dashboard = useDashboard(weeks);

  if (user.role === 'DOCTOR') {
    return (
      <>
        <PageHeader
          title={t('Notifiable diseases')}
          subtitle={t('Case reports for public health')}
        />
        <DoctorView />
      </>
    );
  }

  const weeksSelect = (
    <SelectField
      label={t('Period')}
      value={String(weeks)}
      onChange={(e) => setWeeks(Number(e.target.value))}
      options={[8, 12, 26, 52].map((n) => ({
        value: String(n),
        label: t('Last {n} weeks', { n }),
      }))}
    />
  );

  return (
    <>
      <PageHeader
        title={isMinistry ? t('Disease surveillance') : t('Notifiable diseases')}
        subtitle={
          isMinistry
            ? t('Notifiable infectious diseases reported across Kosovo')
            : t('Case reports from your facility (without patient names)')
        }
        actions={weeksSelect}
      />
      {isDirector ? (
        <div className="stack">
          <QueryView query={dashboard}>{(d) => <DashboardView d={d} />}</QueryView>
          <CaseList identifiable={false} />
        </div>
      ) : (
        <>
          <Tabs<MinistryTab>
            label={t('Surveillance sections')}
            active={tab}
            onChange={setTab}
            tabs={[
              { id: 'dashboard', label: t('Dashboard') },
              { id: 'cases', label: t('Case reports') },
              { id: 'diseases', label: t('Notifiable diseases') },
            ]}
          />
          <TabPanel id={tab}>
            {tab === 'dashboard' && (
              <QueryView query={dashboard}>{(d) => <DashboardView d={d} />}</QueryView>
            )}
            {tab === 'cases' && <CaseList identifiable />}
            {tab === 'diseases' && <DiseaseEditor />}
          </TabPanel>
        </>
      )}
    </>
  );
}
