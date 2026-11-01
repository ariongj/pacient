import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../../api/client';
import type { Appointment, Worklist } from '../../api/types';
import { useUser } from '../../auth/AuthContext';
import {
  Button,
  Card,
  EmptyState,
  ErrorAlert,
  Grid,
  PageHeader,
  QueryView,
  Stat,
  StatusBadge,
  Table,
} from '../../components/ui';
import { formatDate, formatDateTime, formatTime, humanize } from '../../format';

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

export function DoctorHome() {
  const user = useUser();
  const qc = useQueryClient();
  const worklist = useQuery({ queryKey: ['worklist'], queryFn: () => api<Worklist>('/worklist') });
  const from = startOfToday();
  const appointments = useQuery({
    queryKey: ['appointments', 'upcoming', from],
    queryFn: () => api<{ items: Appointment[] }>('/appointments', { query: { from } }),
  });

  const acknowledge = useMutation({
    mutationFn: ({ patientId, id }: { patientId: string; id: string }) =>
      api(`/patients/${patientId}/lab-results/${id}/acknowledge`, { method: 'POST' }),
    onSuccess: (_d, v) => {
      void qc.invalidateQueries({ queryKey: ['worklist'] });
      void qc.invalidateQueries({ queryKey: ['patient', v.patientId] });
    },
  });

  const upcoming = (appointments.data?.items ?? []).filter(
    (a) => a.status === 'CONFIRMED' || a.status === 'REQUESTED',
  );
  const todayKey = new Date().toDateString();
  const today = upcoming.filter((a) => new Date(a.scheduledAt).toDateString() === todayKey);

  return (
    <>
      <PageHeader
        title="Worklist"
        subtitle={`Good day, ${user.fullName}. Follow-up stays here until it is explicitly closed.`}
      />
      <QueryView query={worklist}>
        {(w) => (
          <div className="stack">
            <Grid min={180}>
              <Stat
                label="Results to review"
                value={w.unacknowledgedResults.length}
                tone={
                  w.unacknowledgedResults.some((r) => r.flag === 'CRITICAL')
                    ? 'danger'
                    : w.unacknowledgedResults.length
                      ? 'warning'
                      : 'success'
                }
                hint={
                  w.unacknowledgedResults.some((r) => r.flag === 'CRITICAL')
                    ? 'Includes critical results'
                    : undefined
                }
              />
              <Stat
                label="Correction requests"
                value={w.openCorrectionRequests.length}
                tone={w.openCorrectionRequests.length ? 'warning' : 'success'}
              />
              <Stat
                label="Notes awaiting signature"
                value={w.draftNotes.length}
                tone={w.draftNotes.length ? 'warning' : 'success'}
              />
              <Stat label="Appointments today" value={today.length} tone="info" />
            </Grid>

            <Card title="Results awaiting review">
              <ErrorAlert error={acknowledge.error} />
              {w.unacknowledgedResults.length === 0 ? (
                <EmptyState title="No results waiting">
                  All results you ordered have been reviewed.
                </EmptyState>
              ) : (
                <Table caption="Results awaiting review">
                  <thead>
                    <tr>
                      <th>Patient</th>
                      <th>Test</th>
                      <th>Value</th>
                      <th>Flag</th>
                      <th>Status</th>
                      <th>Collected</th>
                      <th>
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {w.unacknowledgedResults.map((r) => (
                      <tr key={r.id}>
                        <td>
                          <Link to={`/doctor/patients/${r.patientId}?tab=results`}>
                            {r.patientName}
                          </Link>
                        </td>
                        <td>{r.testName}</td>
                        <td>
                          {r.value} {r.unit ?? ''}
                        </td>
                        <td>
                          <StatusBadge value={r.flag} />
                        </td>
                        <td>
                          <StatusBadge value={r.status} />
                        </td>
                        <td>{formatDateTime(r.collectedAt)}</td>
                        <td>
                          <Button
                            size="sm"
                            variant="secondary"
                            loading={acknowledge.isPending && acknowledge.variables?.id === r.id}
                            onClick={() => acknowledge.mutate({ patientId: r.patientId, id: r.id })}
                          >
                            Acknowledge
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </Card>

            <div className="two-col">
              <Card title="Open correction requests">
                {w.openCorrectionRequests.length === 0 ? (
                  <EmptyState title="No open requests" />
                ) : (
                  <ul className="list">
                    {w.openCorrectionRequests.map((c) => (
                      <li key={c.id}>
                        <div className="row-between">
                          <Link to={`/doctor/patients/${c.patientId}?tab=corrections`}>
                            {c.patientName}
                          </Link>
                          <span className="muted">{formatDate(c.createdAt)}</span>
                        </div>
                        <div className="muted">Section: {humanize(c.section)}</div>
                        <div>{c.description}</div>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
              <Card title="Draft notes awaiting signature">
                {w.draftNotes.length === 0 ? (
                  <EmptyState title="All notes signed" />
                ) : (
                  <ul className="list">
                    {w.draftNotes.map((n) => (
                      <li key={n.id}>
                        <div className="row-between">
                          <Link to={`/doctor/patients/${n.patientId}?tab=visits`}>
                            {n.patientName}
                          </Link>
                          <span className="muted">{formatDate(n.startedAt)}</span>
                        </div>
                        <div className="muted">
                          {humanize(n.type)} · {n.reason}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </div>
          </div>
        )}
      </QueryView>

      <div style={{ marginTop: '1rem' }}>
        <Card
          title="Upcoming appointments"
          actions={<Link to="/doctor/schedule">Full schedule</Link>}
        >
          <QueryView query={appointments}>
            {() =>
              upcoming.length === 0 ? (
                <EmptyState title="No upcoming appointments" />
              ) : (
                <ul className="list">
                  {upcoming.slice(0, 8).map((a) => (
                    <li key={a.id} className="row-between">
                      <span>
                        <strong>
                          {formatDate(a.scheduledAt)} {formatTime(a.scheduledAt)}
                        </strong>{' '}
                        · <Link to={`/doctor/patients/${a.patientId}`}>{a.patientName}</Link> ·{' '}
                        {a.reason}
                      </span>
                      <StatusBadge value={a.status} />
                    </li>
                  ))}
                </ul>
              )
            }
          </QueryView>
        </Card>
      </div>
    </>
  );
}
