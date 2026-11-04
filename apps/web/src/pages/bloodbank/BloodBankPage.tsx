import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';
import { useUser } from '../../auth/AuthContext';
import {
  BB_KEY,
  GROUPS,
  groupKey,
  groupLabel,
  PRODUCTS,
  productLabel,
  reactionTypeLabel,
  requestStatusLabel,
  severityLabel,
  urgencyLabel,
  urgencyTone,
  useBloodBankAction,
  useBloodBankMe,
  type BloodProduct,
  type CompatibleUnits,
  type QueueItem,
  type ReactionsReport,
  type Stock,
} from '../../api/bloodbank';
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
  TabPanel,
  Table,
  Tabs,
  TextField,
} from '../../components/ui';
import { age, formatDateTime } from '../../format';
import { t } from '../../i18n';
import './bloodbank.css';

type TabId = 'requests' | 'stock' | 'receive' | 'reactions';

export function BloodBankPage() {
  const me = useBloodBankMe();
  const [tab, setTab] = useState<TabId>('requests');
  const isStaff = me.data?.isStaff ?? false;
  return (
    <>
      <PageHeader
        title={t('Blood bank')}
        subtitle={t(
          'Transfusion requests, crossmatch and issue, blood stock and transfusion reactions.',
        )}
      />
      {me.isPending ? null : !isStaff ? (
        <>
          <Alert tone="info" title={t('You are not on the blood bank staff')}>
            {t(
              'Request blood products from the patient’s chart (tab "Transfusions"). The current stock is shown below.',
            )}
          </Alert>
          <StockTab />
        </>
      ) : (
        <>
          <Tabs<TabId>
            label={t('Blood bank sections')}
            active={tab}
            onChange={setTab}
            tabs={[
              { id: 'requests', label: t('Requests') },
              { id: 'stock', label: t('Stock') },
              { id: 'receive', label: t('Receive units') },
              { id: 'reactions', label: t('Reactions') },
            ]}
          />
          <TabPanel id={tab}>
            {tab === 'requests' && <RequestsTab />}
            {tab === 'stock' && <StockTab />}
            {tab === 'receive' && <ReceiveTab />}
            {tab === 'reactions' && <ReactionsTab />}
          </TabPanel>
        </>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ requests ------------------ */

function RequestsTab() {
  const base = useUser().role === 'NURSE' ? '/nurse' : '/doctor';
  const queue = useQuery({
    queryKey: [...BB_KEY, 'requests'],
    queryFn: () => api<{ items: QueueItem[] }>('/blood-bank/requests').then((r) => r.items),
    refetchInterval: 30_000,
  });
  const [crossmatching, setCrossmatching] = useState<QueueItem | null>(null);
  const [issuing, setIssuing] = useState<QueueItem | null>(null);
  const [emergency, setEmergency] = useState<QueueItem | null>(null);
  const sample = useBloodBankAction<{ id: string }>((b) => `/requests/${b.id}/sample`);
  return (
    <Card title={t('Open requests')}>
      <ErrorAlert error={sample.error} />
      <QueryView query={queue}>
        {(items) =>
          items.length === 0 ? (
            <EmptyState title={t('No open requests')} />
          ) : (
            <ul className="bb-queue">
              {items.map((r) => (
                <li key={r.id} className={`bb-request bb-${r.urgency.toLowerCase()}`}>
                  <div className="row-between">
                    <div>
                      <Badge tone={urgencyTone(r.urgency)}>{urgencyLabel(r.urgency)}</Badge>{' '}
                      <strong>
                        {t('{n} × {product}', { n: r.units, product: productLabel(r.product) })}
                      </strong>
                    </div>
                    <span className="muted">{requestStatusLabel(r.status)}</span>
                  </div>
                  <div>
                    <Link to={`${base}/patients/${r.patientId}?tab=transfusion`}>
                      {r.patientName}
                    </Link>{' '}
                    <span className="muted">
                      {t('{age} y', { age: age(r.dateOfBirth) })} · {r.nationalId}
                    </span>
                  </div>
                  <div className="bb-group-line">
                    <span className="bb-group-sm">{groupLabel(r.bloodGroup)}</span>
                    {r.groupDiscordant ? (
                      <Badge tone="danger">{t('Results disagree')}</Badge>
                    ) : r.groupConfirmed ? (
                      <Badge tone="success">{t('Confirmed')}</Badge>
                    ) : (
                      <Badge tone="warning">{t('Not confirmed')}</Badge>
                    )}
                    {r.antibodyScreen === 'POSITIVE' && (
                      <Badge tone="danger">{t('Antibodies')}</Badge>
                    )}
                  </div>
                  <p className="muted">
                    {r.indication}
                    {r.haemoglobinGl != null && ` · ${t('Hb {n} g/L', { n: r.haemoglobinGl })}`}
                  </p>
                  <p className="muted">
                    {t('Requested {time} by {name}', {
                      time: formatDateTime(r.createdAt),
                      name: r.requestedBy,
                    })}
                  </p>
                  {r.reservedUnits.length > 0 && (
                    <p>
                      {t('Reserved')}:{' '}
                      {r.reservedUnits.map((u) => (
                        <span key={u.id} className="mono bb-chip">
                          {u.unitNumber} {groupKey(u)}
                        </span>
                      ))}
                    </p>
                  )}
                  <div className="row bb-actions">
                    {r.status === 'REQUESTED' && (
                      <Button
                        size="sm"
                        loading={sample.isPending && sample.variables?.id === r.id}
                        onClick={() => sample.mutate({ id: r.id })}
                      >
                        {t('Sample received')}
                      </Button>
                    )}
                    {(r.status === 'SAMPLE_RECEIVED' ||
                      (r.status === 'REQUESTED' && r.urgency === 'EMERGENCY') ||
                      (r.status === 'CROSSMATCHED' && r.reservedUnits.length < r.units)) && (
                      <Button size="sm" variant="secondary" onClick={() => setCrossmatching(r)}>
                        {t('Crossmatch')}
                      </Button>
                    )}
                    {r.reservedUnits.length > 0 && (
                      <Button size="sm" onClick={() => setIssuing(r)}>
                        {t('Issue unit')}
                      </Button>
                    )}
                    {r.urgency === 'EMERGENCY' && r.product === 'RED_CELLS' && (
                      <Button size="sm" variant="danger" onClick={() => setEmergency(r)}>
                        {t('Emergency O RhD− (uncrossmatched)')}
                      </Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )
        }
      </QueryView>
      {crossmatching && (
        <CrossmatchDialog request={crossmatching} onClose={() => setCrossmatching(null)} />
      )}
      {issuing && <IssueDialog request={issuing} onClose={() => setIssuing(null)} />}
      {emergency && <EmergencyDialog request={emergency} onClose={() => setEmergency(null)} />}
    </Card>
  );
}

function CrossmatchDialog({ request, onClose }: { request: QueueItem; onClose: () => void }) {
  const units = useQuery({
    queryKey: [...BB_KEY, 'compatible', request.id],
    queryFn: () => api<CompatibleUnits>(`/blood-bank/requests/${request.id}/compatible-units`),
  });
  const [selected, setSelected] = useState<string[]>([]);
  const [reason, setReason] = useState('');
  const [warnings, setWarnings] = useState<string[]>([]);
  const crossmatch = useBloodBankAction<{ unitIds: string[]; emergencyReason?: string }>(
    () => `/requests/${request.id}/crossmatch`,
  );
  const remaining = request.units - request.reservedUnits.length;
  return (
    <Dialog open onClose={onClose} title={t('Crossmatch')} wide>
      {warnings.length > 0 ? (
        <>
          <Alert tone="warning" title={t('Crossmatched – please note')}>
            <ul>
              {warnings.map((w) => (
                <li key={w}>{t(w)}</li>
              ))}
            </ul>
          </Alert>
          <div className="form-actions">
            <Button onClick={onClose}>{t('Close')}</Button>
          </div>
        </>
      ) : (
        <QueryView query={units}>
          {(d) => (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                crossmatch.mutate(
                  {
                    unitIds: selected,
                    ...(reason.trim() ? { emergencyReason: reason.trim() } : {}),
                  },
                  {
                    onSuccess: (r) => {
                      if (r.warnings?.length) setWarnings(r.warnings);
                      else onClose();
                    },
                  },
                );
              }}
            >
              <p>
                {t('Recipient')}: <strong>{groupLabel(d.recipient)}</strong>{' '}
                {!d.groupConfirmed && (
                  <Badge tone="warning">
                    {t('Not confirmed – only universal units are offered')}
                  </Badge>
                )}
              </p>
              <p className="muted">
                {t('Select up to {n} compatible units (earliest expiry first).', { n: remaining })}
              </p>
              {d.items.length === 0 ? (
                <EmptyState title={t('No compatible units in stock')} />
              ) : (
                <fieldset>
                  <legend className="sr-only">{t('Compatible units')}</legend>
                  <ul className="list">
                    {d.items.map((u) => (
                      <li key={u.id}>
                        <label className="checkbox">
                          <input
                            type="checkbox"
                            checked={selected.includes(u.id)}
                            disabled={!selected.includes(u.id) && selected.length >= remaining}
                            onChange={(e) =>
                              setSelected((s) =>
                                e.target.checked ? [...s, u.id] : s.filter((x) => x !== u.id),
                              )
                            }
                          />
                          <span>
                            <span className="mono">{u.unitNumber}</span> · {groupLabel(u)} ·{' '}
                            {t('expires {date}', { date: formatDateTime(u.expiresAt) })}
                            {u.expiringSoon && (
                              <>
                                {' '}
                                <Badge tone="warning">{t('Expires soon')}</Badge>
                              </>
                            )}
                            {u.compatibility.warnings.map((w) => (
                              <span key={w} className="muted" style={{ display: 'block' }}>
                                {t(w)}
                              </span>
                            ))}
                          </span>
                        </label>
                      </li>
                    ))}
                  </ul>
                </fieldset>
              )}
              <TextField
                label={t(
                  'Emergency reason (only for RhD-positive units to an RhD-negative patient)',
                )}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                maxLength={300}
              />
              <ErrorAlert error={crossmatch.error} />
              <div className="form-actions">
                <Button variant="secondary" onClick={onClose}>
                  {t('Cancel')}
                </Button>
                <Button
                  type="submit"
                  disabled={selected.length === 0}
                  loading={crossmatch.isPending}
                >
                  {t('Reserve {n} units', { n: selected.length })}
                </Button>
              </div>
            </form>
          )}
        </QueryView>
      )}
    </Dialog>
  );
}

function IssueDialog({ request, onClose }: { request: QueueItem; onClose: () => void }) {
  const issue = useBloodBankAction<{ unitId: string }>(() => `/requests/${request.id}/issue`);
  return (
    <Dialog open onClose={onClose} title={t('Issue unit')}>
      <p>
        {t('Patient')}: <strong>{request.patientName}</strong> · {groupLabel(request.bloodGroup)}
      </p>
      <ul className="list">
        {request.reservedUnits.map((u) => (
          <li key={u.id} className="row-between">
            <span>
              <span className="mono">{u.unitNumber}</span> · {groupLabel(u)}
            </span>
            <Button
              size="sm"
              loading={issue.isPending && issue.variables?.unitId === u.id}
              onClick={() => issue.mutate({ unitId: u.id }, { onSuccess: onClose })}
            >
              {t('Issue')}
            </Button>
          </li>
        ))}
      </ul>
      <ErrorAlert error={issue.error} />
    </Dialog>
  );
}

function EmergencyDialog({ request, onClose }: { request: QueueItem; onClose: () => void }) {
  const stock = useQuery({
    queryKey: [...BB_KEY, 'stock'],
    queryFn: () => api<Stock>('/blood-bank/stock'),
  });
  const issue = useBloodBankAction<{ unitId: string; reason: string }>(
    () => `/requests/${request.id}/emergency-issue`,
  );
  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    issue.mutate(
      { unitId: String(f.get('unitId') ?? ''), reason: String(f.get('reason') ?? '') },
      { onSuccess: onClose },
    );
  }
  return (
    <Dialog open onClose={onClose} title={t('Emergency issue without crossmatch')} wide>
      <Alert tone="danger" title={t('Only for life-threatening bleeding')}>
        {t(
          'Group O RhD-negative red cells may be issued before the crossmatch. Take a sample for blood group first; the decision is recorded.',
        )}
      </Alert>
      <QueryView query={stock}>
        {(s) => {
          const oneg = s.units.filter(
            (u) =>
              u.product === 'RED_CELLS' &&
              u.abo === 'O' &&
              u.rhD === 'NEG' &&
              u.status === 'AVAILABLE' &&
              !u.expired,
          );
          return oneg.length === 0 ? (
            <Alert tone="warning" title={t('No O RhD-negative red cells in stock')} />
          ) : (
            <form onSubmit={onSubmit}>
              <SelectField
                label={t('Unit')}
                name="unitId"
                options={oneg.map((u) => ({
                  value: u.id,
                  label: `${u.unitNumber} · ${t('expires {date}', { date: formatDateTime(u.expiresAt) })}`,
                }))}
              />
              <TextField
                label={t('Reason')}
                name="reason"
                required
                minLength={10}
                maxLength={300}
                hint={t('For example: massive haemorrhage, no time for crossmatch')}
              />
              <ErrorAlert error={issue.error} />
              <div className="form-actions">
                <Button variant="secondary" onClick={onClose}>
                  {t('Cancel')}
                </Button>
                <Button type="submit" variant="danger" loading={issue.isPending}>
                  {t('Issue emergency unit')}
                </Button>
              </div>
            </form>
          );
        }}
      </QueryView>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ stock --------------------- */

function StockTab() {
  const stock = useQuery({
    queryKey: [...BB_KEY, 'stock'],
    queryFn: () => api<Stock>('/blood-bank/stock'),
  });
  const [discarding, setDiscarding] = useState<Stock['units'][number] | null>(null);
  return (
    <QueryView query={stock}>
      {(s) => (
        <div className="stack">
          <Grid min={160}>
            <Stat
              label={t('Units in stock')}
              value={Object.values(s.matrix).reduce(
                (a, row) =>
                  a + Object.values(row ?? {}).reduce((b, c) => b + c.available + c.reserved, 0),
                0,
              )}
            />
            <Stat
              label={t('Expiring within 3 days')}
              value={s.expiringCount}
              tone={s.expiringCount ? 'warning' : undefined}
            />
            <Stat
              label={t('Expired – to discard')}
              value={s.expiredCount}
              tone={s.expiredCount ? 'danger' : undefined}
            />
          </Grid>
          <Card title={t('Stock by product and blood group')}>
            <Table caption={t('Stock by product and blood group')}>
              <thead>
                <tr>
                  <th>{t('Product')}</th>
                  {GROUPS.map((g) => (
                    <th key={groupKey(g)} scope="col">
                      {groupKey(g)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {PRODUCTS.filter((p) => p !== 'WHOLE_BLOOD' || s.matrix[p]).map(
                  (p: BloodProduct) => (
                    <tr key={p}>
                      <th scope="row">{productLabel(p)}</th>
                      {GROUPS.map((g) => {
                        const c = s.matrix[p]?.[groupKey(g)];
                        const n = c?.available ?? 0;
                        return (
                          <td
                            key={groupKey(g)}
                            className={n === 0 ? 'bb-empty' : n < 3 ? 'bb-low' : undefined}
                          >
                            {n}
                            {c?.reserved ? (
                              <span className="muted">
                                {' '}
                                {t('(+{n} reserved)', { n: c.reserved })}
                              </span>
                            ) : null}
                          </td>
                        );
                      })}
                    </tr>
                  ),
                )}
              </tbody>
            </Table>
          </Card>
          {s.isStaff && (
            <Card title={t('Units')}>
              <Table caption={t('Units')}>
                <thead>
                  <tr>
                    <th>{t('Unit')}</th>
                    <th>{t('Group')}</th>
                    <th>{t('Expires')}</th>
                    <th>{t('Status')}</th>
                    <th>
                      <span className="sr-only">{t('Actions')}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {s.units.map((u) => (
                    <tr key={u.id}>
                      <td>
                        <span className="mono">{u.unitNumber}</span>
                        <div className="muted">
                          {productLabel(u.product)} · {t('{n} ml', { n: u.volumeMl })}
                        </div>
                      </td>
                      <td>{groupLabel(u)}</td>
                      <td>
                        {formatDateTime(u.expiresAt)}{' '}
                        {u.expired ? (
                          <Badge tone="danger">{t('Expired – do not issue')}</Badge>
                        ) : u.expiringSoon ? (
                          <Badge tone="warning">{t('Expires soon')}</Badge>
                        ) : null}
                      </td>
                      <td>{u.status === 'RESERVED' ? t('Reserved') : t('Available')}</td>
                      <td>
                        <Button size="sm" variant="secondary" onClick={() => setDiscarding(u)}>
                          {t('Discard')}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </Card>
          )}
          {discarding && <DiscardDialog unit={discarding} onClose={() => setDiscarding(null)} />}
        </div>
      )}
    </QueryView>
  );
}

function DiscardDialog({ unit, onClose }: { unit: Stock['units'][number]; onClose: () => void }) {
  const discard = useBloodBankAction<{ reason: string }>(() => `/units/${unit.id}/discard`);
  return (
    <Dialog open onClose={onClose} title={t('Discard unit {unit}', { unit: unit.unitNumber })}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          discard.mutate(
            { reason: String(new FormData(e.currentTarget).get('reason') ?? '') },
            { onSuccess: onClose },
          );
        }}
      >
        <TextField
          label={t('Reason')}
          name="reason"
          required
          minLength={3}
          maxLength={300}
          defaultValue={unit.expired ? t('Expired') : ''}
        />
        <ErrorAlert error={discard.error} />
        <div className="form-actions">
          <Button variant="secondary" onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button type="submit" variant="danger" loading={discard.isPending}>
            {t('Discard')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ receive ------------------- */

function ReceiveTab() {
  const receive = useBloodBankAction<Record<string, unknown>>(() => '/units');
  const [done, setDone] = useState<string[]>([]);
  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const [abo, rhD] = String(f.get('group') ?? 'O|NEG').split('|');
    const unitNumber = String(f.get('unitNumber') ?? '').trim();
    receive.mutate(
      {
        unitNumber,
        product: f.get('product'),
        abo,
        rhD,
        volumeMl: Number(f.get('volumeMl')),
        collectedAt: new Date(String(f.get('collectedAt'))).toISOString(),
        expiresAt: new Date(String(f.get('expiresAt'))).toISOString(),
      },
      {
        onSuccess: () => {
          setDone((d) => [unitNumber, ...d].slice(0, 10));
          (form.elements.namedItem('unitNumber') as HTMLInputElement).value = '';
          (form.elements.namedItem('unitNumber') as HTMLInputElement).focus();
        },
      },
    );
  }
  return (
    <Card title={t('Receive units')}>
      <p className="muted">
        {t('Scan or type each bag. Product, group and dates stay filled in for the next bag.')}
      </p>
      <form onSubmit={onSubmit}>
        <div className="form-grid">
          <TextField label={t('Unit number')} name="unitNumber" required autoComplete="off" />
          <SelectField
            label={t('Product')}
            name="product"
            options={PRODUCTS.map((p) => ({ value: p, label: productLabel(p) }))}
          />
          <SelectField
            label={t('Blood group')}
            name="group"
            options={GROUPS.map((g) => ({ value: `${g.abo}|${g.rhD}`, label: groupLabel(g) }))}
          />
          <TextField
            label={t('Volume (ml)')}
            name="volumeMl"
            type="number"
            min={10}
            max={1000}
            defaultValue={280}
            required
          />
          <TextField label={t('Collected')} name="collectedAt" type="datetime-local" required />
          <TextField label={t('Expires')} name="expiresAt" type="datetime-local" required />
        </div>
        <ErrorAlert error={receive.error} />
        <div className="form-actions">
          <Button type="submit" loading={receive.isPending}>
            {t('Add to stock')}
          </Button>
        </div>
      </form>
      {done.length > 0 && (
        <Alert tone="success" title={t('Added to stock')}>
          <span className="mono">{done.join(', ')}</span>
        </Alert>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------------ reactions ----------------- */

function ReactionsTab() {
  const base = useUser().role === 'NURSE' ? '/nurse' : '/doctor';
  const report = useQuery({
    queryKey: [...BB_KEY, 'reactions'],
    queryFn: () => api<ReactionsReport>('/blood-bank/reactions'),
  });
  return (
    <QueryView query={report}>
      {(r) => (
        <div className="stack">
          <Grid min={160}>
            <Stat label={t('Transfusions')} value={r.transfusions} />
            <Stat
              label={t('Reactions')}
              value={r.items.length}
              tone={r.items.length ? 'warning' : undefined}
            />
          </Grid>
          <Card title={t('Transfusion reactions (haemovigilance)')}>
            {r.items.length === 0 ? (
              <EmptyState title={t('No reactions reported')} />
            ) : (
              <Table caption={t('Transfusion reactions (haemovigilance)')}>
                <thead>
                  <tr>
                    <th>{t('Date')}</th>
                    <th>{t('Patient')}</th>
                    <th>{t('Unit')}</th>
                    <th>{t('Reaction')}</th>
                  </tr>
                </thead>
                <tbody>
                  {r.items.map((i) => (
                    <tr key={i.id}>
                      <td>{formatDateTime(i.issuedAt)}</td>
                      <td>
                        <Link to={`${base}/patients/${i.patientId}?tab=transfusion`}>
                          {i.patientName}
                        </Link>
                      </td>
                      <td>
                        <span className="mono">{i.unitNumber}</span>
                        <div className="muted">{productLabel(i.product)}</div>
                      </td>
                      <td>
                        <Badge tone={i.severity === 'MILD' ? 'warning' : 'danger'}>
                          {reactionTypeLabel(i.type)} · {severityLabel(i.severity)}
                        </Badge>
                        <div className="muted">{i.details}</div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
        </div>
      )}
    </QueryView>
  );
}
