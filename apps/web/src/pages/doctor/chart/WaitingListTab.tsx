import { useState } from 'react';
import { specialtyLabel, usePatientWaiting } from '../../../api/waiting';
import { useUser } from '../../../auth/AuthContext';
import { Button, Card, EmptyState, QueryView, Table } from '../../../components/ui';
import { formatDate, formatDateTime } from '../../../format';
import { t } from '../../../i18n';
import {
  AddToWaitingListDialog,
  PriorityBadge,
  WaitBadge,
  WaitingEntryDialog,
  WaitingStatusBadge,
} from '../../waiting/WaitingComponents';

/** The patient's waiting-list entries (all facilities for the care team) and adding new ones. */
export function WaitingListTab({ patientId }: { patientId: string }) {
  const user = useUser();
  const entries = usePatientWaiting(patientId);
  const [adding, setAdding] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  return (
    <Card
      title={t('Waiting lists')}
      actions={
        user.role === 'DOCTOR' && (
          <Button size="sm" onClick={() => setAdding(true)}>
            {t('Add to a waiting list')}
          </Button>
        )
      }
    >
      <QueryView query={entries}>
        {(items) =>
          items.length === 0 ? (
            <EmptyState title={t('Not on any waiting list')} />
          ) : (
            <Table caption={t('Waiting lists')}>
              <thead>
                <tr>
                  <th>{t('Procedure')}</th>
                  <th>{t('Facility')}</th>
                  <th>{t('Priority')}</th>
                  <th>{t('Added')}</th>
                  <th>{t('Waiting time')}</th>
                  <th>{t('Target date')}</th>
                  <th>{t('Status')}</th>
                  <th>
                    <span className="sr-only">{t('Actions')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((e) => (
                  <tr key={e.id}>
                    <td>
                      {e.procedureName}
                      <div className="muted">{specialtyLabel(e.specialty)}</div>
                      {e.clinicalReason && <div className="muted">{e.clinicalReason}</div>}
                    </td>
                    <td>{e.facilityName}</td>
                    <td>
                      <PriorityBadge priority={e.priority} />
                    </td>
                    <td>
                      {formatDate(e.addedAt)}
                      {e.addedByName && <div className="muted">{e.addedByName}</div>}
                    </td>
                    <td>
                      {['WAITING', 'SCHEDULED', 'SUSPENDED'].includes(e.status) ? (
                        <WaitBadge e={e} />
                      ) : (
                        t('{days} days', { days: e.waitingDays })
                      )}
                    </td>
                    <td>{formatDate(e.targetDate)}</td>
                    <td>
                      <WaitingStatusBadge status={e.status} />
                      {e.scheduledFor && (
                        <div className="muted">{formatDateTime(e.scheduledFor)}</div>
                      )}
                    </td>
                    <td>
                      {e.facilityId === user.facility?.id &&
                        (user.role === 'DOCTOR' ||
                          user.role === 'RECEPTION' ||
                          user.role === 'DIRECTOR') && (
                          <Button size="sm" variant="secondary" onClick={() => setOpenId(e.id)}>
                            {t('Open|action')}
                          </Button>
                        )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )
        }
      </QueryView>
      <AddToWaitingListDialog
        patientId={patientId}
        open={adding}
        onClose={() => setAdding(false)}
      />
      <WaitingEntryDialog id={openId} onClose={() => setOpenId(null)} />
    </Card>
  );
}
