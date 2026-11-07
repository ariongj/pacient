import { useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  categoryLabel,
  channelLabel,
  COMPLAINT_CATEGORIES,
  complaintStatusLabel,
  complaintStatusTone,
  FEEDBACK_ITEMS,
  feedbackItemLabel,
  outcomeLabel,
  RESPONSE_OUTCOMES,
  settingLabel,
  useComplaint,
  useComplaintAction,
  useComplaintDashboard,
  useComplaints,
  useComplaintsMeta,
  useFeedbackDashboard,
  useRecordComplaint,
  type ComplaintDetail,
  type ComplaintOutcome,
  type ComplaintsMeta,
  type ComplaintStatus,
  type CountCell,
  type FeedbackGroup,
  type FeedbackSetting,
} from '../../api/complaints';
import { LineChart, RankedBars } from '../../components/charts';
import {
  Alert,
  Badge,
  Button,
  Card,
  DefinitionList,
  Dialog,
  EmptyState,
  ErrorAlert,
  formValues,
  Grid,
  PageHeader,
  Pagination,
  QueryView,
  SelectField,
  Stat,
  TabPanel,
  Table,
  Tabs,
  TextAreaField,
  TextField,
} from '../../components/ui';
import { formatDate, formatDateTime, formatMonth, formatNumber } from '../../format';
import { t } from '../../i18n';

type TabId = 'list' | 'record' | 'dashboard' | 'feedback';

/**
 * Complaints for the facility (director and the staff they assign) and the Ministry (escalated
 * complaints, national figures), with anonymous feedback results. Complaints are never shown in
 * the clinical chart.
 */
export function ComplaintsPage() {
  const meta = useComplaintsMeta();
  return (
    <>
      <PageHeader
        title={t('Complaints and feedback')}
        subtitle={t(
          'Acknowledge complaints within 5 working days and answer in writing within 30 days. Feedback from patients is anonymous.',
        )}
      />
      <QueryView query={meta}>{(m) => <Body meta={m} />}</QueryView>
    </>
  );
}

function Body({ meta }: { meta: ComplaintsMeta }) {
  const [params, setParams] = useSearchParams();
  const [tab, setTab] = useState<TabId>('list');
  const [openId, setOpenId] = useState<string | null>(params.get('complaint'));
  const canDashboard = meta.canManage || meta.isMinistry;
  const tabs: { id: TabId; label: string }[] = [
    {
      id: 'list',
      label: meta.isMinistry
        ? t('Escalated complaints')
        : meta.canManage
          ? t('Complaints')
          : t('Assigned to me'),
    },
    ...(meta.canRecord ? [{ id: 'record' as const, label: t('Record a complaint') }] : []),
    ...(canDashboard
      ? [
          {
            id: 'dashboard' as const,
            label: meta.isMinistry ? t('National figures') : t('Dashboard'),
          },
          { id: 'feedback' as const, label: t('Patient feedback') },
        ]
      : []),
  ];
  return (
    <>
      <Tabs label={t('Complaints and feedback')} tabs={tabs} active={tab} onChange={setTab} />
      <TabPanel id={tab}>
        {tab === 'list' && <ComplaintList meta={meta} onOpen={setOpenId} />}
        {tab === 'record' && (
          <RecordComplaint
            onDone={(id) => {
              setTab('list');
              setOpenId(id);
            }}
          />
        )}
        {tab === 'dashboard' && <Dashboard meta={meta} onOpen={setOpenId} />}
        {tab === 'feedback' && <FeedbackView meta={meta} />}
      </TabPanel>
      <Dialog
        open={openId !== null}
        onClose={() => {
          setOpenId(null);
          if (params.get('complaint')) setParams({}, { replace: true });
        }}
        title={t('Complaint')}
        wide
      >
        {openId && <ComplaintView id={openId} meta={meta} />}
      </Dialog>
    </>
  );
}

function StatusBadge({ status }: { status: ComplaintStatus }) {
  return <Badge tone={complaintStatusTone(status)}>{complaintStatusLabel(status)}</Badge>;
}

function DueCell({
  c,
}: {
  c: {
    status: ComplaintStatus;
    acknowledgedAt: string | null;
    acknowledgeDueAt: string;
    respondedAt: string | null;
    responseDueAt: string;
    acknowledgeOverdue: boolean;
    responseOverdue: boolean;
  };
}) {
  if (c.status === 'CLOSED' || c.status === 'ESCALATED' || c.respondedAt) return <>—</>;
  return (
    <div>
      {!c.acknowledgedAt && (
        <div className={c.acknowledgeOverdue ? 'error-text' : undefined}>
          {t('Acknowledge by {date}', { date: formatDate(c.acknowledgeDueAt) })}
          {c.acknowledgeOverdue && ` · ${t('Overdue')}`}
        </div>
      )}
      <div className={c.responseOverdue ? 'error-text' : 'muted'}>
        {t('Answer by {date}', { date: formatDate(c.responseDueAt) })}
        {c.responseOverdue && ` · ${t('Overdue')}`}
      </div>
    </div>
  );
}

/* --------------------------------------------------------------------------------- list -- */

function ComplaintList({ meta, onOpen }: { meta: ComplaintsMeta; onOpen: (id: string) => void }) {
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const [overdue, setOverdue] = useState(false);
  const list = useComplaints({
    page,
    pageSize: 20,
    status: status || undefined,
    overdue: overdue ? 'true' : undefined,
  });
  return (
    <Card title={meta.isMinistry ? t('Escalated complaints') : t('Complaints')}>
      <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <SelectField
          label={t('Status')}
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            setPage(1);
          }}
          placeholder={t('All')}
          options={(
            [
              'RECEIVED',
              'ACKNOWLEDGED',
              'INVESTIGATING',
              'RESPONDED',
              'ESCALATED',
              'CLOSED',
            ] as const
          ).map((s) => ({ value: s, label: complaintStatusLabel(s) }))}
        />
        {!meta.isMinistry && (
          <label style={{ display: 'inline-flex', gap: '0.4rem', alignItems: 'center' }}>
            <input
              type="checkbox"
              checked={overdue}
              onChange={(e) => {
                setOverdue(e.target.checked);
                setPage(1);
              }}
            />
            {t('Only overdue')}
          </label>
        )}
      </div>
      <QueryView query={list}>
        {(d) =>
          d.items.length === 0 ? (
            <EmptyState title={t('No complaints')} />
          ) : (
            <>
              <Table caption={t('Complaints')}>
                <thead>
                  <tr>
                    <th>{t('Reference|complaint')}</th>
                    {meta.isMinistry && <th>{t('Facility')}</th>}
                    <th>{t('Subject')}</th>
                    <th>{t('Received|complaint')}</th>
                    <th>{t('Status')}</th>
                    <th>{t('Deadline')}</th>
                    {!meta.isMinistry && <th>{t('Assigned to')}</th>}
                    <th>
                      <span className="sr-only">{t('Actions')}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {d.items.map((c) => (
                    <tr key={c.id}>
                      <td>
                        <code>{c.reference}</code>
                      </td>
                      {meta.isMinistry && <td>{c.facilityName}</td>}
                      <td>
                        {categoryLabel(c.category)}
                        <div className="muted">{channelLabel(c.channel)}</div>
                      </td>
                      <td>{formatDate(c.createdAt)}</td>
                      <td>
                        <StatusBadge status={c.status} />
                        {meta.isMinistry && c.status === 'ESCALATED' && !c.ministryDecided && (
                          <div className="muted">{t('Decision pending')}</div>
                        )}
                      </td>
                      <td>
                        <DueCell c={c} />
                      </td>
                      {!meta.isMinistry && <td>{c.assignedTo ?? '—'}</td>}
                      <td>
                        <Button size="sm" variant="secondary" onClick={() => onOpen(c.id)}>
                          {t('Open|action')}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
              <Pagination page={d.page} totalPages={d.totalPages} onChange={setPage} />
            </>
          )
        }
      </QueryView>
    </Card>
  );
}

/* ------------------------------------------------------------------------------- detail -- */

function ComplaintView({ id, meta }: { id: string; meta: ComplaintsMeta }) {
  const detail = useComplaint(id);
  return <QueryView query={detail}>{(c) => <ComplaintBody c={c} meta={meta} />}</QueryView>;
}

function ComplaintBody({ c, meta }: { c: ComplaintDetail; meta: ComplaintsMeta }) {
  const action = useComplaintAction(c.id);
  const handler = c.access === 'director' || c.access === 'assignee';
  const open = ['RECEIVED', 'ACKNOWLEDGED', 'INVESTIGATING'].includes(c.status);
  const [responding, setResponding] = useState(false);
  return (
    <div className="stack">
      <h3 style={{ margin: 0 }}>
        <code>{c.reference}</code> · {categoryLabel(c.category)} <StatusBadge status={c.status} />
      </h3>
      <DefinitionList
        items={[
          [t('Facility'), c.facilityName],
          ...(c.patientName
            ? ([
                [t('Patient'), `${c.patientName} (${c.patientNationalId ?? ''})`],
                [t('Phone'), c.patientPhone],
              ] as [string, string | null][])
            : []),
          ...(c.submittedBy ? ([[t('Submitted by'), c.submittedBy]] as [string, string][]) : []),
          [t('Received|complaint'), `${formatDateTime(c.createdAt)} · ${channelLabel(c.channel)}`],
          [t('Acknowledged|complaint'), c.acknowledgedAt ? formatDateTime(c.acknowledgedAt) : null],
          [t('Deadline'), <DueCell key="due" c={c} />],
          [t('Assigned to'), c.assignedTo],
        ]}
      />
      {!c.hadRecentCare && c.access !== 'ministry' && (
        <Alert tone="warning" title={t('No recent care found')}>
          {t(
            'The patient had no visit, stay or emergency attendance here in the two years before the complaint. Contact them for details if needed.',
          )}
        </Alert>
      )}
      <section>
        <h4>{t('Complaint')}</h4>
        <p style={{ whiteSpace: 'pre-wrap' }}>{c.description}</p>
        {c.desiredOutcome && (
          <p style={{ whiteSpace: 'pre-wrap' }}>
            <strong>{t('Desired outcome')}:</strong> {c.desiredOutcome}
          </p>
        )}
      </section>
      {c.response && (
        <section>
          <h4>{t('Answer from the facility')}</h4>
          <p>
            {c.outcome && outcomeLabel(c.outcome)}
            {c.respondedAt && ` · ${formatDateTime(c.respondedAt)}`}
            {c.respondedBy && ` · ${c.respondedBy}`}
          </p>
          <p style={{ whiteSpace: 'pre-wrap' }}>{c.response}</p>
        </section>
      )}
      {c.outcome === 'WITHDRAWN' && <p className="muted">{t('Withdrawn by the complainant')}</p>}
      {c.escalatedAt && (
        <section>
          <h4>{t('Escalated to the Ministry of Health')}</h4>
          <p className="muted">{formatDateTime(c.escalatedAt)}</p>
          <p style={{ whiteSpace: 'pre-wrap' }}>{c.escalationReason}</p>
          {c.ministryDecision && (
            <>
              <h4>{t('Decision of the Ministry')}</h4>
              <p style={{ whiteSpace: 'pre-wrap' }}>{c.ministryDecision}</p>
            </>
          )}
        </section>
      )}
      <ErrorAlert error={action.error} />

      {c.access === 'director' && open && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const v = formValues(e.currentTarget);
            action.mutate({ action: 'assign', body: { userId: v.userId || null } });
          }}
          style={{ display: 'flex', gap: '0.75rem', alignItems: 'flex-end', flexWrap: 'wrap' }}
        >
          <SelectField
            label={t('Assign to')}
            name="userId"
            defaultValue={c.assignedToId ?? ''}
            placeholder={t('Nobody (director)')}
            options={meta.staff.map((s) => ({ value: s.id, label: s.fullName }))}
          />
          <Button type="submit" variant="secondary" loading={action.isPending}>
            {t('Assign')}
          </Button>
        </form>
      )}

      {handler && open && !responding && (
        <div className="form-actions" style={{ justifyContent: 'flex-start' }}>
          {c.status === 'RECEIVED' && (
            <Button
              variant="secondary"
              loading={action.isPending}
              onClick={() => action.mutate({ action: 'acknowledge' })}
            >
              {t('Acknowledge receipt')}
            </Button>
          )}
          {c.status !== 'INVESTIGATING' && (
            <Button
              variant="secondary"
              loading={action.isPending}
              onClick={() => action.mutate({ action: 'investigate' })}
            >
              {t('Start investigation')}
            </Button>
          )}
          <Button onClick={() => setResponding(true)}>{t('Write the answer')}</Button>
        </div>
      )}
      {handler && open && responding && (
        <form
          onSubmit={(e: FormEvent<HTMLFormElement>) => {
            e.preventDefault();
            const v = formValues(e.currentTarget);
            action.mutate(
              { action: 'respond', body: { response: v.response, outcome: v.outcome } },
              { onSuccess: () => setResponding(false) },
            );
          }}
        >
          <TextAreaField
            label={t('Written answer to the complainant')}
            name="response"
            required
            minLength={30}
            maxLength={10000}
            rows={8}
            hint={t('Explain what you found and what will change. Write in plain language.')}
          />
          <SelectField
            label={t('Outcome')}
            name="outcome"
            required
            placeholder={t('Choose…')}
            options={RESPONSE_OUTCOMES.map((o) => ({ value: o, label: outcomeLabel(o) }))}
          />
          <div className="form-actions">
            <Button variant="secondary" onClick={() => setResponding(false)}>
              {t('Cancel')}
            </Button>
            <Button type="submit" loading={action.isPending}>
              {t('Send the answer')}
            </Button>
          </div>
        </form>
      )}
      {c.access === 'director' && c.status === 'RESPONDED' && (
        <div className="form-actions" style={{ justifyContent: 'flex-start' }}>
          <Button
            variant="secondary"
            loading={action.isPending}
            onClick={() => action.mutate({ action: 'close' })}
          >
            {t('Close complaint')}
          </Button>
        </div>
      )}
      {c.access === 'ministry' && c.status === 'ESCALATED' && !c.ministryDecision && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            action.mutate({
              action: 'decision',
              body: { decision: formValues(e.currentTarget).decision },
            });
          }}
        >
          <TextAreaField
            label={t('Decision of the Ministry')}
            name="decision"
            required
            minLength={30}
            maxLength={10000}
            rows={6}
            hint={t('Sent to the complainant and the facility.')}
          />
          <div className="form-actions">
            <Button type="submit" loading={action.isPending}>
              {t('Record the decision')}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------------------- record -- */

function RecordComplaint({ onDone }: { onDone: (id: string) => void }) {
  const record = useRecordComplaint();
  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const v = formValues(e.currentTarget);
    record.mutate(
      {
        patientNationalId: v.patientNationalId,
        channel: v.channel,
        category: v.category,
        description: v.description,
        desiredOutcome: v.desiredOutcome || null,
        ...(v.receivedAt ? { receivedAt: new Date(v.receivedAt).toISOString() } : {}),
      },
      { onSuccess: (c) => onDone(c.id) },
    );
  }
  return (
    <Card title={t('Record a complaint')}>
      <p className="muted">
        {t(
          'For complaints received in person, by phone or by letter. Online complaints arrive by themselves.',
        )}
      </p>
      <form onSubmit={onSubmit}>
        <div className="form-grid">
          <TextField
            label={t('Patient’s national ID number')}
            name="patientNationalId"
            required
            minLength={5}
            maxLength={20}
          />
          <SelectField
            label={t('Received')}
            name="channel"
            required
            options={(['IN_PERSON', 'PHONE', 'LETTER'] as const).map((ch) => ({
              value: ch,
              label: channelLabel(ch),
            }))}
          />
          <SelectField
            label={t('Subject')}
            name="category"
            required
            placeholder={t('Choose…')}
            options={COMPLAINT_CATEGORIES.map((c) => ({ value: c, label: categoryLabel(c) }))}
          />
          <TextField
            label={t('Date received')}
            name="receivedAt"
            type="datetime-local"
            hint={t('Leave empty for now')}
          />
        </div>
        <TextAreaField
          label={t('Complaint')}
          name="description"
          required
          minLength={20}
          maxLength={5000}
          rows={6}
        />
        <TextAreaField
          label={t('Desired outcome')}
          name="desiredOutcome"
          maxLength={2000}
          rows={3}
        />
        <ErrorAlert error={record.error} />
        <div className="form-actions">
          <Button type="submit" loading={record.isPending}>
            {t('Record complaint')}
          </Button>
        </div>
      </form>
    </Card>
  );
}

/* ---------------------------------------------------------------------------- dashboard -- */

const pct = (v: number | null) => (v === null ? '—' : `${formatNumber(v)}%`);

function cellRows(cells: CountCell[], label: (key: string) => string) {
  return cells.map((c) => ({
    key: c.key,
    label: label(c.key),
    value: c.count,
    suppressed: c.suppressed,
  }));
}

function MonthsSelect({ months, onChange }: { months: number; onChange: (m: number) => void }) {
  return (
    <SelectField
      label={t('Period')}
      value={String(months)}
      onChange={(e) => onChange(Number(e.target.value))}
      options={[3, 6, 12, 24].map((m) => ({
        value: String(m),
        label: t('Last {count} months', { count: m }),
      }))}
    />
  );
}

function Dashboard({ meta, onOpen }: { meta: ComplaintsMeta; onOpen: (id: string) => void }) {
  const [months, setMonths] = useState(12);
  const dash = useComplaintDashboard(months);
  return (
    <div className="stack">
      <MonthsSelect months={months} onChange={setMonths} />
      <QueryView query={dash}>
        {(d) => (
          <>
            <Grid>
              <Stat label={t('Open complaints')} value={formatNumber(d.open)} />
              <Stat
                label={t('Acknowledged on time')}
                value={pct(d.timeliness.acknowledgedOnTimePct)}
                hint={t('of {count} due', { count: d.timeliness.acknowledgementsDue })}
              />
              <Stat
                label={t('Answered on time')}
                value={pct(d.timeliness.respondedOnTimePct)}
                hint={t('of {count} due', { count: d.timeliness.responsesDue })}
              />
              <Stat
                label={t('With the Ministry')}
                value={formatNumber(d.escalatedPending)}
                tone={d.escalatedPending ? 'warning' : undefined}
              />
            </Grid>
            {meta.isMinistry && (
              <p className="muted">
                {t('Counts below {n} are hidden so that no complainant can be identified.', {
                  n: d.smallCellThreshold,
                })}
              </p>
            )}
            <Grid min={320}>
              <Card title={t('By subject')}>
                <RankedBars
                  label={t('By subject')}
                  rows={cellRows(d.byCategory, (k) => categoryLabel(k as never))}
                />
              </Card>
              <Card title={t('By outcome')}>
                <RankedBars
                  label={t('By outcome')}
                  rows={cellRows(d.byOutcome, (k) => outcomeLabel(k as ComplaintOutcome | 'NONE'))}
                />
              </Card>
            </Grid>
            <Card title={t('Complaints received per month')}>
              <LineChart
                title={t('Complaints received per month')}
                data={d.byMonth.map((m) => ({ label: formatMonth(m.key), value: m.count ?? 0 }))}
              />
            </Card>
            {meta.isMinistry && (
              <Card title={t('By facility')}>
                <RankedBars
                  label={t('By facility')}
                  rows={d.byFacility.map((f) => ({
                    key: f.key,
                    label: f.label ?? f.key,
                    value: f.count,
                    suppressed: f.suppressed,
                  }))}
                />
              </Card>
            )}
            {!meta.isMinistry && (
              <Card title={t('Overdue complaints')}>
                {d.overdue.length === 0 ? (
                  <EmptyState title={t('Nothing overdue')} />
                ) : (
                  <Table caption={t('Overdue complaints')}>
                    <thead>
                      <tr>
                        <th>{t('Reference|complaint')}</th>
                        <th>{t('Subject')}</th>
                        <th>{t('Status')}</th>
                        <th>{t('Deadline')}</th>
                        <th>
                          <span className="sr-only">{t('Actions')}</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.overdue.map((c) => (
                        <tr key={c.id}>
                          <td>
                            <code>{c.reference}</code>
                          </td>
                          <td>{categoryLabel(c.category)}</td>
                          <td>
                            <StatusBadge status={c.status} />
                          </td>
                          <td>
                            <DueCell c={c} />
                          </td>
                          <td>
                            <Button size="sm" variant="secondary" onClick={() => onOpen(c.id)}>
                              {t('Open|action')}
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                )}
              </Card>
            )}
          </>
        )}
      </QueryView>
    </div>
  );
}

/* ----------------------------------------------------------------------------- feedback -- */

const score = (v: number | null) => (v === null ? '—' : formatNumber(v));

function GroupRow({ g, label }: { g: FeedbackGroup; label: string }) {
  return (
    <tr>
      <th scope="row">{label}</th>
      {g.suppressed ? (
        <td colSpan={FEEDBACK_ITEMS.length + 3} className="muted">
          {t('Too few to show')}
        </td>
      ) : (
        <>
          <td className="num">{formatNumber(g.responses ?? 0)}</td>
          <td className="num">
            <strong>{score(g.overall)}</strong>
          </td>
          {FEEDBACK_ITEMS.map((i) => (
            <td key={i} className="num">
              {score(g.items[i])}
            </td>
          ))}
          <td className="num">{pct(g.recommendPct)}</td>
        </>
      )}
    </tr>
  );
}

function GroupTable({
  caption,
  groups,
  label,
}: {
  caption: string;
  groups: FeedbackGroup[];
  label: (g: FeedbackGroup) => string;
}) {
  if (!groups.length) return <EmptyState title={t('No feedback yet')} />;
  return (
    <Table caption={caption}>
      <thead>
        <tr>
          <th>
            <span className="sr-only">{caption}</span>
          </th>
          <th className="num">{t('Responses')}</th>
          <th className="num">{t('Overall')}</th>
          {FEEDBACK_ITEMS.map((i) => (
            <th key={i} className="num">
              {feedbackItemLabel(i)}
            </th>
          ))}
          <th className="num">{t('Would recommend')}</th>
        </tr>
      </thead>
      <tbody>
        {groups.map((g) => (
          <GroupRow key={g.key} g={g} label={label(g)} />
        ))}
      </tbody>
    </Table>
  );
}

function FeedbackView({ meta }: { meta: ComplaintsMeta }) {
  const [months, setMonths] = useState(6);
  const dash = useFeedbackDashboard(months);
  return (
    <div className="stack">
      <MonthsSelect months={months} onChange={setMonths} />
      <QueryView query={dash}>
        {(d) => (
          <>
            <p className="muted">
              {t(
                'Ratings are anonymous (1 = very poor, 5 = very good). Groups with fewer than {n} responses are hidden.',
                { n: d.smallCellThreshold },
              )}
            </p>
            {d.overall && !d.overall.suppressed && (
              <Grid>
                <Stat label={t('Responses')} value={formatNumber(d.overall.responses ?? 0)} />
                <Stat label={t('Overall rating')} value={`${score(d.overall.overall)} / 5`} />
                <Stat label={t('Would recommend')} value={pct(d.overall.recommendPct)} />
              </Grid>
            )}
            <Card title={t('By type of visit')}>
              <GroupTable
                caption={t('By type of visit')}
                groups={d.bySetting}
                label={(g) => settingLabel(g.key as FeedbackSetting)}
              />
            </Card>
            {!meta.isMinistry && (
              <Card title={t('By ward')}>
                <GroupTable
                  caption={t('By ward')}
                  groups={d.byUnit}
                  label={(g) => g.label ?? '—'}
                />
              </Card>
            )}
            {meta.isMinistry && (
              <Card title={t('By facility')}>
                <GroupTable
                  caption={t('By facility')}
                  groups={d.byFacility}
                  label={(g) => g.label ?? '—'}
                />
              </Card>
            )}
            <Card title={t('By month')}>
              <GroupTable
                caption={t('By month')}
                groups={d.byMonth}
                label={(g) => formatMonth(g.key)}
              />
            </Card>
            {!meta.isMinistry && (
              <Card title={t('Comments')}>
                {d.comments.length === 0 ? (
                  <EmptyState title={t('No comments to show')}>
                    {t('Comments are shown only for types of visit with enough responses.')}
                  </EmptyState>
                ) : (
                  <ul className="stack" style={{ listStyle: 'none', padding: 0 }}>
                    {d.comments.map((c, i) => (
                      <li key={i} className="card" style={{ padding: '0.6rem 0.9rem' }}>
                        <div className="muted">
                          {formatMonth(c.month)} · {settingLabel(c.setting)} · {c.overall} / 5
                        </div>
                        <p style={{ margin: '0.3rem 0 0', whiteSpace: 'pre-wrap' }}>{c.comment}</p>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            )}
          </>
        )}
      </QueryView>
    </div>
  );
}
