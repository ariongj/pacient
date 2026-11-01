import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../../api/client';
import type { AuditEntry, Page } from '../../api/types';
import { useUser } from '../../auth/AuthContext';
import {
  Alert,
  Button,
  Card,
  EmptyState,
  formValues,
  PageHeader,
  Pagination,
  QueryView,
  SelectField,
  StatusBadge,
  Table,
  TextField,
} from '../../components/ui';
import { ACTION_LABELS, actionLabel, formatDateTime, humanize } from '../../format';

const EMERGENCY = 'care.emergency_access.granted';
const DENIED = 'patient.record.access_denied';

const ACTION_OPTIONS = Object.entries(ACTION_LABELS)
  .map(([value, label]) => ({ value, label }))
  .sort((a, b) => a.label.localeCompare(b.label));

/** Short, human-readable summary of the event metadata (never clinical content). */
function metadataSummary(meta: Record<string, unknown> | null): string {
  if (!meta) return '—';
  const parts: string[] = [];
  if (typeof meta.reason === 'string') parts.push(`Reason: ${meta.reason}`);
  if (typeof meta.section === 'string') parts.push(`Section: ${meta.section}`);
  if (typeof meta.basis === 'string') parts.push(`Basis: ${humanize(meta.basis)}`);
  if (typeof meta.role === 'string') parts.push(`Role: ${humanize(meta.role)}`);
  if (typeof meta.status === 'string') parts.push(`Status: ${humanize(meta.status)}`);
  if (typeof meta.from === 'string' && typeof meta.to === 'string') {
    parts.push(`${humanize(meta.from)} → ${humanize(meta.to)}`);
  }
  if (Array.isArray(meta.fields)) parts.push(`Fields: ${meta.fields.join(', ')}`);
  if (typeof meta.resultCount === 'number') parts.push(`Results: ${meta.resultCount}`);
  return parts.length ? parts.join(' · ') : '—';
}

/** Converts a yyyy-mm-dd date input to an ISO datetime at the start or end of that day (UTC). */
function toIso(date: string | undefined, endOfDay: boolean): string | undefined {
  if (!date) return undefined;
  return new Date(`${date}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`).toISOString();
}

export function AuditLogPage() {
  const user = useUser();
  const [params, setParams] = useSearchParams();
  const action = params.get('action') ?? '';
  const from = params.get('from') ?? '';
  const to = params.get('to') ?? '';
  const [page, setPage] = useState(1);

  const query = useQuery({
    queryKey: ['audit', { action, from, to }, page],
    queryFn: () =>
      api<Page<AuditEntry>>('/audit-logs', {
        query: { action, from: toIso(from, false), to: toIso(to, true), page, pageSize: 25 },
      }),
  });

  function applyFilters(next: { action?: string; from?: string; to?: string }) {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(next)) if (v) p.set(k, v);
    setParams(p);
    setPage(1);
  }

  return (
    <>
      <PageHeader
        title="Audit review"
        subtitle={
          user.role === 'DIRECTOR'
            ? `Activity by staff of ${user.facility?.name ?? 'your facility'}`
            : 'All security and record-access events across the network'
        }
      />
      <Alert tone="info">
        The audit trail is append-only. Review emergency (break-glass) access and denied access
        attempts regularly.
      </Alert>
      <Card>
        <div className="row" style={{ marginBottom: '0.75rem' }}>
          <Button
            size="sm"
            variant={action === EMERGENCY ? 'primary' : 'secondary'}
            aria-pressed={action === EMERGENCY}
            onClick={() =>
              applyFilters({ action: action === EMERGENCY ? '' : EMERGENCY, from, to })
            }
          >
            Emergency access
          </Button>
          <Button
            size="sm"
            variant={action === DENIED ? 'primary' : 'secondary'}
            aria-pressed={action === DENIED}
            onClick={() => applyFilters({ action: action === DENIED ? '' : DENIED, from, to })}
          >
            Denied access
          </Button>
          {(action || from || to) && (
            <Button size="sm" variant="ghost" onClick={() => applyFilters({})}>
              Clear filters
            </Button>
          )}
        </div>
        <form
          key={`${action}|${from}|${to}`}
          className="search-bar"
          role="search"
          onSubmit={(e) => {
            e.preventDefault();
            const v = formValues(e.currentTarget);
            applyFilters({ action: v.action, from: v.from, to: v.to });
          }}
        >
          <SelectField
            label="Event"
            name="action"
            placeholder="All events"
            options={ACTION_OPTIONS}
            defaultValue={action}
          />
          <TextField label="From" name="from" type="date" defaultValue={from} />
          <TextField label="To" name="to" type="date" defaultValue={to} />
          <Button type="submit" variant="secondary">
            Apply
          </Button>
        </form>
        <QueryView query={query}>
          {(data) =>
            data.items.length === 0 ? (
              <EmptyState title="No audit events match these filters" />
            ) : (
              <>
                <p className="muted">{data.total} events</p>
                <Table caption="Audit events, newest first">
                  <thead>
                    <tr>
                      <th scope="col">Time</th>
                      <th scope="col">Actor</th>
                      <th scope="col">Event</th>
                      <th scope="col">Outcome</th>
                      <th scope="col">Resource</th>
                      <th scope="col">Patient</th>
                      <th scope="col">IP</th>
                      <th scope="col">Details</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.items.map((e) => (
                      <tr key={e.id}>
                        <td>{formatDateTime(e.occurredAt)}</td>
                        <td>
                          {e.actorName ?? <span className="muted">Unknown / anonymous</span>}
                          {e.actorRole && <div className="muted">{humanize(e.actorRole)}</div>}
                        </td>
                        <td>{actionLabel(e.action)}</td>
                        <td>
                          <StatusBadge value={e.outcome} />
                        </td>
                        <td>{e.resourceType ? humanize(e.resourceType) : '—'}</td>
                        <td>
                          {e.patientId ? (
                            <code title={e.patientId}>{e.patientId.slice(0, 8)}</code>
                          ) : (
                            '—'
                          )}
                        </td>
                        <td>{e.ipAddress ?? '—'}</td>
                        <td>{metadataSummary(e.metadata)}</td>
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
    </>
  );
}
