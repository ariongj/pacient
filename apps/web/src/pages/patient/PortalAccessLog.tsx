import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../api/client';
import type { AccessLogEntry, Page } from '../../api/types';
import {
  Alert,
  Badge,
  Card,
  EmptyState,
  PageHeader,
  Pagination,
  QueryView,
  Table,
} from '../../components/ui';
import { actionLabel, formatDateTime, humanize } from '../../format';

const BASIS_TEXT: Record<string, string> = {
  CARE_TEAM: 'Member of your care team',
  EMERGENCY: 'Emergency access',
};

/**
 * Transparency for patients: every access to, or change of, their record by someone else.
 */
export function PortalAccessLog() {
  const [page, setPage] = useState(1);
  const q = useQuery({
    queryKey: ['portal', 'access-log', page],
    queryFn: () =>
      api<Page<AccessLogEntry>>('/portal/access-log', { query: { page, pageSize: 25 } }),
  });
  return (
    <>
      <PageHeader
        title="Who viewed my record"
        subtitle="Every time a health professional opens or changes your record, it is logged here."
      />
      <Alert tone="info">
        Doctors can open your record when they are part of your care team. In an emergency, a doctor
        at your facility may use <strong>emergency access</strong>: they must give a reason, access
        expires automatically, and it is reviewed by the facility director. If you see access you do
        not recognise, contact your facility or the Ministry of Health.
      </Alert>
      <Card>
        <QueryView query={q}>
          {(d) =>
            d.items.length ? (
              <>
                <Table caption="Access to your health record">
                  <thead>
                    <tr>
                      <th>When</th>
                      <th>Who</th>
                      <th>What</th>
                      <th>Why</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.items.map((e) => (
                      <tr key={e.id}>
                        <td>{formatDateTime(e.occurredAt)}</td>
                        <td>
                          <strong>{e.actorName ?? 'System'}</strong>
                          <div className="muted">
                            {[
                              e.actorSpecialty ?? (e.actorRole ? humanize(e.actorRole) : null),
                              e.facilityName,
                            ]
                              .filter(Boolean)
                              .join(' · ')}
                          </div>
                        </td>
                        <td>
                          {actionLabel(e.action)}
                          {e.section && <div className="muted">Section: {humanize(e.section)}</div>}
                        </td>
                        <td>
                          {e.action === 'care.emergency_access.granted' ||
                          e.basis === 'EMERGENCY' ? (
                            <Badge tone="danger">Emergency access</Badge>
                          ) : e.basis ? (
                            <Badge tone="info">{BASIS_TEXT[e.basis] ?? humanize(e.basis)}</Badge>
                          ) : (
                            '—'
                          )}
                          {e.emergencyReason && (
                            <div className="muted">Reason: “{e.emergencyReason}”</div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
                <Pagination page={d.page} totalPages={d.totalPages} onChange={setPage} />
              </>
            ) : (
              <EmptyState title="Nobody else has accessed your record yet" />
            )
          }
        </QueryView>
      </Card>
    </>
  );
}
