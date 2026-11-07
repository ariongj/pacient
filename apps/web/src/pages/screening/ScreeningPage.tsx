import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  PROGRAMME_CODES,
  programmeAudience,
  programmeLabel,
  STATE_TONE,
  stateLabel,
  testLabel,
  useScreeningCoverage,
  useScreeningWorklist,
  type CoverageRow,
  type ProgrammeCode,
} from '../../api/screening';
import { useUser } from '../../auth/AuthContext';
import {
  Badge,
  Card,
  EmptyState,
  Grid,
  PageHeader,
  Pagination,
  QueryView,
  SelectField,
  Stat,
  Table,
  TextField,
} from '../../components/ui';
import { formatDate, formatNumber, fullName } from '../../format';
import { t } from '../../i18n';

const programmeOptions = () => [
  { value: '', label: t('All programmes') },
  ...PROGRAMME_CODES.map((p) => ({ value: p, label: programmeLabel(p) })),
];

/* -------------------------------------------------------------------------- worklist -- */

function Worklist() {
  const user = useUser();
  const [view, setView] = useState<'all' | 'due' | 'followup'>('all');
  const [programme, setProgramme] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const list = useScreeningWorklist({
    view,
    programme: (programme || undefined) as ProgrammeCode | undefined,
    q: q || undefined,
    page,
  });
  const chartBase = user.role === 'NURSE' ? '/nurse/patients' : '/doctor/patients';
  const reset = () => setPage(1);

  return (
    <>
      <Card>
        <div className="form-grid">
          <SelectField
            label={t('Show')}
            value={view}
            onChange={(e) => {
              setView(e.currentTarget.value as typeof view);
              reset();
            }}
            options={[
              { value: 'all', label: t('Due and under follow-up') },
              { value: 'due', label: t('Due for screening') },
              { value: 'followup', label: t('Abnormal results under follow-up') },
            ]}
          />
          <SelectField
            label={t('Programme|screening')}
            value={programme}
            onChange={(e) => {
              setProgramme(e.currentTarget.value);
              reset();
            }}
            options={programmeOptions()}
          />
          <TextField
            label={t('Search patient')}
            placeholder={t('Name or national ID')}
            value={q}
            onChange={(e) => {
              setQ(e.currentTarget.value);
              reset();
            }}
          />
        </div>
      </Card>
      <QueryView query={list}>
        {(data) => (
          <div className="stack">
            <Grid min={180}>
              <Stat label={t('Patients in my care')} value={formatNumber(data.counts.inCare)} />
              <Stat label={t('Due for screening')} value={formatNumber(data.counts.due)} />
              <Stat
                label={t('Under follow-up|screening')}
                value={formatNumber(data.counts.followUp)}
                tone={data.counts.followUp ? 'warning' : undefined}
              />
              <Stat
                label={t('Follow-up without a referral after 14 days')}
                value={formatNumber(data.counts.followUpOverdue)}
                tone={data.counts.followUpOverdue ? 'danger' : undefined}
              />
            </Grid>
            <Card>
              {data.items.length === 0 ? (
                <EmptyState title={t('Nobody to call for screening')}>
                  {t(
                    'Patients in your care who are due for screening or whose abnormal result is being followed up appear here.',
                  )}
                </EmptyState>
              ) : (
                <Table caption={t('Screening worklist')}>
                  <thead>
                    <tr>
                      <th>{t('Patient')}</th>
                      <th>{t('Programme|screening')}</th>
                      <th>{t('Status')}</th>
                      <th>{t('Contact')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.items.map((item) =>
                      item.programmes.map((p, i) => (
                        <tr key={`${item.patient.id}-${p.programme}`}>
                          {i === 0 && (
                            <td rowSpan={item.programmes.length}>
                              <Link to={`${chartBase}/${item.patient.id}?tab=screening`}>
                                {fullName(item.patient)}
                              </Link>
                              <div className="muted mono">{item.patient.nationalId}</div>
                              <div className="muted">{formatDate(item.patient.dateOfBirth)}</div>
                            </td>
                          )}
                          <td>
                            {programmeLabel(p.programme)}
                            <div className="muted">{testLabel(p.testOffered)}</div>
                          </td>
                          <td>
                            <Badge tone={STATE_TONE[p.state]}>{stateLabel(p.state)}</Badge>
                            {p.followUpOverdue && (
                              <div>
                                <Badge tone="danger">{t('No referral after 14 days')}</Badge>
                              </div>
                            )}
                            {p.invitationOverdue && (
                              <div>
                                <Badge tone="warning">{t('Invitation not taken up')}</Badge>
                              </div>
                            )}
                            {p.state === 'DUE' && (
                              <div className="muted">
                                {p.lastScreenedAt
                                  ? t('Last test {date}', { date: formatDate(p.lastScreenedAt) })
                                  : t('Never screened')}
                              </div>
                            )}
                          </td>
                          {i === 0 && (
                            <td rowSpan={item.programmes.length}>
                              {item.patient.phone ?? <span className="muted">—</span>}
                            </td>
                          )}
                        </tr>
                      )),
                    )}
                  </tbody>
                </Table>
              )}
              <Pagination page={data.page} totalPages={data.totalPages} onChange={setPage} />
            </Card>
          </div>
        )}
      </QueryView>
    </>
  );
}

/* -------------------------------------------------------------------------- coverage -- */

const count = (n: number | null) =>
  n === null ? <span className="muted">{t('suppressed')}</span> : formatNumber(n);
const percent = (n: number | null) => (n === null ? '—' : `${formatNumber(n)} %`);
/** A count followed by its percentage, when there is one. */
const withPct = (n: number | null, pct: number | null) => (
  <>
    {count(n)}
    {pct !== null && (
      <>
        {' '}
        <strong>({percent(pct)})</strong>
      </>
    )}
  </>
);

function CoverageCard({ row }: { row: CoverageRow }) {
  return (
    <Card title={programmeLabel(row.programme)}>
      <p className="muted">{programmeAudience(row.programme)}</p>
      <Table caption={t('Coverage of {programme}', { programme: programmeLabel(row.programme) })}>
        <tbody>
          <tr>
            <th scope="row">{t('People in the age group')}</th>
            <td>{count(row.population)}</td>
          </tr>
          <tr>
            <th scope="row">{t('Screened within the interval')}</th>
            <td>{withPct(row.screenedInInterval, row.coveragePct)}</td>
          </tr>
          <tr>
            <th scope="row">{t('Opted out|screening')}</th>
            <td>{count(row.optedOut)}</td>
          </tr>
          <tr>
            <th scope="row">{t('Invitations in the last 12 months')}</th>
            <td>{count(row.invited12m)}</td>
          </tr>
          <tr>
            <th scope="row">{t('Uptake of invitations')}</th>
            <td>{withPct(row.tookUp12m, row.uptakePct)}</td>
          </tr>
          <tr>
            <th scope="row">{t('Abnormal results (last 12 months)')}</th>
            <td>
              {row.resulted12m === 0 ? (
                t('No results yet')
              ) : (
                <>
                  {withPct(row.abnormal12m, row.abnormalPct)}{' '}
                  <span className="muted">
                    {t('of {count} results', {
                      count:
                        row.resulted12m === null ? t('suppressed') : formatNumber(row.resulted12m),
                    })}
                  </span>
                </>
              )}
            </td>
          </tr>
          <tr>
            <th scope="row">{t('Follow-up without a referral after 14 days')}</th>
            <td>{count(row.followUpOverdue)}</td>
          </tr>
        </tbody>
      </Table>
    </Card>
  );
}

function CoverageView({ national }: { national: boolean }) {
  const [groupBy, setGroupBy] = useState<'NONE' | 'MUNICIPALITY'>(
    national ? 'MUNICIPALITY' : 'NONE',
  );
  const query = useScreeningCoverage({ groupBy: national ? groupBy : undefined });
  return (
    <>
      {national && (
        <Card>
          <div className="form-grid">
            <SelectField
              label={t('Group by')}
              value={groupBy}
              onChange={(e) => setGroupBy(e.currentTarget.value as typeof groupBy)}
              options={[
                { value: 'MUNICIPALITY', label: t('Municipality') },
                { value: 'NONE', label: t('National total only') },
              ]}
            />
          </div>
        </Card>
      )}
      <QueryView query={query}>
        {(data) => (
          <div className="stack">
            <p className="muted">
              {t('As of {date}. Counts below {threshold} are not shown to protect privacy.', {
                date: formatDate(data.asOf),
                threshold: data.threshold,
              })}{' '}
              {t(
                'Age ranges, intervals and tests are illustrative until confirmed by the national cancer control programme.',
              )}
            </p>
            <Grid min={320}>
              {data.total.map((row) => (
                <CoverageCard key={row.programme} row={row} />
              ))}
            </Grid>
            {national && data.rows.length > 0 && (
              <Card title={t('By municipality')}>
                <Table caption={t('Screening coverage by municipality')}>
                  <thead>
                    <tr>
                      <th>{t('Municipality')}</th>
                      <th>{t('Programme|screening')}</th>
                      <th>{t('People in the age group')}</th>
                      <th>{t('Coverage|screening')}</th>
                      <th>{t('Uptake of invitations')}</th>
                      <th>{t('Abnormal results|screening')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.rows.map((r) => (
                      <tr key={`${r.group}-${r.programme}`}>
                        <td>{r.group ?? t('Unknown')}</td>
                        <td>{programmeLabel(r.programme)}</td>
                        <td>{count(r.population)}</td>
                        <td>{percent(r.coveragePct)}</td>
                        <td>{percent(r.uptakePct)}</td>
                        <td>{percent(r.abnormalPct)}</td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </Card>
            )}
          </div>
        )}
      </QueryView>
    </>
  );
}

/**
 * Cancer screening: the worklist of the doctor's and nurse's own patients (due, invitations not
 * taken up, abnormal results under follow-up), coverage for the director (own facility) and the
 * Ministry (national, by municipality). Management views show counts only.
 */
export function ScreeningPage() {
  const user = useUser();
  const clinical = user.role === 'DOCTOR' || user.role === 'NURSE';
  return (
    <>
      <PageHeader
        title={t('Cancer screening')}
        subtitle={
          clinical
            ? t('Patients in your care who are due for screening or under follow-up.')
            : user.role === 'DIRECTOR'
              ? t('Screening coverage at {facility} – counts only, no names.', {
                  facility: user.facility?.name ?? '',
                })
              : t('National screening coverage – counts only, no names.')
        }
      />
      {clinical ? <Worklist /> : <CoverageView national={user.role === 'MINISTRY'} />}
    </>
  );
}
