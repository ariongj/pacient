import { useEffect, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';
import { GROUPS, type Abo, type RhD } from '../../api/bloodbank';
import {
  DONORS_KEY,
  donorGroup,
  donorStatusLabel,
  outcomeLabel,
  problemLabel,
  reasonLabel,
  testingLabel,
  useDonor,
  useDonorDefinitions,
  useDonorsAction,
  useDonorsMe,
  useDonorStats,
  useWorklist,
  type AppealResult,
  type Definitions,
  type DonorDetail,
  type DonorRow,
  type Eligibility,
  type Lookup,
  type Marker,
  type MarkerResult,
  type Measurements,
  type VisitOutcome,
  type WorklistItem,
} from '../../api/donors';
import { RankedBars, StackedBars } from '../../components/charts';
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
  QueryView,
  SelectField,
  Stat,
  TabPanel,
  Table,
  Tabs,
  TextAreaField,
  TextField,
  type Tone,
} from '../../components/ui';
import { age, formatDate, formatDateTime, formatMonth, formatTime } from '../../format';
import { t, tn } from '../../i18n';
import './donors.css';

type TabId = 'donors' | 'today' | 'testing' | 'deferrals' | 'appeals' | 'stats';

const statusTone = (s: DonorRow['status']): Tone =>
  s === 'ACTIVE' ? 'success' : s === 'DEFERRED' ? 'warning' : 'danger';

export function BloodDonorsPage() {
  const me = useDonorsMe();
  const [params, setParams] = useSearchParams();
  const donorId = params.get('donor');
  const [tab, setTab] = useState<TabId>('donors');
  const isStaff = me.data?.isStaff ?? false;
  const openDonor = (id: string | null) => {
    const next = new URLSearchParams(params);
    if (id) next.set('donor', id);
    else next.delete('donor');
    setParams(next);
    if (id) setTab('donors');
  };
  return (
    <>
      <PageHeader
        title={t('Blood donors')}
        subtitle={t(
          'Donor register, donation visits with eligibility checks, mandatory testing and appeals.',
        )}
      />
      {me.isPending ? null : !isStaff ? (
        <>
          <Alert tone="info" title={t('You are not on the blood bank staff')}>
            {t(
              'Donors are registered and examined by the staff of a blood bank unit. Ask your director to add you to the unit if you work there.',
            )}
          </Alert>
          {me.data?.canSeeStats && <StatsTab />}
        </>
      ) : (
        <>
          <Tabs<TabId>
            label={t('Blood donor sections')}
            active={tab}
            onChange={setTab}
            tabs={[
              { id: 'donors', label: t('Donors') },
              { id: 'today', label: t('Today') },
              { id: 'testing', label: t('Testing queue') },
              { id: 'deferrals', label: t('Deferrals') },
              { id: 'appeals', label: t('Appeals') },
              { id: 'stats', label: t('Statistics') },
            ]}
          />
          <TabPanel id={tab}>
            {tab === 'donors' &&
              (donorId ? (
                <DonorView id={donorId} onBack={() => openDonor(null)} />
              ) : (
                <DonorsTab onOpen={openDonor} />
              ))}
            {tab === 'today' && <TodayTab onOpen={openDonor} />}
            {tab === 'testing' && <TestingTab onOpen={openDonor} />}
            {tab === 'deferrals' && <DeferralsTab onOpen={openDonor} />}
            {tab === 'appeals' && <AppealsTab />}
            {tab === 'stats' && <StatsTab />}
          </TabPanel>
        </>
      )}
      <p className="muted small donors-note">
        {t(
          'Eligibility rules are illustrative, after EU Directive 2004/33/EC; the national blood transfusion rules apply.',
        )}
      </p>
    </>
  );
}

/* ------------------------------------------------------------------ search & register ----- */

function DonorsTab({ onOpen }: { onOpen: (id: string) => void }) {
  const [q, setQ] = useState('');
  const [term, setTerm] = useState('');
  const list = useQuery({
    queryKey: [...DONORS_KEY, 'search', term],
    queryFn: () =>
      api<{ items: DonorRow[] }>('/blood-donors/donors', { query: { q: term } }).then(
        (r) => r.items,
      ),
  });
  const [registering, setRegistering] = useState(false);
  return (
    <Card
      title={t('Donors')}
      actions={
        <Button size="sm" onClick={() => setRegistering(true)}>
          {t('Register a donor')}
        </Button>
      }
    >
      <form
        className="search-bar"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          setTerm(q.trim());
        }}
      >
        <TextField
          label={t('National ID or name')}
          hint={t('Names find donors registered here; a national ID finds any donor.')}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <Button type="submit" variant="secondary">
          {t('Search')}
        </Button>
      </form>
      <QueryView query={list}>
        {(items) =>
          items.length === 0 ? (
            <EmptyState title={t('No donors found')} />
          ) : (
            <DonorTable items={items} onOpen={onOpen} />
          )
        }
      </QueryView>
      {registering && (
        <RegisterDialog
          onClose={() => setRegistering(false)}
          onDone={(id) => {
            setRegistering(false);
            onOpen(id);
          }}
        />
      )}
    </Card>
  );
}

function DonorTable({
  items,
  onOpen,
  showReason,
}: {
  items: DonorRow[];
  onOpen: (id: string) => void;
  showReason?: boolean;
}) {
  return (
    <Table caption={t('Donors')}>
      <thead>
        <tr>
          <th>{t('Donor')}</th>
          <th>{t('Blood group')}</th>
          <th>{t('Status')}</th>
          <th className="num">{t('Donations')}</th>
          <th>{t('Last donation')}</th>
          {showReason && <th>{t('Reason')}</th>}
        </tr>
      </thead>
      <tbody>
        {items.map((d) => (
          <tr key={d.id}>
            <td>
              <button type="button" className="link-button" onClick={() => onOpen(d.id)}>
                {d.firstName} {d.lastName}
              </button>
              <div className="muted small">
                {d.nationalId} · {t('{age} y', { age: age(d.dateOfBirth) })}
              </div>
            </td>
            <td>
              <strong>{donorGroup(d.abo, d.rhD)}</strong>
            </td>
            <td>
              <Badge tone={statusTone(d.status)}>{donorStatusLabel(d.status)}</Badge>
              {d.status === 'DEFERRED' && d.deferredUntil && (
                <div className="muted small">
                  {t('until {date}', { date: formatDate(d.deferredUntil) })}
                </div>
              )}
            </td>
            <td className="num">{d.donationCount}</td>
            <td>{formatDate(d.lastDonationAt)}</td>
            {showReason && <td className="small">{d.deferralReason ?? '—'}</td>}
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

function RegisterDialog({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: (id: string) => void;
}) {
  const [nationalId, setNationalId] = useState('');
  const [consent, setConsent] = useState(true);
  const lookup = useDonorsAction<string, Lookup>(
    (id) => `/lookup?nationalId=${encodeURIComponent(id)}`,
    'GET',
    () => undefined,
  );
  const register = useDonorsAction<{ patientId: string; contactConsent: boolean }, { id: string }>(
    () => '/donors',
  );
  const found = lookup.data;
  return (
    <Dialog open onClose={onClose} title={t('Register a donor')}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          lookup.mutate(nationalId.trim());
        }}
      >
        <div className="search-bar">
          <TextField
            label={t('National ID')}
            required
            value={nationalId}
            onChange={(e) => setNationalId(e.target.value)}
          />
          <Button type="submit" variant="secondary" loading={lookup.isPending}>
            {t('Find')}
          </Button>
        </div>
      </form>
      <ErrorAlert error={lookup.error ?? register.error} />
      {found && (
        <div className="stack">
          <DefinitionList
            items={[
              [t('Name'), `${found.person.firstName} ${found.person.lastName}`],
              [t('Date of birth'), formatDate(found.person.dateOfBirth)],
              [t('Age'), t('{age} y', { age: age(found.person.dateOfBirth) })],
            ]}
          />
          {found.donorId ? (
            <Alert tone="info" title={t('Already registered as a donor')}>
              <Button size="sm" onClick={() => onDone(found.donorId!)}>
                {t('Open the donor record')}
              </Button>
            </Alert>
          ) : found.registrationProblem ? (
            <Alert tone="warning" title={t('Cannot be registered')}>
              {problemLabel(found.registrationProblem)}
            </Alert>
          ) : (
            <>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={consent}
                  onChange={(e) => setConsent(e.target.checked)}
                />
                {t('Agrees to be contacted when their blood group is needed')}
              </label>
              <div className="form-actions">
                <Button
                  loading={register.isPending}
                  onClick={() =>
                    register.mutate(
                      { patientId: found.person.id, contactConsent: consent },
                      { onSuccess: (r) => onDone(r.id) },
                    )
                  }
                >
                  {t('Register')}
                </Button>
              </div>
            </>
          )}
        </div>
      )}
    </Dialog>
  );
}

/* ------------------------------------------------------------------ donor record --------- */

function DonorView({ id, onBack }: { id: string; onBack: () => void }) {
  const donor = useDonor(id);
  const [visit, setVisit] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [reaction, setReaction] = useState<string | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  const [deferring, setDeferring] = useState(false);
  return (
    <div className="stack">
      <div>
        <Button variant="ghost" size="sm" onClick={onBack}>
          ← {t('All donors')}
        </Button>
      </div>
      <QueryView query={donor}>
        {(d) => (
          <>
            <Card
              title={`${d.person.firstName} ${d.person.lastName}`}
              actions={
                <>
                  <Button size="sm" onClick={() => setVisit(true)}>
                    {t('New donation visit')}
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => setDeferring(true)}>
                    {d.donor.status === 'ACTIVE' ? t('Defer') : t('Change deferral')}
                  </Button>
                </>
              }
            >
              <div className="donor-head">
                <div className="donor-group" aria-label={t('Blood group')}>
                  {donorGroup(d.donor.abo, d.donor.rhD)}
                </div>
                <DefinitionList
                  items={[
                    [t('National ID'), d.person.nationalId],
                    [
                      t('Age'),
                      `${t('{age} y', { age: age(d.person.dateOfBirth) })} · ${
                        d.person.sex === 'FEMALE' ? t('Female') : t('Male')
                      }`,
                    ],
                    [
                      t('Status'),
                      <Badge key="s" tone={statusTone(d.donor.status)}>
                        {donorStatusLabel(d.donor.status)}
                      </Badge>,
                    ],
                    [t('Donations'), String(d.donor.donationCount)],
                    [t('Last donation'), formatDate(d.donor.lastDonationAt)],
                    [
                      t('Next possible donation'),
                      d.donor.status === 'PERMANENTLY_DEFERRED'
                        ? '—'
                        : formatDate(d.nextEligibleDate),
                    ],
                    [t('May be contacted'), d.donor.contactConsent ? t('Yes') : t('No')],
                  ]}
                />
              </div>
              {d.donor.deferralReason && d.donor.status !== 'ACTIVE' && (
                <Alert
                  tone={d.donor.status === 'PERMANENTLY_DEFERRED' ? 'danger' : 'warning'}
                  title={t('Deferral reason (blood bank staff only)')}
                >
                  {d.donor.deferralReason}
                </Alert>
              )}
            </Card>
            <Card title={t('Donation history')}>
              {d.donations.length === 0 ? (
                <EmptyState title={t('No donation visits yet')} />
              ) : (
                <Table caption={t('Donation history')}>
                  <thead>
                    <tr>
                      <th>{t('Date')}</th>
                      <th>{t('Outcome')}</th>
                      <th className="num">{t('Volume (ml)')}</th>
                      <th>{t('Unit')}</th>
                      <th>{t('Testing')}</th>
                      <th>{t('Reaction')}</th>
                      <th>
                        <span className="sr-only">{t('Actions')}</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.donations.map((x) => (
                      <tr key={x.id}>
                        <td>
                          {formatDateTime(x.attendedAt)}
                          <div className="muted small">{x.facilityName}</div>
                        </td>
                        <td>
                          {outcomeLabel(x.outcome)}
                          {x.deferralReason && (
                            <div className="muted small">
                              {x.deferralReason
                                .split('; ')
                                .map((c) => reasonLabel(c))
                                .join(', ')}
                            </div>
                          )}
                        </td>
                        <td className="num">{x.volumeMl ?? '—'}</td>
                        <td className="mono">{x.unitNumber ?? '—'}</td>
                        <td>
                          {x.testing === 'NOT_PASSED' ? (
                            <Badge tone="danger">{testingLabel(x.testing)}</Badge>
                          ) : x.testing === 'AWAITING' ? (
                            <Badge tone="warning">{testingLabel(x.testing)}</Badge>
                          ) : (
                            testingLabel(x.testing)
                          )}
                        </td>
                        <td className="small">{x.adverseReaction ?? '—'}</td>
                        <td>
                          <div className="row">
                            {x.testing === 'AWAITING' && (
                              <Button size="sm" onClick={() => setTesting(x.id)}>
                                {t('Record tests')}
                              </Button>
                            )}
                            {x.unitNumber && (
                              <Button size="sm" variant="ghost" onClick={() => setViewing(x.id)}>
                                {t('Screening results')}
                              </Button>
                            )}
                            {!x.adverseReaction && x.outcome !== 'DEFERRED' && (
                              <Button size="sm" variant="ghost" onClick={() => setReaction(x.id)}>
                                {t('Add reaction')}
                              </Button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </Card>
            {visit && <VisitDialog detail={d} onClose={() => setVisit(false)} />}
            {testing && (
              <TestsDialog
                donationId={testing}
                known={d.donor.abo && d.donor.rhD ? { abo: d.donor.abo, rhD: d.donor.rhD } : null}
                onClose={() => setTesting(null)}
              />
            )}
            {reaction && <ReactionDialog donationId={reaction} onClose={() => setReaction(null)} />}
            {viewing && <ResultsDialog donationId={viewing} onClose={() => setViewing(null)} />}
            {deferring && <DeferDialog detail={d} onClose={() => setDeferring(false)} />}
          </>
        )}
      </QueryView>
    </div>
  );
}

/* ------------------------------------------------------------------ visit ---------------- */

const numberOrNull = (v: string) => (v.trim() === '' ? null : Number(v.replace(',', '.')));

function VisitDialog({ detail, onClose }: { detail: DonorDetail; onClose: () => void }) {
  const defs = useDonorDefinitions();
  const female = detail.person.sex === 'FEMALE';
  const [answers, setAnswers] = useState<Record<string, boolean>>({});
  const [m, setM] = useState<Record<keyof Measurements, string>>({
    haemoglobin: '',
    systolic: '',
    diastolic: '',
    pulse: '',
    weightKg: '',
  });
  const [outcome, setOutcome] = useState<VisitOutcome>('COMPLETED');
  const [volume, setVolume] = useState('450');
  const [manualDays, setManualDays] = useState('');
  const [manualReason, setManualReason] = useState('');
  const [medications, setMedications] = useState('');
  const [reaction, setReaction] = useState('');
  const measurements: Measurements = {
    haemoglobin: numberOrNull(m.haemoglobin),
    systolic: numberOrNull(m.systolic),
    diastolic: numberOrNull(m.diastolic),
    pulse: numberOrNull(m.pulse),
    weightKg: numberOrNull(m.weightKg),
  };
  const body = JSON.stringify({ answers, measurements });
  const [debounced, setDebounced] = useState(body);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(body), 300);
    return () => clearTimeout(timer);
  }, [body]);
  const eligibility = useQuery({
    queryKey: [...DONORS_KEY, 'eligibility', detail.donor.id, debounced],
    queryFn: () =>
      api<Eligibility>(`/blood-donors/donors/${detail.donor.id}/eligibility`, {
        method: 'POST',
        body: JSON.parse(debounced) as object,
      }),
    placeholderData: (prev) => prev,
  });
  const record = useDonorsAction<Record<string, unknown>>(
    () => `/donors/${detail.donor.id}/donations`,
  );
  const questions = (defs.data?.questions ?? []).filter((q) => female || !q.womenOnly);
  const answered = questions.every((q) => answers[q.code] !== undefined);
  const measured = Object.values(measurements).every((v) => v != null && !Number.isNaN(v));
  const eligible = eligibility.data?.eligible ?? false;
  useEffect(() => {
    if (eligibility.data && !eligibility.data.eligible && outcome === 'COMPLETED') {
      setOutcome('DEFERRED');
    }
  }, [eligibility.data, outcome]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    record.mutate(
      {
        answers,
        measurements,
        outcome,
        medications: medications.trim() || null,
        volumeMl: outcome === 'DEFERRED' ? null : numberOrNull(volume),
        manualDeferral:
          outcome === 'DEFERRED' && manualDays && manualReason.trim()
            ? { days: Number(manualDays), reason: manualReason.trim() }
            : null,
        adverseReaction: reaction.trim() || null,
      },
      { onSuccess: onClose },
    );
  };

  return (
    <Dialog open onClose={onClose} title={t('Donation visit')} wide>
      <form className="stack" onSubmit={submit}>
        <fieldset className="donor-questions">
          <legend>{t('Health questionnaire')}</legend>
          <p className="muted small">
            {t('Ask each question in private. The donor’s answers are confidential.')}
          </p>
          {questions.map((q) => (
            <div key={q.code} className="donor-question" role="radiogroup" aria-label={t(q.text)}>
              <span>
                {t(q.text)}
                {q.permanent && (
                  <span className="muted small"> · {t('permanent deferral if yes')}</span>
                )}
              </span>
              <span className="row">
                {[true, false].map((v) => (
                  <label key={String(v)} className="checkbox">
                    <input
                      type="radio"
                      name={`q-${q.code}`}
                      checked={answers[q.code] === v}
                      onChange={() => setAnswers({ ...answers, [q.code]: v })}
                    />
                    {v ? t('Yes') : t('No')}
                  </label>
                ))}
              </span>
            </div>
          ))}
        </fieldset>
        <TextField
          label={t('Current medicines (optional)')}
          value={medications}
          maxLength={300}
          onChange={(e) => setMedications(e.target.value)}
        />
        <fieldset className="donor-measure">
          <legend>{t('Checks before donation')}</legend>
          <div className="form-grid">
            <TextField
              label={t('Haemoglobin (g/L)')}
              hint={t('At least {min}', {
                min: female ? (defs.data?.limits.hbWomen ?? 125) : (defs.data?.limits.hbMen ?? 135),
              })}
              inputMode="decimal"
              value={m.haemoglobin}
              onChange={(e) => setM({ ...m, haemoglobin: e.target.value })}
            />
            <TextField
              label={t('Systolic (mmHg)')}
              inputMode="numeric"
              value={m.systolic}
              onChange={(e) => setM({ ...m, systolic: e.target.value })}
            />
            <TextField
              label={t('Diastolic (mmHg)')}
              inputMode="numeric"
              value={m.diastolic}
              onChange={(e) => setM({ ...m, diastolic: e.target.value })}
            />
            <TextField
              label={t('Pulse (/min)')}
              inputMode="numeric"
              value={m.pulse}
              onChange={(e) => setM({ ...m, pulse: e.target.value })}
            />
            <TextField
              label={t('Weight (kg)')}
              inputMode="decimal"
              value={m.weightKg}
              onChange={(e) => setM({ ...m, weightKg: e.target.value })}
            />
          </div>
        </fieldset>
        <EligibilityBox
          result={eligibility.data}
          defs={defs.data}
          complete={answered && measured}
        />
        <SelectField
          label={t('Outcome')}
          value={outcome}
          onChange={(e) => setOutcome(e.target.value as VisitOutcome)}
          options={[
            ...(eligible ? [{ value: 'COMPLETED', label: outcomeLabel('COMPLETED') }] : []),
            { value: 'DEFERRED', label: outcomeLabel('DEFERRED') },
            { value: 'ABORTED', label: outcomeLabel('ABORTED') },
          ]}
        />
        {outcome !== 'DEFERRED' && (
          <TextField
            label={t('Volume collected (ml)')}
            hint={
              outcome === 'COMPLETED'
                ? t('A whole-blood donation is {min}–{max} ml', {
                    min: defs.data?.limits.volume[0] ?? 405,
                    max: defs.data?.limits.volume[1] ?? 495,
                  })
                : undefined
            }
            inputMode="numeric"
            value={volume}
            onChange={(e) => setVolume(e.target.value)}
          />
        )}
        {outcome === 'DEFERRED' && (
          <div className="form-grid">
            <TextField
              label={t('Extra deferral (days, optional)')}
              inputMode="numeric"
              value={manualDays}
              onChange={(e) => setManualDays(e.target.value)}
            />
            <TextField
              label={t('Reason for the extra deferral')}
              value={manualReason}
              maxLength={300}
              onChange={(e) => setManualReason(e.target.value)}
            />
          </div>
        )}
        {outcome !== 'DEFERRED' && (
          <TextField
            label={t('Reaction during donation (optional)')}
            value={reaction}
            maxLength={300}
            onChange={(e) => setReaction(e.target.value)}
          />
        )}
        {outcome === 'COMPLETED' && (
          <Alert tone="info">
            {t(
              'The unit enters stock only after the mandatory tests (blood group, HIV, hepatitis B and C, syphilis) are recorded.',
            )}
          </Alert>
        )}
        <ErrorAlert error={record.error} />
        <div className="form-actions">
          <Button variant="secondary" onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button
            type="submit"
            loading={record.isPending}
            disabled={outcome === 'COMPLETED' && (!answered || !measured || !eligible)}
          >
            {t('Save visit')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function EligibilityBox({
  result,
  defs,
  complete,
}: {
  result: Eligibility | undefined;
  defs: Definitions | undefined;
  complete: boolean;
}) {
  if (!result) return null;
  if (result.eligible) {
    return (
      <div aria-live="polite">
        <Alert
          tone={complete ? 'success' : 'info'}
          title={complete ? t('Eligible to donate today') : t('No problem found so far')}
        >
          {!complete && t('Answer every question and enter all checks.')}
        </Alert>
      </div>
    );
  }
  return (
    <div aria-live="polite">
      <Alert
        tone="warning"
        title={
          result.deferral?.status === 'PERMANENTLY_DEFERRED'
            ? t('Not eligible – permanent deferral')
            : result.deferral?.until
              ? t('Not eligible – deferral until {date}', {
                  date: formatDate(result.deferral.until),
                })
              : t('Not eligible today')
        }
      >
        <ul>
          {result.problems.map((p) => (
            <li key={p.code}>{problemLabel(p, defs?.questions)}</li>
          ))}
        </ul>
      </Alert>
    </div>
  );
}

/* ------------------------------------------------------------------ tests ---------------- */

/** The recorded screening results of one donation (viewing is recorded in the access log). */
function ResultsDialog({ donationId, onClose }: { donationId: string; onClose: () => void }) {
  const defs = useDonorDefinitions();
  const q = useQuery({
    queryKey: ['blood-donors', 'tests', donationId],
    queryFn: () =>
      api<
        Record<Marker, MarkerResult> & {
          abo: Abo;
          rhD: RhD;
          labReference: string | null;
          testedAt: string;
          testedBy: string;
        }
      >(`/blood-donors/donations/${donationId}/tests`),
  });
  return (
    <Dialog open onClose={onClose} title={t('Screening results')}>
      <QueryView query={q}>
        {(r) => (
          <div className="stack">
            <DefinitionList
              items={[
                [t('Blood group'), donorGroup(r.abo, r.rhD)],
                ...(defs.data?.markers ?? []).map(
                  (m) =>
                    [
                      t(m.label),
                      r[m.code] === 'REACTIVE' ? (
                        <Badge tone="danger">{t('Reactive')}</Badge>
                      ) : (
                        t('Negative')
                      ),
                    ] as [string, React.ReactNode],
                ),
                [t('Laboratory reference'), r.labReference ?? '—'],
                [t('Recorded'), `${formatDateTime(r.testedAt)} · ${r.testedBy}`],
              ]}
            />
            <div className="form-actions">
              <Button onClick={onClose}>{t('Close')}</Button>
            </div>
          </div>
        )}
      </QueryView>
    </Dialog>
  );
}

function TestsDialog({
  donationId,
  known,
  onClose,
}: {
  donationId: string;
  known: { abo: Abo; rhD: RhD } | null;
  onClose: () => void;
}) {
  const defs = useDonorDefinitions();
  const [group, setGroup] = useState(known ? `${known.abo}|${known.rhD}` : '');
  const [results, setResults] = useState<Partial<Record<Marker, MarkerResult>>>({});
  const [labReference, setLabReference] = useState('');
  const save = useDonorsAction<
    Record<string, unknown>,
    { released: boolean; unit: { unitNumber: string } }
  >(() => `/donations/${donationId}/tests`);
  const markers = defs.data?.markers ?? [];
  const reactive = markers.some((m) => results[m.code] === 'REACTIVE');
  const complete = group && markers.length > 0 && markers.every((m) => results[m.code]);
  return (
    <Dialog open onClose={onClose} title={t('Mandatory donation tests')}>
      {save.data ? (
        <div className="stack">
          <Alert
            tone={save.data.released ? 'success' : 'danger'}
            title={
              save.data.released
                ? t('Unit {unit} released to stock', { unit: save.data.unit.unitNumber })
                : t('Unit {unit} discarded – not for transfusion', {
                    unit: save.data.unit.unitNumber,
                  })
            }
          >
            {!save.data.released &&
              t(
                'The donor is permanently deferred. The blood bank doctors were asked to contact the donor for confirmatory testing and counselling.',
              )}
          </Alert>
          <div className="form-actions">
            <Button onClick={onClose}>{t('Close')}</Button>
          </div>
        </div>
      ) : (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            const [abo, rhD] = group.split('|');
            save.mutate({
              abo,
              rhD,
              ...results,
              ...(labReference.trim() ? { labReference: labReference.trim() } : {}),
            });
          }}
        >
          <SelectField
            label={t('Blood group')}
            hint={
              known
                ? t('Recorded group: {group}', { group: donorGroup(known.abo, known.rhD) })
                : undefined
            }
            required
            value={group}
            placeholder={t('Choose…')}
            onChange={(e) => setGroup(e.target.value)}
            options={GROUPS.map(({ abo, rhD }) => ({
              value: `${abo}|${rhD}`,
              label: donorGroup(abo, rhD),
            }))}
          />
          {markers.map((m) => (
            <div key={m.code} className="donor-question" role="radiogroup" aria-label={t(m.label)}>
              <span>{t(m.label)}</span>
              <span className="row">
                {(['NEGATIVE', 'REACTIVE'] as const).map((v) => (
                  <label key={v} className="checkbox">
                    <input
                      type="radio"
                      name={`m-${m.code}`}
                      checked={results[m.code] === v}
                      onChange={() => setResults({ ...results, [m.code]: v })}
                    />
                    {v === 'NEGATIVE' ? t('Negative') : t('Reactive')}
                  </label>
                ))}
              </span>
            </div>
          ))}
          <TextField
            label={t('Laboratory reference')}
            hint={t('Optional: the screening laboratory’s sample or report number')}
            maxLength={60}
            value={labReference}
            onChange={(e) => setLabReference(e.target.value)}
          />
          {reactive && (
            <Alert tone="danger" title={t('A reactive result discards the unit')}>
              {t('The donor will be permanently deferred and referred for counselling.')}
            </Alert>
          )}
          <ErrorAlert error={save.error} />
          <div className="form-actions">
            <Button variant="secondary" onClick={onClose}>
              {t('Cancel')}
            </Button>
            <Button type="submit" loading={save.isPending} disabled={!complete}>
              {t('Save results')}
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

function ReactionDialog({ donationId, onClose }: { donationId: string; onClose: () => void }) {
  const [text, setText] = useState('');
  const save = useDonorsAction<{ description: string }>(
    () => `/donations/${donationId}/adverse-reaction`,
  );
  return (
    <Dialog open onClose={onClose} title={t('Reaction after donation')}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate({ description: text.trim() }, { onSuccess: onClose });
        }}
      >
        <TextAreaField
          label={t('What happened?')}
          hint={t('For example fainting, a haematoma or nausea. It cannot be changed later.')}
          required
          minLength={3}
          maxLength={300}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <ErrorAlert error={save.error} />
        <div className="form-actions">
          <Button variant="secondary" onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button type="submit" loading={save.isPending}>
            {t('Save')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function DeferDialog({ detail, onClose }: { detail: DonorDetail; onClose: () => void }) {
  const deferred = detail.donor.status !== 'ACTIVE';
  const [mode, setMode] = useState<'defer' | 'permanent' | 'lift'>(deferred ? 'lift' : 'defer');
  const [days, setDays] = useState('30');
  const [reason, setReason] = useState('');
  const [consent, setConsent] = useState(detail.donor.contactConsent);
  const save = useDonorsAction<Record<string, unknown>>(
    () => `/donors/${detail.donor.id}`,
    'PATCH',
  );
  return (
    <Dialog open onClose={onClose} title={t('Deferral and contact')}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate(
            {
              contactConsent: consent,
              ...(mode === 'lift'
                ? deferred
                  ? { lift: { reason: reason.trim() } }
                  : {}
                : {
                    defer: {
                      reason: reason.trim(),
                      ...(mode === 'permanent' ? { permanent: true } : { days: Number(days) }),
                    },
                  }),
            },
            { onSuccess: onClose },
          );
        }}
      >
        <SelectField
          label={t('Change')}
          value={mode}
          onChange={(e) => setMode(e.target.value as typeof mode)}
          options={[
            { value: 'defer', label: t('Temporary deferral') },
            { value: 'permanent', label: t('Permanent deferral') },
            ...(deferred ? [{ value: 'lift', label: t('Lift the deferral') }] : []),
            ...(!deferred ? [{ value: 'lift', label: t('Only change contact consent') }] : []),
          ]}
        />
        {mode === 'defer' && (
          <TextField
            label={t('Days')}
            inputMode="numeric"
            required
            value={days}
            onChange={(e) => setDays(e.target.value)}
          />
        )}
        {(mode !== 'lift' || deferred) && (
          <TextAreaField
            label={t('Reason')}
            hint={
              mode === 'lift' && detail.donor.status === 'PERMANENTLY_DEFERRED'
                ? t('Only a blood bank doctor can lift a permanent deferral.')
                : t('Visible to blood bank staff only.')
            }
            required
            minLength={mode === 'lift' ? 10 : 5}
            maxLength={300}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        )}
        <label className="checkbox">
          <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
          {t('Agrees to be contacted when their blood group is needed')}
        </label>
        <ErrorAlert error={save.error} />
        <div className="form-actions">
          <Button variant="secondary" onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button type="submit" loading={save.isPending}>
            {t('Save')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ worklists ------------ */

function VisitList({
  items,
  onOpen,
  caption,
  showOutcome = true,
}: {
  items: WorklistItem[];
  onOpen: (id: string) => void;
  caption: string;
  showOutcome?: boolean;
}) {
  return (
    <Table caption={caption}>
      <thead>
        <tr>
          <th>{t('Time')}</th>
          <th>{t('Donor')}</th>
          <th>{t('Blood group')}</th>
          {showOutcome && <th>{t('Outcome')}</th>}
          <th className="num">{t('Volume (ml)')}</th>
          <th>{t('Testing')}</th>
        </tr>
      </thead>
      <tbody>
        {items.map((v) => (
          <tr key={v.id}>
            <td>{showOutcome ? formatTime(v.attendedAt) : formatDateTime(v.attendedAt)}</td>
            <td>
              <button type="button" className="link-button" onClick={() => onOpen(v.donorId)}>
                {v.firstName} {v.lastName}
              </button>
              <div className="muted small">{v.nationalId}</div>
            </td>
            <td>{donorGroup(v.abo, v.rhD)}</td>
            {showOutcome && <td>{outcomeLabel(v.outcome)}</td>}
            <td className="num">{v.volumeMl ?? '—'}</td>
            <td>
              {v.outcome !== 'COMPLETED' ? (
                '—'
              ) : v.bloodUnitId ? (
                t('Tested')
              ) : (
                <Badge tone="warning">{t('Awaiting tests')}</Badge>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

function TodayTab({ onOpen }: { onOpen: (id: string) => void }) {
  const list = useWorklist('today');
  return (
    <Card title={t('Today’s donor visits')}>
      <QueryView query={list}>
        {(items) => {
          const completed = items.filter((v) => v.outcome === 'COMPLETED').length;
          return items.length === 0 ? (
            <EmptyState title={t('No donor visits today')} />
          ) : (
            <>
              <Grid min={160}>
                <Stat label={t('Visits')} value={items.length} />
                <Stat label={t('Donations')} value={completed} tone="success" />
                <Stat
                  label={t('Deferred|donor visits')}
                  value={items.filter((v) => v.outcome === 'DEFERRED').length}
                />
              </Grid>
              <VisitList items={items} onOpen={onOpen} caption={t('Today’s donor visits')} />
            </>
          );
        }}
      </QueryView>
    </Card>
  );
}

function TestingTab({ onOpen }: { onOpen: (id: string) => void }) {
  const list = useWorklist('testing-queue');
  return (
    <Card title={t('Testing queue')}>
      <p className="muted">
        {t(
          'Collected blood waits here until its mandatory tests are recorded. Untested blood is never in stock.',
        )}
      </p>
      <QueryView query={list}>
        {(items) =>
          items.length === 0 ? (
            <EmptyState title={t('No donations waiting for tests')} />
          ) : (
            <VisitList
              items={items}
              onOpen={onOpen}
              caption={t('Testing queue')}
              showOutcome={false}
            />
          )
        }
      </QueryView>
    </Card>
  );
}

function DeferralsTab({ onOpen }: { onOpen: (id: string) => void }) {
  const list = useWorklist('deferrals');
  return (
    <Card title={t('Deferred donors')}>
      <QueryView query={list}>
        {(items) =>
          items.length === 0 ? (
            <EmptyState title={t('No deferred donors')} />
          ) : (
            <DonorTable
              items={items.map((d) => ({
                ...d,
                deferralReason: d.deferralReason
                  ? d.deferralReason
                      .split('; ')
                      .map((c) => reasonLabel(c))
                      .join(', ')
                  : null,
              }))}
              onOpen={onOpen}
              showReason
            />
          )
        }
      </QueryView>
    </Card>
  );
}

/* ------------------------------------------------------------------ appeals -------------- */

function AppealsTab() {
  const defs = useDonorDefinitions();
  const [abo, setAbo] = useState<Abo>('O');
  const [rhD, setRhD] = useState<'' | RhD>('NEG');
  const appeal = useDonorsAction<{ abo: Abo; rhD: RhD | null }, AppealResult>(() => '/appeals');
  return (
    <Card title={t('Appeal to donors')}>
      <p className="muted">
        {t(
          'Sends a notification to donors of the group who agreed to be contacted, can donate today and were not asked in the last {days} days.',
          { days: defs.data?.appealIntervalDays ?? 28 },
        )}
      </p>
      <form
        className="search-bar"
        onSubmit={(e) => {
          e.preventDefault();
          appeal.mutate({ abo, rhD: rhD || null });
        }}
      >
        <SelectField
          label={t('ABO group')}
          value={abo}
          onChange={(e) => setAbo(e.target.value as Abo)}
          options={(['O', 'A', 'B', 'AB'] as const).map((g) => ({ value: g, label: g }))}
        />
        <SelectField
          label={t('RhD')}
          value={rhD}
          onChange={(e) => setRhD(e.target.value as '' | RhD)}
          options={[
            { value: 'NEG', label: t('RhD negative') },
            { value: 'POS', label: t('RhD positive') },
            { value: '', label: t('Any RhD') },
          ]}
        />
        <Button type="submit" loading={appeal.isPending}>
          {t('Send appeal')}
        </Button>
      </form>
      <ErrorAlert error={appeal.error} />
      {appeal.data && (
        <Alert
          tone={appeal.data.sent ? 'success' : 'info'}
          title={tn(appeal.data.sent, '{count} donor asked', '{count} donors asked')}
        >
          <ul>
            <li>{t('Asked recently: {n}', { n: appeal.data.recentlyAsked })}</li>
            <li>{t('Cannot donate yet: {n}', { n: appeal.data.notEligible })}</li>
            <li>{t('Without a portal account: {n}', { n: appeal.data.noPortal })}</li>
          </ul>
        </Alert>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------------ statistics ----------- */

function StatsTab() {
  const stats = useDonorStats();
  return (
    <QueryView query={stats}>
      {(s) => {
        const totals = s.months.reduce(
          (a, m) => ({
            completed: a.completed + m.completed,
            deferred: a.deferred + m.deferred,
            aborted: a.aborted + m.aborted,
          }),
          { completed: 0, deferred: 0, aborted: 0 },
        );
        const visits = totals.completed + totals.deferred + totals.aborted;
        const merged = new Map<string, number | null>();
        for (const r of s.deferralReasons) {
          const label = reasonLabel(r.code);
          const prev = merged.get(label);
          merged.set(
            label,
            prev === undefined
              ? r.count
              : prev === null || r.count === null
                ? null
                : prev + r.count,
          );
        }
        return (
          <div className="stack">
            <Card
              title={
                s.scope === 'NATIONAL'
                  ? t('Blood donation in Kosovo – last 12 months')
                  : t('Blood donation at this facility – last 12 months')
              }
            >
              <Grid min={170}>
                <Stat label={t('Donations')} value={totals.completed} tone="success" />
                <Stat
                  label={t('Deferral rate')}
                  value={visits ? `${Math.round((totals.deferred / visits) * 100)} %` : '—'}
                />
                <Stat label={t('Donors')} value={s.donors} />
                <Stat
                  label={t('Repeat donors')}
                  value={s.repeatPercent === null ? '—' : `${s.repeatPercent} %`}
                  hint={t('gave blood before the last 12 months too')}
                />
              </Grid>
              {s.months.length > 0 ? (
                <StackedBars
                  title={t('Visits per month')}
                  series={[
                    { key: 'completed', label: t('Donation completed') },
                    { key: 'deferred', label: t('Deferred|donation visit') },
                    { key: 'aborted', label: t('Collection stopped') },
                  ]}
                  rows={s.months.map((m) => ({
                    label: formatMonth(m.month),
                    values: { completed: m.completed, deferred: m.deferred, aborted: m.aborted },
                  }))}
                />
              ) : (
                <EmptyState title={t('No donor visits in the last 12 months')} />
              )}
            </Card>
            <Grid min={300}>
              <Card title={t('Deferral reasons')}>
                {merged.size === 0 ? (
                  <EmptyState title={t('No deferrals')} />
                ) : (
                  <RankedBars
                    label={t('Deferral reasons')}
                    rows={[...merged].map(([label, value]) => ({
                      key: label,
                      label,
                      value,
                      suppressed: value === null,
                    }))}
                  />
                )}
                <p className="muted small">
                  {t('Counts below {n} are hidden to protect donors.', {
                    n: s.smallCellThreshold,
                  })}
                </p>
              </Card>
              <Card title={t('Units released to stock')}>
                {s.unitsReleased.length === 0 ? (
                  <EmptyState title={t('No units released')} />
                ) : (
                  <RankedBars
                    label={t('Units released to stock')}
                    rows={s.unitsReleased.map((u) => ({
                      key: u.group,
                      label: u.group,
                      value: u.count,
                    }))}
                  />
                )}
              </Card>
            </Grid>
          </div>
        );
      }}
    </QueryView>
  );
}
