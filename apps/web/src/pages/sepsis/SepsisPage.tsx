import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  usePatientSepsis,
  useSepsisBoard,
  useSepsisDashboard,
  type BoardFilter,
  type SepsisBoardItem,
} from '../../api/sepsis';
import { useUser } from '../../auth/AuthContext';
import {
  Alert,
  Button,
  Card,
  Dialog,
  EmptyState,
  Grid,
  PageHeader,
  QueryView,
  Stat,
  Table,
  Tabs,
} from '../../components/ui';
import { formatMonth, formatTime, fullName } from '../../format';
import { t } from '../../i18n';
import {
  BundleClock,
  BundlePanel,
  FlagList,
  ScreenForm,
  SepsisStatusBadge,
} from './SepsisComponents';

function chartLink(role: string, patientId: string) {
  return `${role === 'NURSE' ? '/nurse' : '/doctor'}/patients/${patientId}?tab=sepsis`;
}

/** Screen a pending prompt, or follow the bundle, for one board item. */
function ScreenDialog({ item, onClose }: { item: SepsisBoardItem; onClose: () => void }) {
  const user = useUser();
  const patient = usePatientSepsis(item.patientId);
  const current = patient.data?.items.find((s) => s.id === item.id) ?? item;
  return (
    <Dialog
      open
      onClose={onClose}
      wide
      title={`${fullName(item.patient)}${item.unitName ? ` · ${item.unitName}` : ''}${
        item.bedLabel ? ` · ${t('bed {bed}', { bed: item.bedLabel })}` : ''
      }`}
    >
      <QueryView query={patient}>
        {(data) =>
          current.status === 'PENDING' ? (
            <ScreenForm
              patientId={item.patientId}
              screenId={item.id}
              suggested={data.suggestedFlags}
              onDone={(s) => {
                if (s.status === 'NOT_SEPSIS') onClose();
              }}
            />
          ) : (
            <div className="stack">
              <FlagList flags={current.flags} />
              <BundlePanel
                patientId={item.patientId}
                screen={current}
                canReview={user.role === 'DOCTOR'}
                target={data.targetMinutes}
              />
            </div>
          )
        }
      </QueryView>
      <p>
        <Link to={chartLink(user.role, item.patientId)}>{t('Open the chart')}</Link>
      </p>
    </Dialog>
  );
}

function Board() {
  const user = useUser();
  const [params, setParams] = useSearchParams();
  const [filter, setFilter] = useState<BoardFilter>('OPEN');
  const board = useSepsisBoard(filter);
  const openId = params.get('screen');
  const close = () => {
    params.delete('screen');
    setParams(params, { replace: true });
  };
  return (
    <>
      <PageHeader
        title={t('Sepsis')}
        subtitle={t(
          'Screens prompted by raised early warning scores and Sepsis Six bundles still running, for the patients you are responsible for.',
        )}
      />
      <QueryView query={board}>
        {(data) => {
          const selected = openId ? data.items.find((i) => i.id === openId) : undefined;
          return (
            <div className="stack">
              <Grid min={180}>
                <Stat label={t('Red flag sepsis')} value={data.counts.RED_FLAG} tone="danger" />
                <Stat
                  label={t('Bundle overdue')}
                  value={data.counts.overdue}
                  tone={data.counts.overdue ? 'danger' : 'success'}
                />
                <Stat label={t('Screen needed')} value={data.counts.PENDING} tone="info" />
                <Stat
                  label={t('Sepsis suspected')}
                  value={data.counts.SEPSIS_SUSPECTED}
                  tone="warning"
                />
              </Grid>
              <Tabs<BoardFilter>
                label={t('Filter')}
                active={filter}
                onChange={setFilter}
                withPanels={false}
                tabs={[
                  { id: 'OPEN', label: t('All open') },
                  { id: 'RED_FLAG', label: t('Red flag sepsis') },
                  { id: 'PENDING', label: t('Screen needed') },
                  { id: 'SEPSIS_SUSPECTED', label: t('Sepsis suspected') },
                ]}
              />
              <Card>
                {data.items.length === 0 ? (
                  <EmptyState title={t('No open sepsis screens')} />
                ) : (
                  <Table caption={t('Open sepsis screens')}>
                    <thead>
                      <tr>
                        <th scope="col">{t('Patient')}</th>
                        <th scope="col">{t('Where')}</th>
                        <th scope="col">{t('Status')}</th>
                        <th scope="col">{t('Sepsis Six')}</th>
                        <th scope="col">{t('Raised')}</th>
                        <th scope="col">
                          <span className="sr-only">{t('Actions')}</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.items.map((i) => (
                        <tr key={i.id}>
                          <td>
                            <Link to={chartLink(user.role, i.patientId)}>
                              {fullName(i.patient)}
                            </Link>
                          </td>
                          <td>
                            {i.unitName ?? '—'}
                            {i.bedLabel ? `, ${t('bed {bed}', { bed: i.bedLabel })}` : ''}
                          </td>
                          <td>
                            <SepsisStatusBadge status={i.status} />
                          </td>
                          <td>
                            {i.bundleStartedAt ? (
                              <BundleClock screen={i} target={data.targetMinutes} />
                            ) : (
                              <span className="muted">—</span>
                            )}
                          </td>
                          <td>{formatTime(i.createdAt)}</td>
                          <td>
                            <Button
                              size="sm"
                              variant={i.status === 'PENDING' ? 'primary' : 'secondary'}
                              onClick={() => setParams({ screen: i.id })}
                            >
                              {i.status === 'PENDING' ? t('Screen now') : t('Bundle')}
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                )}
              </Card>
              {openId && !selected && (
                <Alert tone="info" title={t('This screen is no longer open')}>
                  {t('It was answered or the bundle is complete.')}
                </Alert>
              )}
              {selected && <ScreenDialog item={selected} onClose={close} />}
            </div>
          );
        }}
      </QueryView>
    </>
  );
}

const pct = (v: number | null) => (v === null ? t('Too few to show') : `${v}%`);
const minutes = (v: number | null) =>
  v === null ? t('Too few to show') : t('{minutes} min', { minutes: v });

function Dashboard() {
  const dash = useSepsisDashboard();
  return (
    <>
      <PageHeader
        title={t('Sepsis')}
        subtitle={t(
          'Sepsis screening and Sepsis Six compliance at your facility over the last 12 months (no names).',
        )}
      />
      <QueryView query={dash}>
        {(d) => (
          <div className="stack">
            <Grid min={200}>
              <Stat label={t('Screens')} value={d.total.screens} />
              <Stat label={t('Red flag sepsis')} value={d.total.redFlags} tone="danger" />
              <Stat
                label={t('All six within {minutes} min', { minutes: d.targetMinutes })}
                value={pct(d.total.withinTargetPct)}
              />
              <Stat
                label={t('Median time to antibiotics')}
                value={minutes(d.total.medianMinutesToAntibiotics)}
              />
            </Grid>
            <Card title={t('By month')}>
              {d.months.length === 0 ? (
                <EmptyState title={t('No sepsis screens yet')} />
              ) : (
                <Table caption={t('Sepsis screens by month')}>
                  <thead>
                    <tr>
                      <th scope="col">{t('Month')}</th>
                      <th scope="col" className="num">
                        {t('Screens')}
                      </th>
                      <th scope="col" className="num">
                        {t('Prompted by a score')}
                      </th>
                      <th scope="col" className="num">
                        {t('Red flag sepsis')}
                      </th>
                      <th scope="col" className="num">
                        {t('All six within {minutes} min', { minutes: d.targetMinutes })}
                      </th>
                      <th scope="col" className="num">
                        {t('Median time to antibiotics')}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.months.map((m) => (
                      <tr key={m.month}>
                        <td>{formatMonth(m.month)}</td>
                        <td className="num">{m.screens}</td>
                        <td className="num">{m.prompted}</td>
                        <td className="num">{m.redFlags}</td>
                        <td className="num">{pct(m.withinTargetPct)}</td>
                        <td className="num">{minutes(m.medianMinutesToAntibiotics)}</td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
              <p className="muted">
                {t(
                  'Percentages and times are shown only when at least {count} cases are behind them.',
                  { count: d.smallCellThreshold },
                )}
              </p>
            </Card>
          </div>
        )}
      </QueryView>
    </>
  );
}

export function SepsisPage() {
  const user = useUser();
  return user.role === 'DIRECTOR' ? <Dashboard /> : <Board />;
}
