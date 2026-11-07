import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/client';
import {
  CERTIFICATE_NUMBER,
  MANNER_LABEL,
  PLACE_LABEL,
  useDeathByNumber,
  useWithdrawDeath,
  useDeathList,
  useMortalityStats,
  type MortalityStats,
} from '../../api/deaths';
import { useUser } from '../../auth/AuthContext';
import { BarChart, RankedBars } from '../../components/charts';
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
  Stat,
  Table,
  TabPanel,
  Tabs,
  TextAreaField,
  TextField,
} from '../../components/ui';
import { formatDate, formatDateTime, formatMonth, formatNumber } from '../../format';
import { t } from '../../i18n';

function Statistics({ stats }: { stats: MortalityStats }) {
  const threshold = stats.suppressionThreshold;
  const below = (n: number | null) =>
    n === null ? t('fewer than {n}', { n: threshold }) : formatNumber(n);
  return (
    <div className="stack">
      <Grid>
        <Stat label={t('Deaths in the period')} value={below(stats.total)} />
        <Stat
          label={t('In hospital or emergency department')}
          value={below(stats.inHospital.deaths)}
        />
        <Stat
          label={t('In-hospital mortality (per 100 discharges)')}
          value={
            stats.inHospital.ratePer100 === null ? '—' : formatNumber(stats.inHospital.ratePer100)
          }
        />
        <Stat
          label={t('Discharges in the period')}
          value={formatNumber(stats.inHospital.discharges)}
        />
      </Grid>
      <Alert tone="info">
        {t(
          'Counts below {n} are not shown, so that no person can be recognised. Figures use the underlying cause of death after any amendments.',
          { n: threshold },
        )}
      </Alert>
      <Card title={t('Deaths by month')}>
        <BarChart
          title={t('Deaths by month')}
          data={stats.byMonth.map((m) => ({ label: formatMonth(m.month), value: m.count ?? 0 }))}
        />
        {stats.byMonth.some((m) => m.count === null) && (
          <p className="muted">
            {t('Months with fewer than {n} deaths are shown as 0.', { n: threshold })}
          </p>
        )}
      </Card>
      <Card title={t('Underlying cause by ICD-10 chapter')}>
        {stats.byChapter.length === 0 ? (
          <EmptyState title={t('No deaths in the period')} />
        ) : (
          <RankedBars
            label={t('Underlying cause by ICD-10 chapter')}
            rows={stats.byChapter.map((c) => ({
              key: c.chapter,
              label: t(c.label),
              sublabel: c.range,
              value: c.count,
              suppressed: c.count === null,
            }))}
          />
        )}
      </Card>
      <Card title={t('Deaths by age and sex')}>
        <BarChart
          title={t('Deaths by age')}
          data={stats.byAgeBand.map((b) => ({ label: b.band, value: b.total ?? 0 }))}
        />
        <Table caption={t('Deaths by age and sex')}>
          <thead>
            <tr>
              <th scope="col">{t('Age')}</th>
              <th scope="col">{t('Men')}</th>
              <th scope="col">{t('Women')}</th>
              <th scope="col">{t('Total')}</th>
            </tr>
          </thead>
          <tbody>
            {stats.byAgeBand.map((b) => (
              <tr key={b.band}>
                <th scope="row">{b.band}</th>
                <td>{below(b.male)}</td>
                <td>{below(b.female)}</td>
                <td>{below(b.total)}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>
      {stats.byManner.length > 0 && (
        <Card title={t('Manner of death')}>
          <RankedBars
            label={t('Manner of death')}
            rows={stats.byManner.map((m) => ({
              key: m.manner,
              label: t(MANNER_LABEL[m.manner]),
              value: m.count,
              suppressed: m.count === null,
            }))}
          />
        </Card>
      )}
    </div>
  );
}

function StatsSection() {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const stats = useMortalityStats(from || undefined, to || undefined);
  return (
    <div className="stack">
      <div className="form-grid no-print">
        <TextField
          label={t('From')}
          type="date"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
        />
        <TextField label={t('To')} type="date" value={to} onChange={(e) => setTo(e.target.value)} />
      </div>
      <QueryView query={stats}>{(s) => <Statistics stats={s} />}</QueryView>
    </div>
  );
}

function CertificateList({ chartBase }: { chartBase: string | null }) {
  const [status, setStatus] = useState<'DRAFT' | 'SIGNED'>('DRAFT');
  const [page, setPage] = useState(1);
  const list = useDeathList(status, page);
  return (
    <Card title={t('Death certificates of my facility')}>
      <Tabs<'DRAFT' | 'SIGNED'>
        label={t('Certificate status')}
        active={status}
        withPanels={false}
        onChange={(s) => {
          setStatus(s);
          setPage(1);
        }}
        tabs={[
          { id: 'DRAFT', label: t('Drafts') },
          { id: 'SIGNED', label: t('Signed') },
        ]}
      />
      <QueryView query={list}>
        {(data) =>
          data.items.length === 0 ? (
            <EmptyState title={status === 'DRAFT' ? t('No drafts') : t('No signed certificates')} />
          ) : (
            <>
              <Table caption={t('Death certificates of my facility')}>
                <thead>
                  <tr>
                    <th scope="col">{t('Patient')}</th>
                    <th scope="col">{t('National ID')}</th>
                    <th scope="col">{t('Date and time of death')}</th>
                    <th scope="col">{t('Place of death')}</th>
                    <th scope="col">{t('Death certificate number')}</th>
                    <th scope="col">{t('Certified by')}</th>
                    <th scope="col">{t('Civil registry')}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((d) => (
                    <tr key={d.id}>
                      <td>
                        {chartBase ? (
                          <Link to={`${chartBase}/${d.patient.id}?tab=death`}>
                            {d.patient.lastName}, {d.patient.firstName}
                          </Link>
                        ) : (
                          `${d.patient.lastName}, ${d.patient.firstName}`
                        )}
                        <div className="muted">{formatDate(d.patient.dateOfBirth)}</div>
                      </td>
                      <td>
                        <code>{d.patient.nationalId}</code>
                      </td>
                      <td>{formatDateTime(d.diedAt)}</td>
                      <td>{t(PLACE_LABEL[d.placeOfDeath])}</td>
                      <td>
                        {d.certificateNumber ?? <Badge tone="warning">{t('Draft')}</Badge>}
                        {d.amendments > 0 && (
                          <div className="muted">
                            {t('Amended ({count})', { count: d.amendments })}
                          </div>
                        )}
                      </td>
                      <td>{d.certifiedBy ?? '—'}</td>
                      <td>
                        {d.status !== 'SIGNED' ? (
                          '—'
                        ) : d.civilRegistryAcknowledgedAt ? (
                          <Badge tone="success">{t('Registered')}</Badge>
                        ) : (
                          <Badge tone="neutral">{t('Awaiting registration')}</Badge>
                        )}
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
    </Card>
  );
}

interface PatientHit {
  id: string;
  firstName: string;
  lastName: string;
  nationalId: string;
  dateOfBirth: string;
}

/** Doctors start a certificate from the patient's chart; this finds the patient. */
function StartCertificate() {
  const [search, setSearch] = useState('');
  const [term, setTerm] = useState('');
  const hits = useQuery({
    queryKey: ['deaths', 'patient-search', term],
    queryFn: () =>
      api<{ items: PatientHit[] }>('/patients', { query: { search: term, pageSize: 10 } }),
    enabled: term.length >= 2,
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTerm(search.trim());
  };
  return (
    <Card title={t('Start a death certificate')}>
      <p className="muted">
        {t(
          'Find the patient, open the record and use the “Death certificate” tab. You must be part of the patient’s care team.',
        )}
      </p>
      <form onSubmit={submit} className="row" role="search">
        <TextField
          label={t('Name or national ID')}
          value={search}
          minLength={2}
          onChange={(e) => setSearch(e.target.value)}
        />
        <Button type="submit">{t('Search')}</Button>
      </form>
      {term.length >= 2 && (
        <QueryView query={hits}>
          {(data) =>
            data.items.length === 0 ? (
              <EmptyState title={t('No patients found')} />
            ) : (
              <ul className="stack">
                {data.items.map((p) => (
                  <li key={p.id}>
                    <Link to={`/doctor/patients/${p.id}?tab=death`}>
                      {p.lastName}, {p.firstName}
                    </Link>{' '}
                    <span className="muted">
                      {formatDate(p.dateOfBirth)} · <code>{p.nationalId}</code>
                    </span>
                  </li>
                ))}
              </ul>
            )
          }
        </QueryView>
      )}
    </Card>
  );
}

/**
 * The Ministry withdraws a certificate issued in error (e.g. for the wrong person): the person is
 * no longer recorded as deceased and what signing ended is restored.
 */
function WithdrawSection() {
  const [input, setInput] = useState('');
  const [number, setNumber] = useState('');
  const [reason, setReason] = useState('');
  const [confirming, setConfirming] = useState(false);
  const found = useDeathByNumber(number);
  const withdraw = useWithdrawDeath();
  const r = found.data;
  return (
    <Card title={t('Withdraw a death certificate')}>
      <p className="muted">
        {t(
          'Use only when a certificate was issued in error, for example for the wrong person. The person is no longer recorded as deceased; disease registers, waiting lists and the portal account are restored. Cancelled appointments are not restored – the care team is asked to rebook. The civil registry sees the withdrawal.',
        )}
      </p>
      <form
        className="form-row"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          withdraw.reset();
          setNumber(input.trim().toUpperCase());
        }}
      >
        <TextField
          label={t('Death certificate number')}
          name="number"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="VD-2026-000123"
          required
        />
        <Button type="submit" variant="secondary">
          {t('Find')}
        </Button>
      </form>
      {number && !CERTIFICATE_NUMBER.test(number) && (
        <Alert tone="warning" title={t('Check the number')}>
          {t('A death certificate number looks like VD-2026-000123.')}
        </Alert>
      )}
      {found.isError && <ErrorAlert error={found.error} />}
      {r && (
        <div className="stack" style={{ marginTop: '1rem' }}>
          <dl className="dl">
            <div>
              <dt>{t('Person')}</dt>
              <dd>
                {r.firstName} {r.lastName} · {r.nationalId} · {formatDate(r.dateOfBirth)}
              </dd>
            </div>
            <div>
              <dt>{t('Date and time of death')}</dt>
              <dd>{formatDateTime(r.diedAt)}</dd>
            </div>
            <div>
              <dt>{t('Certifying facility')}</dt>
              <dd>{r.facilityName}</dd>
            </div>
            <div>
              <dt>{t('Status')}</dt>
              <dd>
                {r.status === 'WITHDRAWN' ? (
                  <Badge tone="neutral">{t('Withdrawn')}</Badge>
                ) : r.status === 'SIGNED' ? (
                  <Badge tone="success">{t('Signed')}</Badge>
                ) : (
                  <Badge tone="warning">{t('Draft')}</Badge>
                )}
              </dd>
            </div>
          </dl>
          {r.status === 'WITHDRAWN' && (
            <Alert tone="info" title={t('Already withdrawn')}>
              {t('Withdrawn on {date}: {reason}', {
                date: r.withdrawnAt ? formatDateTime(r.withdrawnAt) : '',
                reason: r.withdrawReason ?? '',
              })}
            </Alert>
          )}
          {r.status === 'SIGNED' && !withdraw.isSuccess && (
            <form
              className="stack"
              onSubmit={(e: FormEvent) => {
                e.preventDefault();
                setConfirming(true);
              }}
            >
              <TextAreaField
                label={t('Reason for withdrawal')}
                name="reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                minLength={20}
                maxLength={500}
                rows={3}
                required
                hint={t('At least {count} characters. Recorded in the audit log.', { count: 20 })}
              />
              <div>
                <Button type="submit" variant="danger">
                  {t('Withdraw the certificate')}
                </Button>
              </div>
            </form>
          )}
          {withdraw.isSuccess && (
            <Alert tone="success" title={t('The certificate was withdrawn')}>
              {t(
                'Restored: {registers} register memberships, {waiting} waiting-list entries; portal account {portal}.',
                {
                  registers: withdraw.data.effects.registersRestored,
                  waiting: withdraw.data.effects.waitingListRestored,
                  portal: withdraw.data.effects.portalRestored ? t('re-enabled') : t('unchanged'),
                },
              )}
            </Alert>
          )}
          <ErrorAlert error={withdraw.error} />
        </div>
      )}
      <Dialog
        open={confirming && Boolean(r)}
        onClose={() => setConfirming(false)}
        title={t('Withdraw the certificate')}
      >
        <p>
          {t('Withdraw death certificate {number}? This cannot be undone.', {
            number: r?.certificateNumber ?? '',
          })}
        </p>
        <div className="form-actions">
          <Button variant="secondary" onClick={() => setConfirming(false)}>
            {t('Cancel')}
          </Button>
          <Button
            variant="danger"
            loading={withdraw.isPending}
            onClick={() =>
              r &&
              withdraw.mutate(
                { id: r.id, reason },
                {
                  onSettled: () => setConfirming(false),
                  onSuccess: () => void found.refetch(),
                },
              )
            }
          >
            {t('Withdraw')}
          </Button>
        </div>
      </Dialog>
    </Card>
  );
}

export function DeathsPage() {
  const user = useUser();
  const [tab, setTab] = useState<'certificates' | 'statistics'>('certificates');
  const [ministryTab, setMinistryTab] = useState<'statistics' | 'withdraw'>('statistics');
  if (user.role === 'MINISTRY') {
    return (
      <>
        <PageHeader
          title={t('Mortality')}
          subtitle={t('National mortality from signed death certificates (no names).')}
        />
        <Tabs
          label={t('Mortality')}
          active={ministryTab}
          onChange={setMinistryTab}
          tabs={[
            { id: 'statistics', label: t('Statistics') },
            { id: 'withdraw', label: t('Withdraw a certificate') },
          ]}
        />
        <TabPanel id={ministryTab}>
          {ministryTab === 'statistics' ? <StatsSection /> : <WithdrawSection />}
        </TabPanel>
      </>
    );
  }
  if (user.role === 'DIRECTOR') {
    return (
      <>
        <PageHeader
          title={t('Deaths')}
          subtitle={t(
            'Death certificates and mortality at your facility. Causes of death are visible only to the care team.',
          )}
        />
        <Tabs
          label={t('Deaths')}
          active={tab}
          onChange={setTab}
          tabs={[
            { id: 'certificates', label: t('Death certificates') },
            { id: 'statistics', label: t('Statistics') },
          ]}
        />
        <TabPanel id={tab}>
          {tab === 'certificates' ? <CertificateList chartBase={null} /> : <StatsSection />}
        </TabPanel>
      </>
    );
  }
  return (
    <>
      <PageHeader
        title={t('Death certificates')}
        subtitle={t('Medical certificates of cause of death (WHO international form).')}
      />
      <div className="stack">
        <StartCertificate />
        <CertificateList chartBase="/doctor/patients" />
      </div>
    </>
  );
}
