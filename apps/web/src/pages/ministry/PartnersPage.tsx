import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { API_BASE, api } from '../../api/client';
import {
  PARTNER_SCOPES,
  scopeInfo,
  type PartnerClient,
  type PartnerScope,
  type PartnerUsage,
} from '../../api/partner';
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
  Stat,
  Table,
  TextAreaField,
  TextField,
} from '../../components/ui';
import { formatDate, formatDateTime, formatNumber } from '../../format';
import { t, tn } from '../../i18n';

const KEY = ['partner', 'clients'];

/**
 * Ministry: external systems with API access (insurance fund, civil registry, other hospitals,
 * public health). Each gets only the scopes it needs; keys are shown once and can be revoked.
 */
export function PartnersPage() {
  const clients = useQuery({
    queryKey: KEY,
    queryFn: () => api<{ items: PartnerClient[] }>('/partner/clients').then((r) => r.items),
  });
  const [creating, setCreating] = useState(false);
  const [usageFor, setUsageFor] = useState<PartnerClient | null>(null);
  const qc = useQueryClient();
  const revoke = useMutation({
    mutationFn: (id: string) => api(`/partner/clients/${id}/revoke`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });

  return (
    <>
      <PageHeader
        title={t('Partner systems (API)')}
        subtitle={t(
          'External systems never get database access. They call the Pacient API with their own key, only for what their scopes allow; every call is recorded and patients see it in “Who viewed my record”.',
        )}
        actions={
          <span className="row">
            <Link to="/developers">{t('API documentation')}</Link>
            <Button onClick={() => setCreating(true)}>{t('Connect a system')}</Button>
          </span>
        }
      />
      <ErrorAlert error={revoke.error} />
      <Card title={t('Connected systems')}>
        <QueryView query={clients}>
          {(items) =>
            items.length === 0 ? (
              <EmptyState title={t('No partner systems yet')} />
            ) : (
              <Table caption={t('Connected systems')}>
                <thead>
                  <tr>
                    <th>{t('System')}</th>
                    <th>{t('Scopes')}</th>
                    <th>{t('Key')}</th>
                    <th>{t('Status')}</th>
                    <th>{t('Last call')}</th>
                    <th>
                      <span className="sr-only">{t('Actions')}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((c) => (
                    <tr key={c.id}>
                      <td>
                        <strong>{c.name}</strong>
                        <div className="muted">{c.organisation}</div>
                        {c.allowedIps?.length ? (
                          <div className="muted">
                            {t('Only from: {ips}', { ips: c.allowedIps.join(', ') })}
                          </div>
                        ) : null}
                      </td>
                      <td>
                        <div className="stack" style={{ gap: '0.25rem' }}>
                          {c.scopes.map((s) => (
                            <span key={s} title={scopeInfo(s).description}>
                              <Badge tone="info">{scopeInfo(s).title}</Badge>
                            </span>
                          ))}
                        </div>
                      </td>
                      <td>
                        <code className="mono">{c.apiKeyPrefix}…</code>
                      </td>
                      <td>
                        {c.isActive ? (
                          <Badge tone="success">{t('Active')}</Badge>
                        ) : (
                          <Badge tone="neutral">
                            {t('Revoked {date}', { date: formatDate(c.revokedAt) })}
                          </Badge>
                        )}
                      </td>
                      <td>{c.lastSeenAt ? formatDateTime(c.lastSeenAt) : t('Never')}</td>
                      <td>
                        <div className="row" style={{ gap: '0.5rem', flexWrap: 'wrap' }}>
                          <Button size="sm" variant="secondary" onClick={() => setUsageFor(c)}>
                            {t('Usage')}
                          </Button>
                          {c.isActive && (
                            <Button
                              size="sm"
                              variant="secondary"
                              loading={revoke.isPending && revoke.variables === c.id}
                              onClick={() => {
                                if (
                                  window.confirm(
                                    t(
                                      'Revoke the key of {name}? The system stops working immediately.',
                                      {
                                        name: c.name,
                                      },
                                    ),
                                  )
                                )
                                  revoke.mutate(c.id);
                              }}
                            >
                              {t('Revoke')}
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )
          }
        </QueryView>
      </Card>
      {creating && <CreateDialog onClose={() => setCreating(false)} />}
      {usageFor && <UsageDialog client={usageFor} onClose={() => setUsageFor(null)} />}
    </>
  );
}

function CreateDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [scopes, setScopes] = useState<PartnerScope[]>([]);
  const [copied, setCopied] = useState(false);
  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api<PartnerClient & { apiKey: string }>('/partner/clients', { method: 'POST', body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const ips = String(f.get('allowedIps') ?? '')
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    create.mutate({
      name: String(f.get('name') ?? ''),
      organisation: String(f.get('organisation') ?? ''),
      scopes,
      ...(ips.length ? { allowedIps: ips } : {}),
    });
  }

  const created = create.data;
  return (
    <Dialog open onClose={onClose} title={t('Connect a partner system')} wide>
      {created ? (
        <div className="stack">
          <Alert tone="warning" title={t('Copy this key now – it will not be shown again')}>
            {t('Give it to the partner over a secure channel. Only its fingerprint is stored.')}
          </Alert>
          <code className="mono" style={{ wordBreak: 'break-all', fontSize: '0.95rem' }}>
            {created.apiKey}
          </code>
          <div className="form-actions">
            <Button
              variant="secondary"
              onClick={async () => {
                await navigator.clipboard.writeText(created.apiKey);
                setCopied(true);
              }}
            >
              {copied ? `${t('Copied')} ✓` : t('Copy key')}
            </Button>
            <Button onClick={onClose}>{t('Done')}</Button>
          </div>
          <p className="muted">
            {t('The partner calls {url} with the header “Authorization: Bearer <key>”.', {
              url: `${API_BASE}/partner`,
            })}
          </p>
        </div>
      ) : (
        <form onSubmit={onSubmit} className="stack">
          <div className="form-grid">
            <TextField
              label={t('System name')}
              name="name"
              required
              minLength={3}
              maxLength={120}
            />
            <TextField
              label={t('Organisation')}
              name="organisation"
              required
              minLength={3}
              maxLength={200}
            />
          </div>
          <fieldset>
            <legend>{t('What may this system do?')}</legend>
            <div className="stack" style={{ gap: '0.6rem' }}>
              {PARTNER_SCOPES.map((s) => {
                const info = scopeInfo(s);
                return (
                  <label key={s} className="checkbox" style={{ alignItems: 'flex-start' }}>
                    <input
                      type="checkbox"
                      checked={scopes.includes(s)}
                      onChange={(e) =>
                        setScopes((cur) =>
                          e.currentTarget.checked ? [...cur, s] : cur.filter((x) => x !== s),
                        )
                      }
                      style={{ marginTop: '0.3rem' }}
                    />
                    <span>
                      <strong>{info.title}</strong>{' '}
                      <code className="mono muted" style={{ fontSize: '0.8rem' }}>
                        {s}
                      </code>
                      <span className="muted" style={{ display: 'block', fontWeight: 400 }}>
                        {info.description}
                      </span>
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>
          <TextAreaField
            label={t('Allowed IP addresses (optional)')}
            name="allowedIps"
            rows={2}
            hint={t('Separate with commas. Leave empty to allow calls from any address.')}
          />
          <ErrorAlert error={create.error} />
          <div className="form-actions">
            <Button variant="secondary" onClick={onClose}>
              {t('Cancel')}
            </Button>
            <Button type="submit" loading={create.isPending} disabled={!scopes.length}>
              {t('Create key')}
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

function UsageDialog({ client, onClose }: { client: PartnerClient; onClose: () => void }) {
  const usage = useQuery({
    queryKey: ['partner', 'usage', client.id],
    queryFn: () => api<PartnerUsage>(`/partner/clients/${client.id}/usage`),
  });
  return (
    <Dialog open onClose={onClose} title={t('Usage – {name}', { name: client.name })} wide>
      <QueryView query={usage}>
        {(u) => {
          const byDay = new Map<string, { ok: number; refused: number }>();
          for (const d of u.days) {
            const row = byDay.get(d.day) ?? { ok: 0, refused: 0 };
            if (d.outcome === 'SUCCESS') row.ok += d.calls;
            else row.refused += d.calls;
            byDay.set(d.day, row);
          }
          const max = Math.max(1, ...[...byDay.values()].map((r) => r.ok + r.refused));
          return (
            <div className="stack">
              <Grid min={150}>
                <Stat label={t('Calls (30 days)')} value={formatNumber(u.total)} />
                <Stat
                  label={t('Refused')}
                  value={formatNumber(u.denied)}
                  tone={u.denied ? 'warning' : undefined}
                />
                <Stat label={t('Patients accessed')} value={formatNumber(u.distinctPatients)} />
              </Grid>
              {byDay.size === 0 ? (
                <EmptyState title={t('No calls in the last 30 days')} />
              ) : (
                <Table caption={t('Calls per day')}>
                  <thead>
                    <tr>
                      <th>{t('Day')}</th>
                      <th>{t('Calls')}</th>
                      <th>{t('Refused')}</th>
                      <th aria-hidden="true" />
                    </tr>
                  </thead>
                  <tbody>
                    {[...byDay].map(([day, r]) => (
                      <tr key={day}>
                        <td>{formatDate(day)}</td>
                        <td>{formatNumber(r.ok)}</td>
                        <td>{formatNumber(r.refused)}</td>
                        <td aria-hidden="true" style={{ width: '40%' }}>
                          <div
                            style={{
                              height: 8,
                              borderRadius: 4,
                              background: 'var(--primary)',
                              width: `${((r.ok + r.refused) / max) * 100}%`,
                            }}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
              <p className="muted">
                {tn(
                  u.days.length,
                  'Grouped by day, scope and outcome ({count} row).',
                  'Grouped by day, scope and outcome ({count} rows).',
                )}
              </p>
            </div>
          );
        }}
      </QueryView>
    </Dialog>
  );
}
