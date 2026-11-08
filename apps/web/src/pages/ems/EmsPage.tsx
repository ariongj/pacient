import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import {
  outcomeLabel,
  priorityLabel,
  priorityTone,
  statusLabel,
  useAddVehicle,
  useEmsBoard,
  useEmsServices,
  useEmsStats,
  useVehicleStatus,
  vehicleStatusLabel,
  type EmsStats,
} from '../../api/ems';
import { useUser } from '../../auth/AuthContext';
import { BarChart, RankedBars } from '../../components/charts';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorAlert,
  formValues,
  Grid,
  PageHeader,
  QueryView,
  SelectField,
  Stat,
  Table,
  TextField,
} from '../../components/ui';
import { formatMonth, formatNumber, formatTime } from '../../format';
import { t } from '../../i18n';
import { boardRowLabel, IncidentPanel } from './IncidentPanel';
import { NewCallDialog } from './NewCallDialog';

const minutesSince = (iso: string, now: number) =>
  Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60_000));

/** Ticks every 30 seconds so the elapsed times on the board stay current between refreshes. */
function useNow() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

export function EmsPage() {
  const user = useUser();
  const services = useEmsServices();
  return (
    <>
      <PageHeader
        title={t('Ambulance service')}
        subtitle={t(
          'Emergency calls, dispatch, care before hospital and handover to the emergency department.',
        )}
      />
      <QueryView query={services}>
        {(s) => (
          <>
            {s.mine.length > 0 && <DispatchBoard services={s.mine} />}
            {user.role === 'DIRECTOR' && s.atFacility.length > 0 && (
              <Fleet services={s.atFacility} />
            )}
            {s.canSeeStats && <StatsSection />}
            {s.mine.length === 0 && !s.canSeeStats && (
              <Card>
                <EmptyState title={t('You are not assigned to an ambulance service')}>
                  {s.canTakeHandover ? (
                    <>
                      {t('Incoming ambulances for your emergency department are shown on the')}{' '}
                      <Link to="/ed">{t('emergency department board')}</Link>.
                    </>
                  ) : (
                    t('Staff are assigned to an ambulance service by the facility director.')
                  )}
                </EmptyState>
              </Card>
            )}
          </>
        )}
      </QueryView>
    </>
  );
}

function DispatchBoard({ services }: { services: { id: string; name: string }[] }) {
  const [serviceId, setServiceId] = useState(services[0]!.id);
  const [newCall, setNewCall] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const board = useEmsBoard(serviceId);
  const vehicleStatus = useVehicleStatus();
  const now = useNow();
  return (
    <>
      {services.length > 1 && (
        <SelectField
          label={t('Ambulance service')}
          value={serviceId}
          onChange={(e) => setServiceId(e.target.value)}
          options={services.map((s) => ({ value: s.id, label: s.name }))}
        />
      )}
      <div className="split">
        <Card
          title={t('Open calls')}
          actions={<Button onClick={() => setNewCall(true)}>{t('New emergency call')}</Button>}
        >
          <QueryView query={board}>
            {(b) =>
              b.items.length === 0 ? (
                <EmptyState title={t('No open calls')} />
              ) : (
                <Table caption={t('Open calls')}>
                  <thead>
                    <tr>
                      <th scope="col">{t('Category')}</th>
                      <th scope="col">{t('Call')}</th>
                      <th scope="col">{t('Status')}</th>
                      <th scope="col">{t('Waiting')}</th>
                      <th scope="col">
                        <span className="sr-only">{t('Actions')}</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {b.items.map((i) => {
                      const waiting = minutesSince(i.receivedAt, now);
                      return (
                        <tr key={i.id}>
                          <td>
                            <Badge tone={priorityTone(i.priority)}>{i.priority}</Badge>
                          </td>
                          <td>
                            <strong>{i.complaint}</strong>
                            <div className="muted">
                              {[i.address, i.municipality].filter(Boolean).join(', ')}
                            </div>
                            <div className="muted">{boardRowLabel(i)}</div>
                          </td>
                          <td>
                            {statusLabel(i.status)}
                            {i.vehicle && <div className="muted">{i.vehicle}</div>}
                          </td>
                          <td>
                            <Badge
                              tone={
                                i.status === 'RECEIVED' && i.priority === 'P1' && waiting >= 2
                                  ? 'danger'
                                  : 'neutral'
                              }
                            >
                              {t('{minutes} min', { minutes: waiting })}
                            </Badge>
                            <div className="muted">{formatTime(i.receivedAt)}</div>
                          </td>
                          <td>
                            <Button size="sm" variant="secondary" onClick={() => setOpenId(i.id)}>
                              {t('Open|action')}
                              <span className="sr-only"> {i.reference}</span>
                            </Button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </Table>
              )
            }
          </QueryView>
        </Card>
        <Card title={t('Vehicles')}>
          {board.data && (
            <ul className="stack" aria-label={t('Vehicles')}>
              {board.data.vehicles.map((v) => (
                <li key={v.id} className="row-between">
                  <span>
                    <strong>{v.callSign}</strong> <span className="muted">{v.level}</span>
                  </span>
                  <span className="row">
                    <Badge
                      tone={
                        v.status === 'AVAILABLE'
                          ? 'success'
                          : v.status === 'OUT_OF_SERVICE'
                            ? 'neutral'
                            : 'warning'
                      }
                    >
                      {vehicleStatusLabel(v.status)}
                    </Badge>
                    {(v.status === 'AVAILABLE' || v.status === 'OUT_OF_SERVICE') && (
                      <Button
                        size="sm"
                        variant="secondary"
                        loading={vehicleStatus.isPending && vehicleStatus.variables?.id === v.id}
                        onClick={() =>
                          vehicleStatus.mutate({
                            id: v.id,
                            status: v.status === 'AVAILABLE' ? 'OUT_OF_SERVICE' : 'AVAILABLE',
                          })
                        }
                      >
                        {v.status === 'AVAILABLE' ? t('Take out of service') : t('Back in service')}
                        <span className="sr-only"> {v.callSign}</span>
                      </Button>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <ErrorAlert error={vehicleStatus.error} />
        </Card>
      </div>
      <NewCallDialog
        serviceId={serviceId}
        open={newCall}
        onClose={() => setNewCall(false)}
        onCreated={(id) => {
          setNewCall(false);
          setOpenId(id);
        }}
      />
      {openId && (
        <IncidentPanel
          id={openId}
          vehicles={board.data?.vehicles ?? []}
          onClose={() => setOpenId(null)}
        />
      )}
    </>
  );
}

function Fleet({ services }: { services: { id: string; name: string }[] }) {
  const add = useAddVehicle();
  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const v = formValues(form);
    add.mutate(
      { serviceId: v.serviceId!, callSign: v.callSign!, level: v.level as 'BLS' | 'ALS' },
      { onSuccess: () => form.reset() },
    );
  }
  return (
    <Card title={t('Add a vehicle')}>
      <form onSubmit={onSubmit} className="form-grid">
        <SelectField
          label={t('Ambulance service')}
          name="serviceId"
          required
          options={services.map((s) => ({ value: s.id, label: s.name }))}
        />
        <TextField label={t('Call sign')} name="callSign" required minLength={2} maxLength={20} />
        <SelectField
          label={t('Level of care')}
          name="level"
          required
          options={[
            { value: 'ALS', label: t('Advanced (ALS)') },
            { value: 'BLS', label: t('Basic (BLS)') },
          ]}
        />
        <div className="form-actions">
          <Button type="submit" loading={add.isPending}>
            {t('Add')}
          </Button>
        </div>
      </form>
      <ErrorAlert error={add.error} />
      {add.isSuccess && <p role="status">{t('Vehicle added.')}</p>}
    </Card>
  );
}

const count = (n: number | null) => (n === null ? t('Too few to show') : formatNumber(n));
const minutes = (n: number | null) =>
  n === null ? '—' : t('{minutes} min', { minutes: formatNumber(n) });

function StatsSection() {
  const stats = useEmsStats(true);
  return (
    <QueryView query={stats}>
      {(s: EmsStats) => (
        <div className="stack">
          <Grid>
            <Stat label={t('Calls in the last 90 days')} value={count(s.total)} />
            <Stat
              label={t('P1 reached within {minutes} minutes', { minutes: s.p1TargetMinutes })}
              value={
                s.p1WithinTargetPercent === null ? '—' : `${formatNumber(s.p1WithinTargetPercent)}%`
              }
              hint={t('Illustrative target until national targets are set.')}
            />
          </Grid>
          <Card title={t('Response times by category')}>
            <Table caption={t('Response times by category')}>
              <thead>
                <tr>
                  <th scope="col">{t('Category')}</th>
                  <th scope="col">{t('Calls')}</th>
                  <th scope="col">{t('Call to dispatch (median)')}</th>
                  <th scope="col">{t('Dispatch to scene (median)')}</th>
                  <th scope="col">{t('Dispatch to scene (90th percentile)')}</th>
                </tr>
              </thead>
              <tbody>
                {s.byPriority.map((r) => (
                  <tr key={r.priority}>
                    <td>
                      <Badge tone={priorityTone(r.priority)}>{priorityLabel(r.priority)}</Badge>
                    </td>
                    <td className="num">{count(r.calls)}</td>
                    <td className="num">{minutes(r.medianCallToDispatchMinutes)}</td>
                    <td className="num">{minutes(r.medianResponseMinutes)}</td>
                    <td className="num">{minutes(r.p90ResponseMinutes)}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <p className="muted">
              {t('Groups with fewer than {n} calls are not shown.', { n: s.smallCellThreshold })}
            </p>
          </Card>
          <div className="split">
            <Card title={t('Calls by month')}>
              <BarChart
                title={t('Calls by month')}
                data={s.byMonth.map((m) => ({
                  label: formatMonth(`${m.month}-01`),
                  value: m.calls ?? 0,
                }))}
              />
              <Table caption={t('Calls by month')}>
                <thead>
                  <tr>
                    <th scope="col">{t('Month')}</th>
                    <th scope="col">{t('Calls')}</th>
                  </tr>
                </thead>
                <tbody>
                  {s.byMonth.map((m) => (
                    <tr key={m.month}>
                      <td>{formatMonth(`${m.month}-01`)}</td>
                      <td className="num">{count(m.calls)}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </Card>
            <Card title={t('Calls by municipality')}>
              <RankedBars
                label={t('Calls by municipality')}
                rows={s.byMunicipality.map((m) => ({
                  key: m.municipality ?? '-',
                  label: m.municipality ?? t('Not recorded'),
                  value: m.calls,
                  suppressed: m.calls === null,
                }))}
              />
            </Card>
          </div>
          <Card title={t('Outcomes')}>
            <Table caption={t('Outcomes')}>
              <thead>
                <tr>
                  <th scope="col">{t('Outcome')}</th>
                  <th scope="col">{t('Calls')}</th>
                </tr>
              </thead>
              <tbody>
                {s.byOutcome.map((o) => (
                  <tr key={o.outcome}>
                    <td>{outcomeLabel(o.outcome)}</td>
                    <td className="num">{count(o.calls)}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Card>
        </div>
      )}
    </QueryView>
  );
}
