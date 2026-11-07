import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api } from '../../api/client';
import {
  licenceState,
  LIST_STATES,
  PROFESSIONS,
  professionLabel,
  stateLabel,
  stateTone,
  useAccountSearch,
  useCreateLicence,
  useFacilityLicences,
  useImportLicences,
  useLicenceHistory,
  useLicenceRegister,
  useLicenceStats,
  useLicenceStatus,
  useLinkLicence,
  useUnlinkLicence,
  useUpdateLicence,
  type FacilityStaffLicence,
  type ImportResult,
  type LicenceStatus,
  type LicenceWithAccount,
  type Profession,
  type RegisterQuery,
} from '../../api/licences';
import type { Facility } from '../../api/types';
import { useUser } from '../../auth/AuthContext';
import {
  Alert,
  Badge,
  Button,
  Card,
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
  Table,
  TabPanel,
  Tabs,
  TextAreaField,
  TextField,
} from '../../components/ui';
import { formatDate, formatDateTime, formatNumber, humanize } from '../../format';
import { t } from '../../i18n';

/**
 * Professional licences. The Ministry keeps the national register (create, renew, suspend, revoke,
 * link to staff accounts, CSV import, statistics); directors see the licence state of their own
 * clinical staff and can link a licence when it matches the account.
 */
export function LicencesPage() {
  const user = useUser();
  if (user.role === 'DIRECTOR') {
    return (
      <>
        <PageHeader
          title={t('Staff licences')}
          subtitle={t(
            'Doctors, nurses and pharmacists need a valid professional licence to make clinical entries.',
          )}
        />
        <FacilityStaff />
      </>
    );
  }
  return <MinistryLicences />;
}

type MinistryTab = 'register' | 'stats' | 'import' | 'facility';

function MinistryLicences() {
  const [tab, setTab] = useState<MinistryTab>('register');
  const [creating, setCreating] = useState(false);
  return (
    <>
      <PageHeader
        title={t('Professional licences')}
        subtitle={t(
          'National register of licensed doctors, dentists, nurses, midwives and pharmacists.',
        )}
        actions={<Button onClick={() => setCreating(true)}>{t('Register a licence')}</Button>}
      />
      <Tabs<MinistryTab>
        label={t('Professional licences')}
        active={tab}
        onChange={setTab}
        tabs={[
          { id: 'register', label: t('Register|licences') },
          { id: 'stats', label: t('Statistics') },
          { id: 'import', label: t('Import from CSV') },
          { id: 'facility', label: t('Staff of a facility') },
        ]}
      />
      <TabPanel id={tab}>
        {tab === 'register' && <RegisterTab />}
        {tab === 'stats' && <StatsTab />}
        {tab === 'import' && <ImportTab />}
        {tab === 'facility' && <FacilityPicker />}
      </TabPanel>
      <Dialog
        open={creating}
        onClose={() => setCreating(false)}
        title={t('Register a licence')}
        wide
      >
        {creating && <LicenceForm onDone={() => setCreating(false)} />}
      </Dialog>
    </>
  );
}

function StateBadge({ state }: { state: Parameters<typeof stateLabel>[0] }) {
  return <Badge tone={stateTone(state)}>{stateLabel(state)}</Badge>;
}

/* ---------------------------------------------------------------------------- register -- */

function RegisterTab() {
  const [query, setQuery] = useState<RegisterQuery>({ page: 1 });
  const [openId, setOpenId] = useState<string | null>(null);
  const register = useLicenceRegister(query);
  return (
    <Card>
      <form
        className="search-bar"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          const v = formValues(e.currentTarget);
          setQuery({ q: v.q, profession: v.profession, state: v.state, linked: v.linked, page: 1 });
        }}
      >
        <TextField
          label={t('Name, number or specialty')}
          name="q"
          type="search"
          defaultValue={query.q}
        />
        <SelectField
          label={t('Profession')}
          name="profession"
          placeholder={t('All professions')}
          defaultValue={query.profession}
          options={PROFESSIONS.map((p) => ({ value: p, label: professionLabel(p) }))}
        />
        <SelectField
          label={t('Licence state')}
          name="state"
          placeholder={t('All states')}
          defaultValue={query.state}
          options={LIST_STATES.map((s) => ({ value: s, label: stateLabel(s) }))}
        />
        <SelectField
          label={t('Staff account')}
          name="linked"
          placeholder={t('All licences')}
          defaultValue={query.linked}
          options={[
            { value: 'yes', label: t('Linked to an account') },
            { value: 'no', label: t('Not linked') },
          ]}
        />
        <Button type="submit" variant="secondary">
          {t('Filter')}
        </Button>
      </form>
      <QueryView query={register}>
        {(data) =>
          data.items.length === 0 ? (
            <EmptyState title={t('No licences found')} />
          ) : (
            <>
              <Table caption={t('Professional licences')}>
                <thead>
                  <tr>
                    <th scope="col">{t('Licence number')}</th>
                    <th scope="col">{t('Holder')}</th>
                    <th scope="col">{t('Profession')}</th>
                    <th scope="col">{t('Valid until')}</th>
                    <th scope="col">{t('Licence state')}</th>
                    <th scope="col">{t('Staff account')}</th>
                    <th scope="col">
                      <span className="sr-only">{t('Actions')}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((l) => (
                    <tr key={l.id}>
                      <td>
                        <code>{l.licenceNumber}</code>
                      </td>
                      <td>{l.holderName}</td>
                      <td>
                        {professionLabel(l.profession)}
                        {l.specialty && <div className="muted">{l.specialty}</div>}
                      </td>
                      <td>{formatDate(l.validUntil)}</td>
                      <td>
                        <StateBadge state={licenceState(l)} />
                      </td>
                      <td>
                        {l.account ? (
                          <>
                            {l.account.fullName}
                            <div className="muted">{l.account.facilityName ?? l.account.email}</div>
                          </>
                        ) : (
                          <span className="muted">{t('Not linked')}</span>
                        )}
                      </td>
                      <td>
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => setOpenId(l.id)}
                          aria-label={t('Open licence {number}', { number: l.licenceNumber })}
                        >
                          {t('Open|action')}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
              <Pagination
                page={data.page}
                totalPages={data.totalPages}
                onChange={(page) => setQuery({ ...query, page })}
              />
            </>
          )
        }
      </QueryView>
      <Dialog open={openId !== null} onClose={() => setOpenId(null)} title={t('Licence')} wide>
        {openId && <LicenceDetail id={openId} />}
      </Dialog>
    </Card>
  );
}

function LicenceDetail({ id }: { id: string }) {
  const detail = useQuery({
    queryKey: ['licences', 'one', id],
    queryFn: () => api<LicenceWithAccount>(`/licences/${id}`),
  });
  const [mode, setMode] = useState<'view' | 'edit' | 'status' | 'link' | 'unlink'>('view');
  return (
    <QueryView query={detail}>
      {(l) => (
        <div className="stack">
          <dl className="dl">
            <div>
              <dt>{t('Licence number')}</dt>
              <dd>
                <code>{l.licenceNumber}</code>
              </dd>
            </div>
            <div>
              <dt>{t('Holder')}</dt>
              <dd>{l.holderName}</dd>
            </div>
            <div>
              <dt>{t('Profession')}</dt>
              <dd>
                {professionLabel(l.profession)}
                {l.specialty ? ` · ${l.specialty}` : ''}
              </dd>
            </div>
            <div>
              <dt>{t('Issued by')}</dt>
              <dd>
                {l.issuedBy}, {formatDate(l.issuedOn)}
              </dd>
            </div>
            <div>
              <dt>{t('Valid until')}</dt>
              <dd>
                {formatDate(l.validUntil)} <StateBadge state={licenceState(l)} />
              </dd>
            </div>
            {l.statusReason && l.status !== 'ACTIVE' && (
              <div>
                <dt>{t('Reason')}</dt>
                <dd>{l.statusReason}</dd>
              </div>
            )}
            <div>
              <dt>{t('CPD credits')}</dt>
              <dd>{formatNumber(l.cpdCredits)}</dd>
            </div>
            <div>
              <dt>{t('Staff account')}</dt>
              <dd>
                {l.account
                  ? `${l.account.fullName} (${l.account.email}${l.account.facilityName ? `, ${l.account.facilityName}` : ''})`
                  : t('Not linked')}
              </dd>
            </div>
          </dl>
          {mode === 'view' && (
            <div className="form-actions">
              <Button variant="secondary" onClick={() => setMode('edit')}>
                {t('Edit or renew')}
              </Button>
              {l.status !== 'REVOKED' && (
                <Button variant="secondary" onClick={() => setMode('status')}>
                  {l.status === 'ACTIVE' ? t('Suspend or revoke') : t('Change status')}
                </Button>
              )}
              {l.account ? (
                <Button variant="ghost" onClick={() => setMode('unlink')}>
                  {t('Unlink account')}
                </Button>
              ) : (
                <Button onClick={() => setMode('link')}>{t('Link to a staff account')}</Button>
              )}
            </div>
          )}
          {mode === 'edit' && <LicenceForm licence={l} onDone={() => setMode('view')} />}
          {mode === 'status' && <StatusForm licence={l} onDone={() => setMode('view')} />}
          {mode === 'link' && <LinkForm licenceId={l.id} onDone={() => setMode('view')} />}
          {mode === 'unlink' && <UnlinkForm licenceId={l.id} onDone={() => setMode('view')} />}
          <LicenceHistory id={l.id} />
        </div>
      )}
    </QueryView>
  );
}

function changeLabel(change: string): string {
  switch (change) {
    case 'created':
      return t('Registered');
    case 'updated':
      return t('Updated|licence');
    case 'status':
      return t('Status changed');
    case 'linked':
      return t('Linked to an account');
    case 'unlinked':
      return t('Unlinked from the account');
    default:
      return humanize(change);
  }
}

function LicenceHistory({ id }: { id: string }) {
  const history = useLicenceHistory(id);
  return (
    <section aria-labelledby={`history-${id}`}>
      <h3 id={`history-${id}`}>{t('History')}</h3>
      <QueryView query={history}>
        {(data) =>
          data.items.length === 0 ? (
            <p className="muted">{t('No changes recorded')}</p>
          ) : (
            <ul className="list">
              {data.items.map((h, i) => (
                <li key={i}>
                  <strong>{changeLabel(h.change)}</strong>
                  {h.to &&
                    ` → ${stateLabel(h.to === 'ACTIVE' ? 'VALID' : (h.to as 'SUSPENDED' | 'REVOKED'))}`}
                  <span className="muted">
                    {' '}
                    · {formatDateTime(h.at)} · {h.actor ?? t('System')}
                  </span>
                  {h.reason && <div className="muted">{h.reason}</div>}
                </li>
              ))}
            </ul>
          )
        }
      </QueryView>
    </section>
  );
}

function LicenceForm({ licence, onDone }: { licence?: LicenceWithAccount; onDone: () => void }) {
  const create = useCreateLicence();
  const update = useUpdateLicence();
  const mutation = licence ? update : create;
  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const v = formValues(e.currentTarget);
    const body = {
      holderName: v.holderName!,
      profession: v.profession as Profession,
      specialty: v.specialty || null,
      issuedBy: v.issuedBy!,
      issuedOn: v.issuedOn!,
      validUntil: v.validUntil!,
      cpdCredits: v.cpdCredits ? Number(v.cpdCredits) : undefined,
    };
    if (licence) update.mutate({ id: licence.id, ...body }, { onSuccess: onDone });
    else create.mutate({ licenceNumber: v.licenceNumber, ...body }, { onSuccess: onDone });
  }
  return (
    <form onSubmit={onSubmit} className="stack">
      <div className="form-grid">
        {!licence && (
          <TextField
            label={t('Licence number')}
            name="licenceNumber"
            required
            minLength={3}
            maxLength={40}
            pattern="[A-Za-z0-9/_.\-]+"
          />
        )}
        <TextField
          label={t('Holder')}
          name="holderName"
          required
          minLength={3}
          maxLength={200}
          defaultValue={licence?.holderName}
        />
        <SelectField
          label={t('Profession')}
          name="profession"
          required
          defaultValue={licence?.profession}
          options={PROFESSIONS.map((p) => ({ value: p, label: professionLabel(p) }))}
        />
        <TextField
          label={t('Specialty')}
          name="specialty"
          maxLength={120}
          defaultValue={licence?.specialty ?? ''}
        />
        <TextField
          label={t('Issued by')}
          name="issuedBy"
          required
          minLength={3}
          maxLength={200}
          defaultValue={licence?.issuedBy}
        />
        <TextField
          label={t('Issued on')}
          name="issuedOn"
          type="date"
          required
          defaultValue={licence?.issuedOn}
        />
        <TextField
          label={t('Valid until')}
          name="validUntil"
          type="date"
          required
          defaultValue={licence?.validUntil}
        />
        <TextField
          label={t('CPD credits')}
          name="cpdCredits"
          type="number"
          min={0}
          max={9999}
          defaultValue={licence?.cpdCredits}
        />
      </div>
      <ErrorAlert error={mutation.error} />
      <div className="form-actions">
        <Button variant="secondary" onClick={onDone}>
          {t('Cancel')}
        </Button>
        <Button type="submit" loading={mutation.isPending}>
          {licence ? t('Save') : t('Register a licence')}
        </Button>
      </div>
    </form>
  );
}

function StatusForm({ licence, onDone }: { licence: LicenceWithAccount; onDone: () => void }) {
  const mutation = useLicenceStatus();
  const options: { value: LicenceStatus; label: string }[] = (
    [
      ['ACTIVE', t('Reinstate (valid)')],
      ['SUSPENDED', t('Suspend')],
      ['REVOKED', t('Revoke (final)')],
    ] as [LicenceStatus, string][]
  )
    .filter(([s]) => s !== licence.status)
    .map(([value, label]) => ({ value, label }));
  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        const v = formValues(e.currentTarget);
        mutation.mutate(
          { id: licence.id, status: v.status as LicenceStatus, reason: v.reason! },
          { onSuccess: onDone },
        );
      }}
    >
      <SelectField label={t('New status')} name="status" required options={options} />
      <TextAreaField
        label={t('Reason')}
        name="reason"
        required
        minLength={5}
        maxLength={500}
        rows={2}
        hint={t('Recorded in the audit log and shown to the holder’s director.')}
      />
      <Alert tone="warning">
        {t('A suspended or revoked licence blocks clinical entries by the holder immediately.')}
      </Alert>
      <ErrorAlert error={mutation.error} />
      <div className="form-actions">
        <Button variant="secondary" onClick={onDone}>
          {t('Cancel')}
        </Button>
        <Button type="submit" variant="danger" loading={mutation.isPending}>
          {t('Change status')}
        </Button>
      </div>
    </form>
  );
}

function LinkForm({ licenceId, onDone }: { licenceId: string; onDone: () => void }) {
  const [q, setQ] = useState('');
  const accounts = useAccountSearch(q);
  const link = useLinkLicence();
  return (
    <div className="stack">
      <TextField
        label={t('Find the staff account (name, email or licence number)')}
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        hint={t(
          'The profession must fit the role: doctors are physicians or dentists, nurses are nurses or midwives.',
        )}
      />
      {q.trim().length >= 2 && (
        <QueryView query={accounts}>
          {(data) =>
            data.items.length === 0 ? (
              <p className="muted">{t('No clinical staff account matches')}</p>
            ) : (
              <ul className="list">
                {data.items.map((a) => (
                  <li
                    key={a.id}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      gap: '0.5rem',
                      flexWrap: 'wrap',
                      alignItems: 'center',
                    }}
                  >
                    <span>
                      <strong>{a.fullName}</strong> · {humanize(a.role)} · {a.facilityName ?? '—'}
                      {a.licenseNumber && (
                        <span className="muted">
                          {' '}
                          · <code>{a.licenseNumber}</code>
                        </span>
                      )}
                    </span>
                    {a.linkedLicenceId ? (
                      <Badge>{t('Already linked')}</Badge>
                    ) : (
                      <Button
                        size="sm"
                        loading={link.isPending}
                        onClick={() =>
                          link.mutate({ id: licenceId, userId: a.id }, { onSuccess: onDone })
                        }
                        aria-label={t('Link to {name}', { name: a.fullName })}
                      >
                        {t('Link|action')}
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )
          }
        </QueryView>
      )}
      <ErrorAlert error={link.error} />
      <div className="form-actions">
        <Button variant="secondary" onClick={onDone}>
          {t('Cancel')}
        </Button>
      </div>
    </div>
  );
}

function UnlinkForm({ licenceId, onDone }: { licenceId: string; onDone: () => void }) {
  const unlink = useUnlinkLicence();
  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        unlink.mutate(
          { id: licenceId, reason: formValues(e.currentTarget).reason! },
          { onSuccess: onDone },
        );
      }}
    >
      <TextAreaField
        label={t('Reason')}
        name="reason"
        required
        minLength={5}
        maxLength={500}
        rows={2}
      />
      <ErrorAlert error={unlink.error} />
      <div className="form-actions">
        <Button variant="secondary" onClick={onDone}>
          {t('Cancel')}
        </Button>
        <Button type="submit" variant="danger" loading={unlink.isPending}>
          {t('Unlink account')}
        </Button>
      </div>
    </form>
  );
}

/* --------------------------------------------------------------------------- statistics -- */

function StatsTab() {
  const stats = useLicenceStats();
  return (
    <QueryView query={stats}>
      {(s) => {
        const total = (k: keyof (typeof s.byProfession)[number]) =>
          s.byProfession.reduce((n, p) => n + Number(p[k] ?? 0), 0);
        return (
          <div className="stack">
            <Grid>
              <Stat
                label={t('Valid licences')}
                value={formatNumber(total('VALID') + total('EXPIRING'))}
                tone="success"
              />
              <Stat
                label={t('Expiring within {days} days', { days: s.expiryWarningDays })}
                value={formatNumber(total('EXPIRING'))}
                tone="warning"
              />
              <Stat
                label={t('Expired|licence')}
                value={formatNumber(total('EXPIRED'))}
                tone="danger"
              />
              <Stat
                label={t('Clinical accounts without a licence')}
                value={formatNumber(s.clinicalAccountsWithoutLicence)}
                tone={s.clinicalAccountsWithoutLicence ? 'warning' : 'success'}
              />
            </Grid>
            <Card title={t('Licences by profession')}>
              <Table caption={t('Licences by profession')}>
                <thead>
                  <tr>
                    <th scope="col">{t('Profession')}</th>
                    {LIST_STATES.map((st) => (
                      <th scope="col" key={st} className="num">
                        {stateLabel(st)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {s.byProfession.map((p) => (
                    <tr key={p.profession}>
                      <td>{professionLabel(p.profession)}</td>
                      {LIST_STATES.map((st) => (
                        <td key={st} className="num">
                          {formatNumber(p[st] ?? 0)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </Table>
              <p className="muted">
                {t('{count} licences are linked to staff accounts.', {
                  count: formatNumber(s.linked),
                })}
              </p>
            </Card>
            <Card title={t('Expiring soon')}>
              {s.expiring.length === 0 ? (
                <EmptyState
                  title={t('No licence expires within {days} days', { days: s.expiryWarningDays })}
                />
              ) : (
                <Table caption={t('Expiring soon')}>
                  <thead>
                    <tr>
                      <th scope="col">{t('Licence number')}</th>
                      <th scope="col">{t('Holder')}</th>
                      <th scope="col">{t('Profession')}</th>
                      <th scope="col">{t('Valid until')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {s.expiring.map((e) => (
                      <tr key={e.id}>
                        <td>
                          <code>{e.licenceNumber}</code>
                        </td>
                        <td>{e.holderName}</td>
                        <td>{professionLabel(e.profession)}</td>
                        <td>
                          {formatDate(e.validUntil)}{' '}
                          <span className="muted">
                            ({t('in {days} days', { days: e.daysToExpiry })})
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </Card>
          </div>
        );
      }}
    </QueryView>
  );
}

/* ------------------------------------------------------------------------------ import -- */

const CSV_EXAMPLE =
  'licenceNumber,holderName,profession,specialty,issuedBy,issuedOn,validUntil,cpdCredits\nKMC-50001,Dr. Arta Berisha,PHYSICIAN,Pediatri,Oda e Mjekëve të Kosovës,2024-03-01,2029-03-01,24';

function ImportTab() {
  const [csv, setCsv] = useState('');
  const [result, setResult] = useState<ImportResult | null>(null);
  const run = useImportLicences();
  const submit = (dryRun: boolean) =>
    run.mutate({ csv, dryRun }, { onSuccess: (r) => setResult(r) });
  return (
    <Card title={t('Import from CSV')}>
      <div className="stack">
        <p className="muted">
          {t(
            'Columns: licenceNumber, holderName, profession, specialty, issuedBy, issuedOn, validUntil, cpdCredits. Professions: PHYSICIAN, DENTIST, NURSE, MIDWIFE, PHARMACIST. Dates as YYYY-MM-DD. Existing numbers are updated; the status is never changed by an import.',
          )}
        </p>
        <TextField
          label={t('CSV file')}
          type="file"
          accept=".csv,text/csv"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            if (file) {
              setCsv(await file.text());
              setResult(null);
            }
          }}
        />
        <TextAreaField
          label={t('Or paste the rows')}
          value={csv}
          rows={6}
          placeholder={CSV_EXAMPLE}
          onChange={(e) => {
            setCsv(e.target.value);
            setResult(null);
          }}
        />
        <ErrorAlert error={run.error} />
        {result && (
          <Alert
            tone={result.errors.length ? 'warning' : 'success'}
            title={
              result.dryRun
                ? t('Check: {create} new, {update} updated, {errors} rows with errors', {
                    create: result.create,
                    update: result.update,
                    errors: result.errors.length,
                  })
                : t('Imported: {create} new, {update} updated, {errors} rows skipped', {
                    create: result.create,
                    update: result.update,
                    errors: result.errors.length,
                  })
            }
          >
            {result.errors.length > 0 && (
              <ul>
                {result.errors.slice(0, 50).map((e) => (
                  <li key={`${e.line}-${e.message}`}>
                    {t('Line {line}: {message}', { line: e.line, message: e.message })}
                  </li>
                ))}
              </ul>
            )}
          </Alert>
        )}
        <div className="form-actions">
          <Button
            variant="secondary"
            disabled={!csv.trim()}
            loading={run.isPending}
            onClick={() => submit(true)}
          >
            {t('Check the file')}
          </Button>
          <Button
            disabled={!csv.trim() || !result?.dryRun || result.create + result.update === 0}
            loading={run.isPending}
            onClick={() => submit(false)}
          >
            {t('Import')}
          </Button>
        </div>
      </div>
    </Card>
  );
}

/* ---------------------------------------------------------------------- facility staff -- */

function FacilityPicker() {
  const facilities = useQuery({
    queryKey: ['facilities', { search: '', includeInactive: false }],
    queryFn: () => api<{ items: Facility[] }>('/facilities'),
  });
  const [facilityId, setFacilityId] = useState('');
  return (
    <div className="stack">
      <Card>
        <SelectField
          label={t('Facility')}
          value={facilityId}
          placeholder={t('Choose a facility')}
          onChange={(e) => setFacilityId(e.target.value)}
          options={(facilities.data?.items ?? []).map((f) => ({ value: f.id, label: f.name }))}
        />
      </Card>
      {facilityId && <FacilityStaff facilityId={facilityId} />}
    </div>
  );
}

function FacilityStaff({ facilityId }: { facilityId?: string }) {
  const user = useUser();
  const staff = useFacilityLicences(facilityId);
  const link = useLinkLicence();
  const [target, setTarget] = useState<FacilityStaffLicence | null>(null);
  return (
    <QueryView query={staff}>
      {(data) => (
        <div className="stack">
          <Grid>
            <Stat
              label={t('Valid|licence')}
              value={formatNumber(data.summary.VALID)}
              tone="success"
            />
            <Stat
              label={t('Expiring within {days} days', { days: data.expiryWarningDays })}
              value={formatNumber(data.summary.EXPIRING)}
              tone={data.summary.EXPIRING ? 'warning' : undefined}
            />
            <Stat
              label={t('Expired, suspended or revoked')}
              value={formatNumber(
                data.summary.EXPIRED + data.summary.SUSPENDED + data.summary.REVOKED,
              )}
              tone={
                data.summary.EXPIRED + data.summary.SUSPENDED + data.summary.REVOKED
                  ? 'danger'
                  : undefined
              }
            />
            <Stat
              label={t('No licence linked')}
              value={formatNumber(data.summary.MISSING)}
              tone={data.summary.MISSING ? 'warning' : undefined}
            />
          </Grid>
          <Card title={t('Clinical staff')}>
            {data.items.length === 0 ? (
              <EmptyState title={t('No doctors, nurses or pharmacists at this facility')} />
            ) : (
              <Table caption={t('Clinical staff')}>
                <thead>
                  <tr>
                    <th scope="col">{t('Name')}</th>
                    <th scope="col">{t('Role')}</th>
                    <th scope="col">{t('Licence number')}</th>
                    <th scope="col">{t('Licence state')}</th>
                    <th scope="col">{t('Valid until')}</th>
                    <th scope="col">
                      <span className="sr-only">{t('Actions')}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((s) => (
                    <tr key={s.id}>
                      <td>
                        <strong>{s.fullName}</strong>
                        {!s.isActive && <span className="muted"> ({t('Deactivated')})</span>}
                        <div className="muted">{s.email}</div>
                      </td>
                      <td>{humanize(s.role)}</td>
                      <td>
                        {s.licence ? (
                          <code>{s.licence.licenceNumber}</code>
                        ) : s.licenseNumber ? (
                          <span className="muted">
                            <code>{s.licenseNumber}</code> {t('(on the account)')}
                          </span>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td>
                        <StateBadge state={s.state} />
                        {s.licence?.statusReason && s.licence.status !== 'ACTIVE' && (
                          <div className="muted">{s.licence.statusReason}</div>
                        )}
                      </td>
                      <td>{s.licence ? formatDate(s.licence.validUntil) : '—'}</td>
                      <td>
                        {s.linkCandidate && (
                          <Button
                            size="sm"
                            onClick={() => setTarget(s)}
                            aria-label={t('Link licence for {name}', { name: s.fullName })}
                          >
                            {t('Link licence')}
                          </Button>
                        )}
                        {!s.licence && !s.linkCandidate && user.role === 'DIRECTOR' && (
                          <span className="muted">{t('Ask the Ministry to link the licence')}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
          <Dialog open={target !== null} onClose={() => setTarget(null)} title={t('Link licence')}>
            {target?.linkCandidate && (
              <div className="stack">
                <p>
                  {t(
                    'Link licence {number} ({holder}) in the national register to the account of {name}?',
                    {
                      number: target.linkCandidate.licenceNumber,
                      holder: target.linkCandidate.holderName,
                      name: target.fullName,
                    },
                  )}
                </p>
                <ErrorAlert error={link.error} />
                <div className="form-actions">
                  <Button variant="secondary" onClick={() => setTarget(null)}>
                    {t('Cancel')}
                  </Button>
                  <Button
                    loading={link.isPending}
                    onClick={() =>
                      link.mutate(
                        { id: target.linkCandidate!.id, userId: target.id },
                        { onSuccess: () => setTarget(null) },
                      )
                    }
                  >
                    {t('Link licence')}
                  </Button>
                </div>
              </div>
            )}
          </Dialog>
        </div>
      )}
    </QueryView>
  );
}
