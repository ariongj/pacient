import { useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  APPROVAL_STATUS,
  HAI_STATUS,
  haiTypeLabel,
  precautionLabel,
  PRECAUTIONS,
  reviewOutcomeLabel,
  useDecideApproval,
  useHaiList,
  useInfectionDefinitions,
  useIsolations,
  useReviewHai,
  useStewardship,
  useStewardshipStats,
  useSuggestions,
  useSurveillance,
  type Approval,
  type FacilitySurveillance,
  type NationalSurveillance,
} from '../../api/infection';
import { useUser } from '../../auth/AuthContext';
import { LineChart, RankedBars } from '../../components/charts';
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
} from '../../components/ui';
import { formatDateTime, formatMonth, formatNumber, fullName } from '../../format';
import { t } from '../../i18n';
import { IsolationBadge } from './IsolationBadge';

type TabId = 'ward' | 'stewardship' | 'surveillance' | 'indicators';

const rateText = (r: number | null) => (r === null ? '—' : formatNumber(r));

/**
 * Infection prevention: isolated patients by ward, the antimicrobial stewardship queue, HAI
 * surveillance (reported infections, culture-based suggestions and rates) and stewardship
 * indicators – the tabs depend on the role and on membership of the infection control team.
 */
export function InfectionPage() {
  const user = useUser();
  const defs = useInfectionDefinitions();
  const [params, setParams] = useSearchParams();
  const ic = defs.data?.me.infectionControl ?? false;
  const team = defs.data?.me.stewardship ?? false;
  const tabs: { id: TabId; label: string }[] = [];
  if (user.role === 'DOCTOR' || user.role === 'NURSE' || user.role === 'DIRECTOR') {
    tabs.push({ id: 'ward', label: t('Isolated patients') });
  }
  if (user.role === 'DOCTOR' || team)
    tabs.push({ id: 'stewardship', label: t('Restricted antibiotics') });
  if (ic || user.role === 'DIRECTOR' || user.role === 'MINISTRY') {
    tabs.push({ id: 'surveillance', label: t('Infection surveillance') });
  }
  if (team || user.role === 'DIRECTOR' || user.role === 'MINISTRY') {
    tabs.push({ id: 'indicators', label: t('Stewardship indicators') });
  }
  const requested = params.get('tab') as TabId | null;
  const tab: TabId = tabs.find((x) => x.id === requested)?.id ?? tabs[0]?.id ?? 'ward';
  return (
    <>
      <PageHeader
        title={t('Infection prevention')}
        subtitle={
          user.role === 'MINISTRY'
            ? t(
                'National healthcare-associated infection rates and antibiotic stewardship (small numbers hidden).',
              )
            : t(
                'Isolation precautions, healthcare-associated infections and restricted antibiotics.',
              )
        }
      />
      {defs.isPending ? null : tabs.length === 0 ? (
        <EmptyState title={t('Nothing to show')} />
      ) : (
        <>
          <Tabs
            label={t('Infection prevention')}
            active={tab}
            onChange={(id) => setParams({ tab: id }, { replace: true })}
            tabs={tabs}
          />
          <TabPanel id={tab}>
            {tab === 'ward' && <WardTab />}
            {tab === 'stewardship' && <StewardshipTab />}
            {tab === 'surveillance' && <SurveillanceTab infectionControl={ic} />}
            {tab === 'indicators' && <IndicatorsTab />}
          </TabPanel>
          {defs.data && <p className="muted">{t(defs.data.disclaimer)}</p>}
        </>
      )}
    </>
  );
}

function patientBase(role: string) {
  return role === 'NURSE' ? '/nurse/patients' : '/doctor/patients';
}

function WardTab() {
  const user = useUser();
  const query = useIsolations();
  return (
    <QueryView query={query}>
      {(d) =>
        d.scope === 'counts' ? (
          <Card title={t('Isolated patients by ward')}>
            {d.units.length ? (
              <Table caption={t('Isolated patients by ward')}>
                <thead>
                  <tr>
                    <th>{t('Ward')}</th>
                    {PRECAUTIONS.map((p) => (
                      <th key={p} className="num">
                        {precautionLabel(p)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {d.units.map((u) => (
                    <tr key={u.unit}>
                      <td>{u.unit === '—' ? t('Not admitted') : u.unit}</td>
                      {PRECAUTIONS.map((p) => (
                        <td key={p} className="num">
                          {formatNumber(u.byPrecaution[p] ?? 0)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </Table>
            ) : (
              <EmptyState title={t('No patients in isolation')} />
            )}
          </Card>
        ) : (
          <Card title={t('Isolated patients')}>
            {d.items.length ? (
              <Table caption={t('Isolated patients')}>
                <thead>
                  <tr>
                    <th>{t('Patient')}</th>
                    <th>{t('Ward and bed')}</th>
                    <th>{t('Precautions')}</th>
                    <th>{t('Since')}</th>
                  </tr>
                </thead>
                <tbody>
                  {d.items.map((i) => (
                    <tr key={i.id}>
                      <td>
                        <Link to={`${patientBase(user.role)}/${i.patientId}?tab=infection`}>
                          {fullName(i)}
                        </Link>
                      </td>
                      <td>
                        {i.unitName
                          ? `${i.unitName}${i.bed ? ` · ${i.bed}` : ''}`
                          : t('Not admitted')}
                      </td>
                      <td>
                        <IsolationBadge precaution={i.precaution} reason={i.reason} />
                      </td>
                      <td>{formatDateTime(i.startedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            ) : (
              <EmptyState title={t('No patients in isolation')}>
                {t(
                  'You see patients on your wards and in your care; the infection control team sees the whole facility.',
                )}
              </EmptyState>
            )}
          </Card>
        )
      }
    </QueryView>
  );
}

function ApprovalTable({
  items,
  caption,
  team,
  onDecide,
}: {
  items: Approval[];
  caption: string;
  team: boolean;
  onDecide?: (a: Approval) => void;
}) {
  const user = useUser();
  return (
    <Table caption={caption}>
      <thead>
        <tr>
          <th>{t('Patient')}</th>
          <th>{t('Medicine')}</th>
          <th>{t('Indication')}</th>
          <th>{t('Approval')}</th>
          <th>{t('72-hour review')}</th>
          {team && <th>{t('Action')}</th>}
        </tr>
      </thead>
      <tbody>
        {items.map((a) => (
          <tr key={a.id}>
            <td>
              {user.role === 'PHARMACIST' ? (
                fullName(a)
              ) : (
                <Link to={`${patientBase(user.role)}/${a.patientId}?tab=infection`}>
                  {fullName(a)}
                </Link>
              )}
              <div className="muted">{a.requestedBy}</div>
            </td>
            <td>
              {a.medication}
              <div className="muted">
                {a.dosage} · {a.frequency} · {a.route}
              </div>
            </td>
            <td>
              {a.indication}
              <div className="muted">{a.justification}</div>
            </td>
            <td>
              <Badge tone={APPROVAL_STATUS[a.status].tone}>
                {t(APPROVAL_STATUS[a.status].label)}
              </Badge>
              {a.decidedBy && <div className="muted">{a.decidedBy}</div>}
            </td>
            <td>
              {a.reviewOutcome ? (
                reviewOutcomeLabel(a.reviewOutcome)
              ) : a.reviewOverdue ? (
                <Badge tone="danger">{t('Review overdue')}</Badge>
              ) : a.reviewDueAt && a.reviewNeeded ? (
                t('Due {date}', { date: formatDateTime(a.reviewDueAt) })
              ) : (
                '—'
              )}
            </td>
            {team && (
              <td>
                {a.status === 'REQUESTED' && !a.mine && onDecide && (
                  <Button size="sm" onClick={() => onDecide(a)}>
                    {t('Decide')}
                  </Button>
                )}
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

function StewardshipTab() {
  const query = useStewardship(true);
  const decide = useDecideApproval();
  const [deciding, setDeciding] = useState<Approval | null>(null);
  const [decision, setDecision] = useState<'APPROVED' | 'DECLINED'>('APPROVED');
  const [note, setNote] = useState('');
  return (
    <QueryView query={query}>
      {(d) => {
        const team = d.scope === 'team';
        return (
          <div className="stack">
            {team && (
              <Grid>
                <Stat
                  label={t('Awaiting approval')}
                  value={d.awaitingDecision.length}
                  tone={d.awaitingDecision.length ? 'warning' : 'success'}
                />
                <Stat
                  label={t('Reviews overdue')}
                  value={d.reviewsOverdue.length}
                  tone={d.reviewsOverdue.length ? 'danger' : 'success'}
                />
              </Grid>
            )}
            <Card title={team ? t('Awaiting approval') : t('My restricted antibiotic requests')}>
              {(team
                ? d.awaitingDecision
                : [...d.awaitingDecision, ...d.reviewsOverdue, ...d.recent]
              ).length ? (
                <ApprovalTable
                  items={
                    team
                      ? d.awaitingDecision
                      : [...d.awaitingDecision, ...d.reviewsOverdue, ...d.recent]
                  }
                  caption={team ? t('Awaiting approval') : t('My restricted antibiotic requests')}
                  team={team}
                  onDecide={(a) => {
                    setDeciding(a);
                    setDecision('APPROVED');
                    setNote('');
                  }}
                />
              ) : (
                <EmptyState title={t('No requests')} />
              )}
            </Card>
            {team && (
              <>
                <Card title={t('Reviews overdue')}>
                  {d.reviewsOverdue.length ? (
                    <ApprovalTable
                      items={d.reviewsOverdue}
                      caption={t('Reviews overdue')}
                      team={team}
                    />
                  ) : (
                    <EmptyState title={t('No overdue reviews')} />
                  )}
                </Card>
                {d.recent.length > 0 && (
                  <Card title={t('Recently decided')}>
                    <ApprovalTable items={d.recent} caption={t('Recently decided')} team={team} />
                  </Card>
                )}
              </>
            )}
            <Dialog
              open={deciding !== null}
              onClose={() => setDeciding(null)}
              title={t('Restricted antibiotic request')}
            >
              <form
                onSubmit={(e: FormEvent) => {
                  e.preventDefault();
                  if (!deciding) return;
                  decide.mutate(
                    { id: deciding.id, decision, note: note || undefined },
                    { onSuccess: () => setDeciding(null) },
                  );
                }}
              >
                <p>
                  <strong>{deciding?.medication}</strong> · {deciding?.indication}
                </p>
                <p className="muted">{deciding?.justification}</p>
                <SelectField
                  label={t('Decision')}
                  name="decision"
                  value={decision}
                  onChange={(e) => setDecision(e.target.value as 'APPROVED' | 'DECLINED')}
                  options={[
                    { value: 'APPROVED', label: t('Approve') },
                    { value: 'DECLINED', label: t('Decline') },
                  ]}
                />
                <TextAreaField
                  label={t('Note to the prescriber')}
                  name="note"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  maxLength={500}
                  rows={2}
                  required={decision === 'DECLINED'}
                  minLength={decision === 'DECLINED' ? 10 : undefined}
                  hint={
                    decision === 'DECLINED'
                      ? t('Suggest the alternative (at least 10 characters).')
                      : undefined
                  }
                />
                <ErrorAlert error={decide.error} />
                <div className="form-actions">
                  <Button variant="secondary" onClick={() => setDeciding(null)}>
                    {t('Cancel')}
                  </Button>
                  <Button type="submit" loading={decide.isPending}>
                    {t('Save')}
                  </Button>
                </div>
              </form>
            </Dialog>
          </div>
        );
      }}
    </QueryView>
  );
}

function SurveillanceTab({ infectionControl }: { infectionControl: boolean }) {
  const [months, setMonths] = useState(12);
  const rates = useSurveillance(months);
  return (
    <div className="stack">
      <SelectField
        label={t('Period')}
        name="months"
        value={String(months)}
        onChange={(e) => setMonths(Number(e.target.value))}
        options={[3, 6, 12, 24].map((m) => ({
          value: String(m),
          label: t('Last {count} months', { count: m }),
        }))}
      />
      <QueryView query={rates}>
        {(d) => (d.scope === 'national' ? <NationalRates data={d} /> : <FacilityRates data={d} />)}
      </QueryView>
      {infectionControl && <TeamLists />}
    </div>
  );
}

function FacilityRates({ data }: { data: FacilitySurveillance }) {
  const totalDays = data.units.reduce((a, u) => a + u.patientDays, 0);
  const totalConfirmed = data.units.reduce((a, u) => a + u.confirmed, 0);
  return (
    <>
      <Grid>
        <Stat label={t('Patient-days')} value={formatNumber(totalDays)} />
        <Stat label={t('Confirmed infections')} value={formatNumber(totalConfirmed)} />
        <Stat
          label={t('Infections per 1,000 patient-days')}
          value={
            totalDays ? formatNumber(Math.round((totalConfirmed / totalDays) * 10_000) / 10) : '—'
          }
        />
      </Grid>
      <Card title={t('Infections per 1,000 patient-days by month')}>
        <LineChart
          title={t('Infections per 1,000 patient-days by month')}
          data={data.trend.map((m) => ({
            label: formatMonth(m.month),
            value: m.rate ?? 0,
          }))}
        />
      </Card>
      <Card title={t('By ward')}>
        <Table caption={t('By ward')}>
          <thead>
            <tr>
              <th>{t('Ward')}</th>
              <th className="num">{t('Patient-days')}</th>
              <th className="num">{t('Confirmed infections')}</th>
              <th className="num">{t('Device-related')}</th>
              <th className="num">{t('Per 1,000 patient-days')}</th>
            </tr>
          </thead>
          <tbody>
            {data.units.map((u) => (
              <tr key={u.unit}>
                <td>{u.unit}</td>
                <td className="num">{formatNumber(u.patientDays)}</td>
                <td className="num">{formatNumber(u.confirmed)}</td>
                <td className="num">{formatNumber(u.deviceRelated)}</td>
                <td className="num">{rateText(u.rate)}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>
      <Card title={t('By type of infection')}>
        <Table caption={t('By type of infection')}>
          <thead>
            <tr>
              <th>{t('Infection')}</th>
              <th className="num">{t(HAI_STATUS.CONFIRMED.label)}</th>
              <th className="num">{t(HAI_STATUS.SUSPECTED.label)}</th>
              <th className="num">{t(HAI_STATUS.RULED_OUT.label)}</th>
            </tr>
          </thead>
          <tbody>
            {data.byType.map((b) => (
              <tr key={b.type}>
                <td>{haiTypeLabel(b.type)}</td>
                <td className="num">{formatNumber(b.confirmed)}</td>
                <td className="num">{formatNumber(b.suspected)}</td>
                <td className="num">{formatNumber(b.ruledOut)}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>
    </>
  );
}

function NationalRates({ data }: { data: NationalSurveillance }) {
  return (
    <>
      <Card title={t('Infections per 1,000 patient-days by month')}>
        <LineChart
          title={t('Infections per 1,000 patient-days by month')}
          data={data.trend.map((m) => ({
            label: formatMonth(m.month),
            value: m.rate ?? 0,
          }))}
        />
      </Card>
      <Card title={t('By facility')}>
        <RankedBars
          label={t('Infections per 1,000 patient-days by facility')}
          rows={data.facilities.map((f) => ({
            key: f.facility,
            label: f.facility,
            value: f.rate,
            suppressed: f.suppressed,
          }))}
        />
        <p className="muted">
          {t('Counts below {n} are hidden to protect privacy.', { n: data.threshold })}
        </p>
      </Card>
    </>
  );
}

function TeamLists() {
  const hai = useHaiList(true);
  const suggestions = useSuggestions(true);
  const review = useReviewHai();
  return (
    <>
      <Card title={t('Possible infections from culture results')}>
        <QueryView query={suggestions}>
          {(d) =>
            d.items.length ? (
              <Table caption={t('Possible infections from culture results')}>
                <thead>
                  <tr>
                    <th>{t('Patient')}</th>
                    <th>{t('Ward')}</th>
                    <th>{t('Culture')}</th>
                    <th>{t('Taken')}</th>
                  </tr>
                </thead>
                <tbody>
                  {d.items.map((s) => (
                    <tr key={s.labResultId}>
                      <td>
                        <Link to={`/doctor/patients/${s.patientId}?tab=infection`}>
                          {fullName(s)}
                        </Link>
                      </td>
                      <td>{s.unitName}</td>
                      <td>
                        {s.testName}: {s.value}
                      </td>
                      <td>
                        {formatDateTime(s.collectedAt)}
                        <div className="muted">
                          {t('{count} hours after admission', { count: s.hoursAfterAdmission })}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            ) : (
              <EmptyState title={t('No positive cultures to review')} />
            )
          }
        </QueryView>
        <p className="muted">
          {t(
            'Positive cultures taken more than 48 hours after admission, without an infection recorded within 7 days.',
          )}
        </p>
      </Card>
      <Card title={t('Reported infections')}>
        <QueryView query={hai}>
          {(d) =>
            d.items.length ? (
              <Table caption={t('Reported infections')}>
                <thead>
                  <tr>
                    <th>{t('Patient')}</th>
                    <th>{t('Infection')}</th>
                    <th>{t('Onset')}</th>
                    <th>{t('Status')}</th>
                    <th>{t('Action')}</th>
                  </tr>
                </thead>
                <tbody>
                  {d.items.map((h) => (
                    <tr key={h.id}>
                      <td>
                        <Link to={`/doctor/patients/${h.patientId}?tab=infection`}>
                          {fullName(h)}
                        </Link>
                        <div className="muted">{h.unitName ?? '—'}</div>
                      </td>
                      <td>
                        {haiTypeLabel(h.type)}
                        {h.organism && <div className="muted">{h.organism}</div>}
                      </td>
                      <td>{formatDateTime(h.onsetAt)}</td>
                      <td>
                        <Badge tone={HAI_STATUS[h.status].tone}>
                          {t(HAI_STATUS[h.status].label)}
                        </Badge>
                      </td>
                      <td>
                        {h.status === 'SUSPECTED' && (
                          <div className="row" style={{ gap: '0.25rem' }}>
                            <Button
                              size="sm"
                              onClick={() => review.mutate({ id: h.id, status: 'CONFIRMED' })}
                            >
                              {t('Confirm')}
                            </Button>
                            <Button
                              size="sm"
                              variant="secondary"
                              onClick={() => review.mutate({ id: h.id, status: 'RULED_OUT' })}
                            >
                              {t('Rule out')}
                            </Button>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            ) : (
              <EmptyState title={t('No infections reported')} />
            )
          }
        </QueryView>
        <ErrorAlert error={review.error} />
      </Card>
    </>
  );
}

function IndicatorsTab() {
  const [months, setMonths] = useState(12);
  const query = useStewardshipStats(months, true);
  const pct = (n: number | null) => (n === null ? '—' : `${formatNumber(n)} %`);
  return (
    <div className="stack">
      <SelectField
        label={t('Period')}
        name="months"
        value={String(months)}
        onChange={(e) => setMonths(Number(e.target.value))}
        options={[3, 6, 12, 24].map((m) => ({
          value: String(m),
          label: t('Last {count} months', { count: m }),
        }))}
      />
      <QueryView query={query}>
        {(d) => (
          <Card title={t('Restricted antibiotics')}>
            {d.facilities.length ? (
              <Table caption={t('Restricted antibiotics')}>
                <thead>
                  <tr>
                    <th>{t('Facility')}</th>
                    <th className="num">{t('Starts')}</th>
                    <th className="num">{t('Per 1,000 patient-days')}</th>
                    <th className="num">{t('Approved')}</th>
                    <th className="num">{t('Reviewed on time')}</th>
                  </tr>
                </thead>
                <tbody>
                  {d.facilities.map((f) => (
                    <tr key={f.facility}>
                      <td>{f.facility}</td>
                      <td className="num">
                        {f.suppressed ? t('Too few to show') : formatNumber(f.starts ?? 0)}
                      </td>
                      <td className="num">{rateText(f.startsPer1000)}</td>
                      <td className="num">{pct(f.approvalRate)}</td>
                      <td className="num">{pct(f.reviewCompliance)}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            ) : (
              <EmptyState title={t('No restricted antibiotics in this period')} />
            )}
            <Alert tone="info">
              {t(
                'Every restricted antibiotic is reviewed 72 hours after the start; a review within a day of the due time counts as on time.',
              )}
            </Alert>
          </Card>
        )}
      </QueryView>
    </div>
  );
}
