import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  filterLabel,
  gestationLabel,
  useMaternityDashboard,
  useMaternityWorklist,
  WORKLIST_FILTERS,
  type IndicatorRow,
  type MaternityDashboard,
  type WorklistFilter,
} from '../../api/maternity';
import { useUser } from '../../auth/AuthContext';
import {
  Badge,
  Card,
  EmptyState,
  Grid,
  PageHeader,
  Pagination,
  QueryView,
  Stat,
  Table,
  Tabs,
  TextField,
} from '../../components/ui';
import { formatDate, formatNumber } from '../../format';
import { t } from '../../i18n';
import { AlertList } from '../doctor/chart/PregnancyTab';

const cell = (v: number | null) => (v === null ? t('Too few to show') : formatNumber(v));
const pct = (v: number | null) => (v === null ? '—' : `${formatNumber(v)} %`);

function Worklist() {
  const user = useUser();
  const [filter, setFilter] = useState<WorklistFilter>('ALL');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const query = useMaternityWorklist({ filter, q: q || undefined, page });
  const chartBase = user.role === 'NURSE' ? '/nurse/patients' : '/doctor/patients';
  const counts = query.data?.counts;
  return (
    <div className="stack">
      <Tabs
        label={t('Filter')}
        tabs={WORKLIST_FILTERS.map((f) => ({ id: f, label: filterLabel(f), count: counts?.[f] }))}
        active={filter}
        onChange={(f) => {
          setFilter(f);
          setPage(1);
        }}
        withPanels={false}
      />
      <TextField
        label={t('Search by name or personal number')}
        name="q"
        type="search"
        value={q}
        onChange={(e) => {
          setQ(e.currentTarget.value);
          setPage(1);
        }}
      />
      <QueryView query={query}>
        {(data) =>
          data.items.length === 0 ? (
            <EmptyState title={t('No pregnancies in this list')}>
              {t('The list shows ongoing pregnancies of patients in your care at this facility.')}
            </EmptyState>
          ) : (
            <>
              <Table caption={t('Ongoing pregnancies')}>
                <thead>
                  <tr>
                    <th>{t('Patient')}</th>
                    <th>{t('Weeks')}</th>
                    <th>{t('Due date')}</th>
                    <th>{t('Risk')}</th>
                    <th>{t('Last visit')}</th>
                    <th>{t('Next visit')}</th>
                    <th>{t('Attention')}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((i) => (
                    <tr key={i.id}>
                      <td>
                        <Link to={`${chartBase}/${i.patient.id}?tab=pregnancy`}>
                          {i.patient.lastName}, {i.patient.firstName}
                        </Link>
                        <div className="muted mono">{i.patient.nationalId}</div>
                      </td>
                      <td>{gestationLabel(i.gestation)}</td>
                      <td>{formatDate(i.eddDate)}</td>
                      <td>
                        {i.riskLevel === 'HIGH' ? (
                          <Badge tone="danger">{t('High risk')}</Badge>
                        ) : (
                          <Badge tone="success">{t('Low risk')}</Badge>
                        )}
                      </td>
                      <td>{formatDate(i.lastVisitAt)}</td>
                      <td>{formatDate(i.nextVisitDate)}</td>
                      <td>
                        <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: '0.25rem' }}>
                          {i.postTerm && <Badge tone="danger">{t('Past 42 weeks')}</Badge>}
                          {i.nearEdd && !i.postTerm && (
                            <Badge tone="info">{t('Due within 14 days')}</Badge>
                          )}
                          {i.overdueContact && (
                            <Badge tone="warning">{t('Overdue check-up')}</Badge>
                          )}
                          <AlertList alerts={i.alerts.filter((a) => a.severity !== 'INFO')} />
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
              <Pagination page={data.page} totalPages={data.totalPages} onChange={setPage} />
            </>
          )
        }
      </QueryView>
    </div>
  );
}

function IndicatorTable({ rows, caption }: { rows: IndicatorRow[]; caption: string }) {
  return (
    <Table caption={caption}>
      <thead>
        <tr>
          <th>{t('Municipality')}</th>
          <th className="num">{t('Booked')}</th>
          <th className="num">{t('Booked before 14 weeks')}</th>
          <th className="num">{t('High risk')}</th>
          <th className="num">{t('Deliveries')}</th>
          <th className="num">{t('4 or more visits')}</th>
          <th className="num">{t('8 or more visits')}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.municipality ?? '—'}>
            <td>{r.municipality ?? t('Not recorded')}</td>
            <td className="num">{cell(r.booked)}</td>
            <td className="num">{pct(r.firstTrimesterPct)}</td>
            <td className="num">{pct(r.highRiskPct)}</td>
            <td className="num">{cell(r.delivered)}</td>
            <td className="num">{pct(r.anc4Pct)}</td>
            <td className="num">{pct(r.anc8Pct)}</td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

function Dashboard({ data }: { data: MaternityDashboard }) {
  const o = data.ongoing;
  const ind = data.indicators;
  return (
    <div className="stack">
      <Card title={t('Ongoing pregnancies')}>
        <Grid min={170}>
          <Stat label={t('Ongoing')} value={cell(o.total)} />
          <Stat label={t('High risk')} value={cell(o.highRisk)} tone="danger" />
          <Stat label={t('Alerts at the last visit')} value={cell(o.alerts)} tone="warning" />
          <Stat label={t('Overdue check-up')} value={cell(o.overdueContact)} tone="warning" />
          <Stat label={t('Due within 14 days')} value={cell(o.nearEdd)} tone="info" />
          <Stat label={t('Past 42 weeks')} value={cell(o.postTerm)} tone="danger" />
        </Grid>
      </Card>
      {ind && (
        <Card title={t('Last 12 months')}>
          <Grid min={170}>
            <Stat label={t('Booked')} value={cell(ind.booked)} />
            <Stat label={t('Booked before 14 weeks')} value={pct(ind.firstTrimesterPct)} />
            <Stat label={t('High risk')} value={pct(ind.highRiskPct)} />
            <Stat label={t('Deliveries')} value={cell(ind.delivered)} />
            <Stat label={t('4 or more visits')} value={pct(ind.anc4Pct)} />
            <Stat label={t('8 or more visits')} value={pct(ind.anc8Pct)} />
          </Grid>
        </Card>
      )}
      {data.byMunicipality.length > 0 && (
        <Card title={t('By municipality')}>
          <IndicatorTable
            rows={data.byMunicipality}
            caption={t('Maternity indicators by municipality')}
          />
        </Card>
      )}
      <p className="muted">
        {t(
          'Aggregate figures only. Counts below {n} are not shown. Indicators cover pregnancies booked in the last 12 months.',
          { n: data.threshold },
        )}
      </p>
    </div>
  );
}

/**
 * Antenatal care: the care team's worklist of ongoing pregnancies (doctors, nurses), and
 * aggregate figures for directors (own facility) and the Ministry (national).
 */
export function MaternityPage() {
  const user = useUser();
  const staff = user.role === 'DOCTOR' || user.role === 'NURSE';
  const dashboard = useMaternityDashboard(!staff);
  return (
    <div className="stack">
      <PageHeader
        title={user.role === 'MINISTRY' ? t('Maternal health') : t('Antenatal care')}
        subtitle={
          staff
            ? t('Ongoing pregnancies of patients in your care, with what needs attention.')
            : t('Pregnancies, antenatal contacts and risk – aggregate figures.')
        }
      />
      {staff ? (
        <Worklist />
      ) : (
        <QueryView query={dashboard}>{(d) => <Dashboard data={d} />}</QueryView>
      )}
    </div>
  );
}
