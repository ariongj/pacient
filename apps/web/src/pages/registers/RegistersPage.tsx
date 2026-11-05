import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  processLabel,
  REGISTER_CODES,
  registerLabel,
  STATE_TONE,
  stateLabel,
  targetDescription,
  targetLabel,
  useIndicators,
  useRecalls,
  type IndicatorCell,
  type RegisterIndicators,
} from '../../api/registers';
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

const registerOptions = () => [
  { value: '', label: t('All registers') },
  ...REGISTER_CODES.map((r) => ({ value: r, label: registerLabel(r) })),
];

/* -------------------------------------------------------------------------- recalls -- */

function RecallList() {
  const user = useUser();
  const [register, setRegister] = useState('');
  const [state, setState] = useState<'OVERDUE' | 'DUE' | 'ALL'>('OVERDUE');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const list = useRecalls({ register: register || undefined, state, q: q || undefined, page });
  const chartBase = user.role === 'NURSE' ? '/nurse/patients' : '/doctor/patients';

  return (
    <>
      <Card>
        <div className="form-grid">
          <SelectField
            label={t('Register')}
            value={register}
            onChange={(e) => {
              setRegister(e.currentTarget.value);
              setPage(1);
            }}
            options={registerOptions()}
          />
          <SelectField
            label={t('Show')}
            value={state}
            onChange={(e) => {
              setState(e.currentTarget.value as typeof state);
              setPage(1);
            }}
            options={[
              { value: 'OVERDUE', label: t('Overdue reviews') },
              { value: 'DUE', label: t('Overdue, due and due soon') },
              { value: 'ALL', label: t('Everything not up to date') },
            ]}
          />
          <TextField
            label={t('Search patient')}
            placeholder={t('Name or national ID')}
            value={q}
            onChange={(e) => {
              setQ(e.currentTarget.value);
              setPage(1);
            }}
          />
        </div>
      </Card>
      <QueryView query={list}>
        {(data) => (
          <div className="stack">
            <Grid min={180}>
              <Stat
                label={t('Register members in my care')}
                value={formatNumber(data.counts.inCare)}
              />
              <Stat label={t('Patients to recall')} value={formatNumber(data.counts.patients)} />
              <Stat
                label={t('Overdue review items')}
                value={formatNumber(data.counts.overdueItems)}
                tone={data.counts.overdueItems ? 'danger' : undefined}
              />
            </Grid>
            <Card>
              {data.items.length === 0 ? (
                <EmptyState title={t('No reviews to recall')}>
                  {t(
                    'Patients in your care whose register reviews are not up to date appear here.',
                  )}
                </EmptyState>
              ) : (
                <Table caption={t('Recall list')}>
                  <thead>
                    <tr>
                      <th>{t('Patient')}</th>
                      <th>{t('Register')}</th>
                      <th>{t('Review items')}</th>
                      <th>{t('Contact')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.items.map((item) =>
                      item.registers.map((r, i) => (
                        <tr key={`${item.patient.id}-${r.register}`}>
                          {i === 0 && (
                            <td rowSpan={item.registers.length}>
                              <Link to={`${chartBase}/${item.patient.id}?tab=registers`}>
                                {fullName(item.patient)}
                              </Link>
                              <div className="muted mono">{item.patient.nationalId}</div>
                              <div className="muted">{formatDate(item.patient.dateOfBirth)}</div>
                            </td>
                          )}
                          <td>
                            {registerLabel(r.register)}
                            {r.targetsNotMet.length > 0 && (
                              <div>
                                {r.targetsNotMet.map((tc) => (
                                  <Badge key={tc} tone="warning">
                                    {t('Not at target: {target}', { target: targetLabel(tc) })}
                                  </Badge>
                                ))}
                              </div>
                            )}
                          </td>
                          <td>
                            <ul style={{ margin: 0, paddingLeft: '1rem' }}>
                              {r.items.map((x) => (
                                <li key={x.code}>
                                  {processLabel(x.code)}{' '}
                                  <Badge tone={STATE_TONE[x.state]}>{stateLabel(x.state)}</Badge>{' '}
                                  <span className="muted">
                                    {t('Due {date}', { date: formatDate(x.dueDate) })}
                                  </span>
                                </li>
                              ))}
                            </ul>
                          </td>
                          {i === 0 && (
                            <td rowSpan={item.registers.length}>
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

/* ------------------------------------------------------------------------ indicators -- */

const pct = (c: IndicatorCell) =>
  c.suppressed ? (
    <span className="muted" title={t('Too few patients to show')}>
      {t('suppressed')}
    </span>
  ) : c.percent === null ? (
    '—'
  ) : (
    `${formatNumber(c.percent)} %`
  );

function RegisterCard({ r }: { r: RegisterIndicators }) {
  return (
    <Card
      title={registerLabel(r.register)}
      actions={
        r.suppressed ? (
          <Badge>{t('Too few patients to show')}</Badge>
        ) : (
          <Badge tone="info">
            {t('{count} patients', { count: formatNumber(r.enrolled ?? 0) })}
          </Badge>
        )
      }
    >
      {r.prevalencePer1000 !== null && (
        <p className="muted">
          {t('{value} per 1 000 registered patients', {
            value: formatNumber(r.prevalencePer1000),
          })}
        </p>
      )}
      <Table
        caption={t('Quality indicators for {register}', { register: registerLabel(r.register) })}
      >
        <thead>
          <tr>
            <th>{t('Indicator')}</th>
            <th>{t('Patients')}</th>
            <th>{t('Share of the register')}</th>
          </tr>
        </thead>
        <tbody>
          {r.processes.map((p) => (
            <tr key={p.code}>
              <td>{t('{item} in the last 12 months', { item: processLabel(p.code) })}</td>
              <td>{p.suppressed ? '—' : formatNumber(p.count ?? 0)}</td>
              <td>{pct(p)}</td>
            </tr>
          ))}
          {r.targets.map((x) => (
            <tr key={x.code}>
              <td>
                <strong>{targetLabel(x.code)}</strong>
                <div className="muted">{targetDescription(x.code)}</div>
              </td>
              <td>{x.suppressed ? '—' : formatNumber(x.count ?? 0)}</td>
              <td>{pct(x)}</td>
            </tr>
          ))}
        </tbody>
      </Table>
    </Card>
  );
}

function IndicatorsView({ national }: { national: boolean }) {
  const [register, setRegister] = useState('');
  const [groupBy, setGroupBy] = useState<'MUNICIPALITY' | 'FACILITY'>('MUNICIPALITY');
  const query = useIndicators({
    register: register || undefined,
    groupBy: national ? groupBy : undefined,
  });
  return (
    <>
      <Card>
        <div className="form-grid">
          <SelectField
            label={t('Register')}
            value={register}
            onChange={(e) => setRegister(e.currentTarget.value)}
            options={registerOptions()}
          />
          {national && (
            <SelectField
              label={t('Group by')}
              value={groupBy}
              onChange={(e) => setGroupBy(e.currentTarget.value as typeof groupBy)}
              options={[
                { value: 'MUNICIPALITY', label: t('Municipality') },
                { value: 'FACILITY', label: t('Facility') },
              ]}
            />
          )}
        </div>
      </Card>
      <QueryView query={query}>
        {(data) => (
          <div className="stack">
            <p className="muted">
              {t('As of {date}. Counts below {threshold} are not shown to protect privacy.', {
                date: formatDate(data.asOf),
                threshold: data.threshold,
              })}{' '}
              {t('Targets are placeholders until confirmed by the national clinical guidelines.')}
            </p>
            <Grid min={340}>
              {data.total.map((r) => (
                <RegisterCard key={r.register} r={r} />
              ))}
            </Grid>
            {national && data.rows.length > 0 && (
              <Card title={groupBy === 'FACILITY' ? t('By facility') : t('By municipality')}>
                <Table caption={groupBy === 'FACILITY' ? t('By facility') : t('By municipality')}>
                  <thead>
                    <tr>
                      <th>{groupBy === 'FACILITY' ? t('Facility') : t('Municipality')}</th>
                      <th>{t('Register')}</th>
                      <th>{t('Patients')}</th>
                      <th>{t('Per 1 000')}</th>
                      {(data.total[0]?.targets ?? []).length > 0 && register && (
                        <>
                          {data.total[0]!.targets.map((x) => (
                            <th key={x.code}>{targetLabel(x.code)}</th>
                          ))}
                        </>
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {data.rows.flatMap((row) =>
                      row.registers.map((r, i) => (
                        <tr key={`${row.key}-${r.register}`}>
                          {i === 0 && <td rowSpan={row.registers.length}>{row.name}</td>}
                          <td>{registerLabel(r.register)}</td>
                          <td>
                            {r.suppressed ? (
                              <span className="muted">{t('suppressed')}</span>
                            ) : (
                              formatNumber(r.enrolled ?? 0)
                            )}
                          </td>
                          <td>
                            {r.prevalencePer1000 === null ? '—' : formatNumber(r.prevalencePer1000)}
                          </td>
                          {register && r.targets.map((x) => <td key={x.code}>{pct(x)}</td>)}
                        </tr>
                      )),
                    )}
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
 * Chronic disease registers: recall lists for the doctor's and nurse's own patients, quality
 * indicators for the director (own facility) and the Ministry (national, by municipality or
 * facility). Management views show counts only.
 */
export function RegistersPage() {
  const user = useUser();
  const clinical = user.role === 'DOCTOR' || user.role === 'NURSE';
  return (
    <>
      <PageHeader
        title={t('Disease registers')}
        subtitle={
          clinical
            ? t('Patients in your care with chronic conditions whose regular reviews are due.')
            : user.role === 'DIRECTOR'
              ? t('Quality of chronic care at {facility} – counts only, no names.', {
                  facility: user.facility?.name ?? '',
                })
              : t('National quality of chronic care – counts only, no names.')
        }
      />
      {clinical ? <RecallList /> : <IndicatorsView national={user.role === 'MINISTRY'} />}
    </>
  );
}
