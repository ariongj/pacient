import { t, tn } from '../../i18n';
import { useState, type FormEvent } from 'react';
import {
  KIND_LABELS,
  STATUS_LABELS,
  statusTone,
  useCreateRequest,
  useHolds,
  usePlaceHold,
  useReleaseHold,
  useRequests,
  useRetention,
  useRetentionPreview,
  useRunRetention,
  useUpdateRequest,
  useUpdateRetention,
  VIA_LABELS,
  type DataSubjectRequest,
  type LegalHold,
  type RequestKind,
  type RequestStatus,
  type RetentionPolicy,
} from '../../api/privacy';
import { useUser } from '../../auth/AuthContext';
import {
  Alert,
  Badge,
  Button,
  Card,
  DefinitionList,
  Dialog,
  EmptyState,
  ErrorAlert,
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
  compact,
  formValues,
} from '../../components/ui';
import { formatDate, formatDateTime, formatNumber } from '../../format';
import { localizedPatientName } from '../../api/identity';

type Tab = 'requests' | 'retention' | 'holds' | 'documents';
const KINDS = Object.keys(KIND_LABELS) as RequestKind[];
const STATUSES = Object.keys(STATUS_LABELS) as RequestStatus[];

/** Data protection (Law No. 06/L-082): requests register, retention, legal holds, documents. */
export function PrivacyAdminPage() {
  const user = useUser();
  const [tab, setTab] = useState<Tab>('requests');
  return (
    <>
      <PageHeader
        title={t('Data protection')}
        subtitle={
          user.role === 'MINISTRY'
            ? t(
                'National register of data protection requests, retention of operational data and legal holds.',
              )
            : t(
                'Data protection requests, legal holds and retention for patients of your facility.',
              )
        }
      />
      <Tabs<Tab>
        label={t('Data protection')}
        active={tab}
        onChange={setTab}
        tabs={[
          { id: 'requests', label: t('Requests') },
          { id: 'retention', label: t('Retention') },
          { id: 'holds', label: t('Legal holds') },
          { id: 'documents', label: t('Documents') },
        ]}
      />
      <TabPanel id={tab}>
        {tab === 'requests' && <RequestsTab />}
        {tab === 'retention' && <RetentionTab />}
        {tab === 'holds' && <HoldsTab />}
        {tab === 'documents' && <DocumentsTab />}
      </TabPanel>
    </>
  );
}

/* ------------------------------------------------------------------ requests */

function RequestsTab() {
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<RequestStatus | ''>('');
  const [kind, setKind] = useState<RequestKind | ''>('');
  const [overdue, setOverdue] = useState(false);
  const [recording, setRecording] = useState(false);
  const [handling, setHandling] = useState<DataSubjectRequest | null>(null);
  const q = useRequests({ page, status, kind, overdue });

  return (
    <div className="stack">
      <Card
        title={t('Data subject requests')}
        actions={
          <Button size="sm" onClick={() => setRecording(true)}>
            {t('Record a request')}
          </Button>
        }
      >
        <p className="muted">
          {t(
            'Patients can ask for a copy, correction, restriction, erasure or a portable export of their data, or object to a use. The law requires an answer within 30 days.',
          )}
        </p>
        <div className="row" style={{ flexWrap: 'wrap', gap: '1rem', alignItems: 'flex-end' }}>
          <SelectField
            label={t('Status')}
            value={status}
            placeholder={t('All')}
            options={STATUSES.map((s) => ({ value: s, label: STATUS_LABELS[s] }))}
            onChange={(e) => {
              setStatus(e.target.value as RequestStatus | '');
              setPage(1);
            }}
          />
          <SelectField
            label={t('Type of request')}
            value={kind}
            placeholder={t('All')}
            options={KINDS.map((k) => ({ value: k, label: KIND_LABELS[k] }))}
            onChange={(e) => {
              setKind(e.target.value as RequestKind | '');
              setPage(1);
            }}
          />
          <label className="row" style={{ gap: '0.4rem', marginBottom: '0.75rem' }}>
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
        </div>
        <QueryView query={q}>
          {(d) => (
            <>
              {d.overdueCount > 0 && (
                <Alert tone="danger">
                  {tn(
                    d.overdueCount,
                    '{count} request is past its 30-day deadline.',
                    '{count} requests are past their 30-day deadline.',
                  )}
                </Alert>
              )}
              {d.items.length === 0 ? (
                <EmptyState title={t('No requests')} />
              ) : (
                <Table caption={t('Data subject requests')}>
                  <thead>
                    <tr>
                      <th>{t('Patient')}</th>
                      <th>{t('Type of request')}</th>
                      <th>{t('Received')}</th>
                      <th>{t('Due')}</th>
                      <th>{t('Status')}</th>
                      <th>
                        <span className="sr-only">{t('Actions')}</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.items.map((r) => (
                      <tr key={r.id}>
                        <td>
                          <strong>{localizedPatientName(r.patientName)}</strong>
                          <span className="muted" style={{ display: 'block' }}>
                            {r.nationalId}
                            {r.facilityName ? ` · ${r.facilityName}` : ''}
                          </span>
                        </td>
                        <td>{KIND_LABELS[r.kind]}</td>
                        <td>
                          {formatDate(r.receivedAt)}
                          <span className="muted" style={{ display: 'block' }}>
                            {VIA_LABELS[r.receivedVia]}
                          </span>
                        </td>
                        <td>
                          {formatDate(r.dueAt)}
                          {r.overdue && (
                            <span style={{ display: 'block' }}>
                              <Badge tone="danger">{t('Overdue')}</Badge>
                            </span>
                          )}
                        </td>
                        <td>
                          <Badge tone={statusTone(r.status, r.overdue)}>
                            {STATUS_LABELS[r.status]}
                          </Badge>
                          {r.handledBy && (
                            <span className="muted" style={{ display: 'block' }}>
                              {r.handledBy}
                            </span>
                          )}
                        </td>
                        <td>
                          <Button size="sm" variant="secondary" onClick={() => setHandling(r)}>
                            {r.status === 'COMPLETED' || r.status === 'REJECTED'
                              ? t('View')
                              : t('Handle')}
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
              <Pagination page={d.page} totalPages={d.totalPages} onChange={setPage} />
            </>
          )}
        </QueryView>
      </Card>
      <RecordRequestDialog open={recording} onClose={() => setRecording(false)} />
      {handling && <HandleRequestDialog request={handling} onClose={() => setHandling(null)} />}
    </div>
  );
}

function RecordRequestDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const create = useCreateRequest(onClose);
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    create.mutate(compact(formValues(e.currentTarget)));
  };
  return (
    <Dialog open={open} onClose={onClose} title={t('Record a request')}>
      <form className="stack" onSubmit={submit}>
        <p className="muted">
          {t(
            'For requests made in person, by post or by email. The patient must be identified first.',
          )}
        </p>
        <TextField label={t('National ID number')} name="nationalId" required />
        <SelectField
          label={t('Type of request')}
          name="kind"
          required
          options={KINDS.map((k) => ({ value: k, label: KIND_LABELS[k] }))}
        />
        <SelectField
          label={t('Received')}
          name="receivedVia"
          required
          options={(['IN_PERSON', 'POST', 'EMAIL'] as const).map((v) => ({
            value: v,
            label: VIA_LABELS[v],
          }))}
        />
        <TextAreaField
          label={t('What the patient asks for')}
          name="details"
          maxLength={2000}
          hint={t('No clinical details are needed.')}
        />
        <ErrorAlert error={create.error} />
        <div className="form-actions">
          <Button variant="secondary" onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button type="submit" loading={create.isPending}>
            {t('Record request')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function HandleRequestDialog({
  request,
  onClose,
}: {
  request: DataSubjectRequest;
  onClose: () => void;
}) {
  const update = useUpdateRequest(onClose);
  const closed = request.status === 'COMPLETED' || request.status === 'REJECTED';
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const v = formValues(e.currentTarget);
    update.mutate({ id: request.id, status: v.status!, outcome: v.outcome || undefined });
  };
  return (
    <Dialog open onClose={onClose} title={KIND_LABELS[request.kind]} wide>
      <div className="stack">
        <DefinitionList
          items={[
            [t('Patient'), `${localizedPatientName(request.patientName)} (${request.nationalId ?? ''})`],
            [
              t('Received'),
              `${formatDateTime(request.receivedAt)} · ${VIA_LABELS[request.receivedVia]}`,
            ],
            [t('Due'), formatDate(request.dueAt)],
            [t('Request'), request.details],
            [t('Outcome'), request.outcome],
          ]}
        />
        {request.kind === 'ERASURE' && (
          <Alert tone="info">
            {t(
              'Health records cannot be erased while the legal retention period runs. Explain this to the patient; operational data can be removed and a note of disagreement can be added to the record.',
            )}
          </Alert>
        )}
        {request.kind === 'RECTIFICATION' && (
          <Alert tone="info">
            {t(
              'Corrections to clinical entries are made by the treating doctor through a correction request in the chart.',
            )}
          </Alert>
        )}
        {closed ? (
          <div className="form-actions">
            <Button variant="secondary" onClick={onClose}>
              {t('Close')}
            </Button>
          </div>
        ) : (
          <form className="stack" onSubmit={submit}>
            <SelectField
              label={t('New status')}
              name="status"
              required
              defaultValue={request.status === 'RECEIVED' ? 'IN_PROGRESS' : 'COMPLETED'}
              options={(['IN_PROGRESS', 'COMPLETED', 'REJECTED'] as const).map((s) => ({
                value: s,
                label: STATUS_LABELS[s],
              }))}
            />
            <TextAreaField
              label={t('Outcome')}
              name="outcome"
              maxLength={2000}
              hint={t(
                'Required when completing or rejecting. The patient is told the request was answered.',
              )}
            />
            <ErrorAlert error={update.error} />
            <div className="form-actions">
              <Button variant="secondary" onClick={onClose}>
                {t('Cancel')}
              </Button>
              <Button type="submit" loading={update.isPending}>
                {t('Save')}
              </Button>
            </div>
          </form>
        )}
      </div>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ retention */

function RetentionTab() {
  const q = useRetention();
  const preview = useRetentionPreview();
  const run = useRunRetention();
  const [editing, setEditing] = useState<RetentionPolicy | null>(null);
  const [confirmRun, setConfirmRun] = useState(false);

  return (
    <div className="stack">
      <Alert tone="info">
        {t(
          'Only operational data is removed: delivery logs, expired sessions and similar. Health records and the audit trail are never deleted by this job, and patients under a legal hold are skipped.',
        )}
      </Alert>
      <QueryView query={q}>
        {(d) => (
          <Card
            title={t('Retention policies')}
            actions={
              <div className="row" style={{ gap: '0.5rem' }}>
                <Button
                  size="sm"
                  variant="secondary"
                  loading={preview.isPending}
                  onClick={() => preview.mutate()}
                >
                  {t('Preview next run')}
                </Button>
                {d.canEdit && (
                  <Button size="sm" variant="danger" onClick={() => setConfirmRun(true)}>
                    {t('Run now')}
                  </Button>
                )}
              </div>
            }
          >
            <p className="muted">
              {t('The job runs every night at 02:00.')}{' '}
              {!d.canEdit && t('Retention periods are set by the Ministry.')}
            </p>
            <ErrorAlert error={preview.error ?? run.error} />
            {(preview.data || run.data) && (
              <Alert tone={run.data ? 'success' : 'info'}>
                {run.data
                  ? tn(
                      run.data.total,
                      '{count} record was removed.',
                      '{count} records were removed.',
                    )
                  : tn(
                      preview.data!.total,
                      'The next run would remove {count} record.',
                      'The next run would remove {count} records.',
                    )}
              </Alert>
            )}
            <Table caption={t('Retention policies')}>
              <thead>
                <tr>
                  <th>{t('Data')}</th>
                  <th>{t('Kept for')}</th>
                  <th>{t('Action')}</th>
                  <th>{t('Last run')}</th>
                  {preview.data && <th>{t('Next run')}</th>}
                  {d.canEdit && (
                    <th>
                      <span className="sr-only">{t('Actions')}</span>
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {d.items.map((p) => {
                  const next = preview.data?.categories.find((c) => c.category === p.category);
                  return (
                    <tr key={p.id}>
                      <td>
                        <strong>{t(p.description)}</strong>
                        <span className="muted" style={{ display: 'block' }}>
                          {t(p.legalBasis)}
                        </span>
                      </td>
                      <td>
                        {tn(p.retainDays, '{count} day', '{count} days')}
                        {!p.isActive && (
                          <span style={{ display: 'block' }}>
                            <Badge>{t('Paused')}</Badge>
                          </span>
                        )}
                      </td>
                      <td>{p.action === 'PURGE' ? t('Delete') : t('Anonymise')}</td>
                      <td>
                        {p.lastRunAt ? (
                          <>
                            {formatDateTime(p.lastRunAt)}
                            <span className="muted" style={{ display: 'block' }}>
                              {tn(p.lastRunCount ?? 0, '{count} record', '{count} records')}
                            </span>
                          </>
                        ) : (
                          t('Never')
                        )}
                      </td>
                      {preview.data && <td>{next ? formatNumber(next.count) : '—'}</td>}
                      {d.canEdit && (
                        <td>
                          <Button size="sm" variant="secondary" onClick={() => setEditing(p)}>
                            {t('Edit')}
                          </Button>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          </Card>
        )}
      </QueryView>
      {editing && <EditPolicyDialog policy={editing} onClose={() => setEditing(null)} />}
      <Dialog open={confirmRun} onClose={() => setConfirmRun(false)} title={t('Run retention now')}>
        <div className="stack">
          <p>
            {t(
              'Expired operational data will be removed now. This cannot be undone. The run is recorded in the audit trail.',
            )}
          </p>
          <div className="form-actions">
            <Button variant="secondary" onClick={() => setConfirmRun(false)}>
              {t('Cancel')}
            </Button>
            <Button
              variant="danger"
              loading={run.isPending}
              onClick={() => run.mutate(undefined, { onSettled: () => setConfirmRun(false) })}
            >
              {t('Run now')}
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}

function EditPolicyDialog({ policy, onClose }: { policy: RetentionPolicy; onClose: () => void }) {
  const update = useUpdateRetention(onClose);
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const v = formValues(e.currentTarget);
    update.mutate({
      category: policy.category,
      retainDays: Number(v.retainDays),
      legalBasis: v.legalBasis,
      isActive: v.isActive === 'on',
    });
  };
  return (
    <Dialog open onClose={onClose} title={t(policy.description)}>
      <form className="stack" onSubmit={submit}>
        <TextField
          label={t('Keep for (days)')}
          name="retainDays"
          type="number"
          min={1}
          max={36500}
          required
          defaultValue={policy.retainDays}
          hint={
            policy.defaultDays
              ? tn(policy.defaultDays, 'Default: {count} day', 'Default: {count} days')
              : undefined
          }
        />
        <TextAreaField
          label={t('Legal basis')}
          name="legalBasis"
          required
          minLength={10}
          maxLength={300}
          defaultValue={policy.legalBasis}
        />
        <label className="row" style={{ gap: '0.4rem' }}>
          <input type="checkbox" name="isActive" defaultChecked={policy.isActive} />
          {t('Active')}
        </label>
        <ErrorAlert error={update.error} />
        <div className="form-actions">
          <Button variant="secondary" onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button type="submit" loading={update.isPending}>
            {t('Save')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ legal holds */

function HoldsTab() {
  const [active, setActive] = useState(true);
  const [placing, setPlacing] = useState(false);
  const [releasing, setReleasing] = useState<LegalHold | null>(null);
  const q = useHolds(active);
  return (
    <div className="stack">
      <Card
        title={t('Legal holds')}
        actions={
          <Button size="sm" onClick={() => setPlacing(true)}>
            {t('Place a legal hold')}
          </Button>
        }
      >
        <p className="muted">
          {t(
            'A legal hold preserves everything about a patient – for a court case, complaint or investigation. Retention skips held patients until the hold is released.',
          )}
        </p>
        <label className="row" style={{ gap: '0.4rem', marginBottom: '0.75rem' }}>
          <input type="checkbox" checked={!active} onChange={(e) => setActive(!e.target.checked)} />
          {t('Show released holds')}
        </label>
        <QueryView query={q}>
          {(d) =>
            d.items.length === 0 ? (
              <EmptyState
                title={active ? t('No active legal holds') : t('No released legal holds')}
              />
            ) : (
              <Table caption={t('Legal holds')}>
                <thead>
                  <tr>
                    <th>{t('Patient')}</th>
                    <th>{t('Reason')}</th>
                    <th>{t('Placed')}</th>
                    <th>
                      {active ? <span className="sr-only">{t('Actions')}</span> : t('Released')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {d.items.map((h) => (
                    <tr key={h.id}>
                      <td>
                        <strong>{localizedPatientName(h.patientName)}</strong>
                        <span className="muted" style={{ display: 'block' }}>
                          {h.nationalId}
                        </span>
                      </td>
                      <td>{h.reason}</td>
                      <td>
                        {formatDate(h.createdAt)}
                        {h.createdBy && (
                          <span className="muted" style={{ display: 'block' }}>
                            {h.createdBy}
                          </span>
                        )}
                      </td>
                      <td>
                        {h.releasedAt ? (
                          formatDate(h.releasedAt)
                        ) : (
                          <Button size="sm" variant="secondary" onClick={() => setReleasing(h)}>
                            {t('Release')}
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
      </Card>
      <PlaceHoldDialog open={placing} onClose={() => setPlacing(false)} />
      {releasing && <ReleaseHoldDialog hold={releasing} onClose={() => setReleasing(null)} />}
    </div>
  );
}

function PlaceHoldDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const place = usePlaceHold(onClose);
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    place.mutate(formValues(e.currentTarget));
  };
  return (
    <Dialog open={open} onClose={onClose} title={t('Place a legal hold')}>
      <form className="stack" onSubmit={submit}>
        <TextField label={t('National ID number')} name="nationalId" required />
        <TextAreaField
          label={t('Reason')}
          name="reason"
          required
          minLength={10}
          maxLength={500}
          hint={t('For example the court case or complaint number.')}
        />
        <ErrorAlert error={place.error} />
        <div className="form-actions">
          <Button variant="secondary" onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button type="submit" loading={place.isPending}>
            {t('Place hold')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function ReleaseHoldDialog({ hold, onClose }: { hold: LegalHold; onClose: () => void }) {
  const release = useReleaseHold(onClose);
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    release.mutate({ id: hold.id, reason: formValues(e.currentTarget).reason ?? '' });
  };
  return (
    <Dialog open onClose={onClose} title={t('Release legal hold')}>
      <form className="stack" onSubmit={submit}>
        <p>
          {t('Release the hold on {name}? Normal retention applies again afterwards.', {
            name: localizedPatientName(hold.patientName),
          })}
        </p>
        <TextAreaField
          label={t('Reason for release')}
          name="reason"
          required
          minLength={5}
          maxLength={500}
        />
        <ErrorAlert error={release.error} />
        <div className="form-actions">
          <Button variant="secondary" onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button type="submit" loading={release.isPending}>
            {t('Release')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ documents */

const PROCESSING: [string, string, string][] = [
  [
    'Health records (diagnoses, results, medicines, notes)',
    'Provision of health care; public interest in public health',
    'Kept for the period set by health legislation; never deleted by the retention job',
  ],
  [
    'Identity and contact details',
    'Provision of health care; legal obligation to identify patients',
    'As long as the health record',
  ],
  [
    'Consent decisions',
    'Consent (research, sharing between facilities)',
    'As long as the health record',
  ],
  ['Audit trail of access', 'Legal obligation (accountability and security)', 'Never deleted'],
  [
    'Notifications, email and SMS delivery logs',
    'Provision of the service; legitimate interest in reliable delivery',
    'See retention policies',
  ],
  [
    'Sign-in sessions, devices and verification codes',
    'Security of processing',
    'See retention policies',
  ],
];

function DocumentsTab() {
  return (
    <div className="stack">
      <Grid min={220}>
        <Stat label={t('Deadline to answer a request')} value={t('30 days')} />
        <Stat label={t('Breach notification to the Agency')} value={t('72 hours')} />
        <Stat label={t('Transfers outside Kosovo')} value={t('None')} />
      </Grid>
      <Card title={t('Records of processing')}>
        <Table caption={t('Records of processing')}>
          <thead>
            <tr>
              <th>{t('Data')}</th>
              <th>{t('Lawful basis')}</th>
              <th>{t('Retention')}</th>
            </tr>
          </thead>
          <tbody>
            {PROCESSING.map(([what, basis, keep]) => (
              <tr key={what}>
                <td>{t(what)}</td>
                <td>{t(basis)}</td>
                <td>{t(keep)}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>
      <Card title={t('Data protection impact assessment – key controls')}>
        <ul>
          <li>
            {t(
              'Access only for the patient’s care team; emergency access is justified and reviewed.',
            )}
          </li>
          <li>
            {t('Every view and change is written to an append-only audit trail patients can see.')}
          </li>
          <li>
            {t(
              'Encryption in transit and of sensitive fields at rest; no health details in email or SMS.',
            )}
          </li>
          <li>{t('Two-step sign-in for staff; sessions expire and devices are tracked.')}</li>
          <li>
            {t(
              'Operational data is removed on schedule; legal holds preserve records when needed.',
            )}
          </li>
        </ul>
      </Card>
      <Card title={t('Personal data breach')}>
        <p>
          {t(
            'Report a suspected breach to the data protection officer at once. The controller notifies the Information and Privacy Agency within 72 hours, and the patients affected without undue delay when the risk to them is high.',
          )}
        </p>
        <p className="muted">
          {t('The full documentation is kept in PRIVACY.md in the system documentation.')}
        </p>
      </Card>
    </div>
  );
}
