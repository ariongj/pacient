import {
  arrivalModeLabel,
  edStatusLabel,
  formatMinutes,
  TRIAGE,
  useEdHistory,
  type EdHistoryItem,
} from '../../../api/ed';
import { Badge, Card, EmptyState, QueryView, Table } from '../../../components/ui';
import { formatDateTime } from '../../../format';
import { t } from '../../../i18n';
import '../../ed/ed.css';

const minutes = (from: string, to: string | null) =>
  to ? Math.max(0, Math.round((new Date(to).getTime() - new Date(from).getTime()) / 60_000)) : null;

function Level({ v }: { v: EdHistoryItem }) {
  if (!v.triageLevel) return <span className="muted">{t('Not triaged')}</span>;
  return (
    <span className={`ed-level ed-level-${v.triageLevel}`}>
      <span className="ed-dot" aria-hidden="true" />
      {t('{level} · {name}', { level: v.triageLevel, name: TRIAGE[v.triageLevel].name() })}
    </span>
  );
}

/** The patient's emergency department attendances: triage, waiting time and outcome. */
export function EmergencyTab({ patientId }: { patientId: string }) {
  const visits = useEdHistory(patientId);
  return (
    <Card title={t('Emergency department visits')}>
      <QueryView query={visits}>
        {(items) =>
          items.length === 0 ? (
            <EmptyState title={t('No emergency visits')} />
          ) : (
            <div className="ed">
              <Table caption={t('Emergency department visits')}>
                <thead>
                  <tr>
                    <th>{t('Arrived')}</th>
                    <th>{t('Main complaint')}</th>
                    <th>{t('Triage')}</th>
                    <th>{t('Seen after')}</th>
                    <th>{t('Outcome')}</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((v) => {
                    const wait = minutes(v.arrivedAt, v.seenAt);
                    return (
                      <tr key={v.id}>
                        <td>
                          {formatDateTime(v.arrivedAt)}
                          <div className="muted">
                            {arrivalModeLabel(v.arrivalMode)} · {v.facilityName}
                          </div>
                        </td>
                        <td>
                          {v.chiefComplaint}
                          {v.triageNote && <div className="muted">{v.triageNote}</div>}
                        </td>
                        <td>
                          <Level v={v} />
                          {v.triagedBy && <div className="muted">{v.triagedBy}</div>}
                        </td>
                        <td>
                          {wait === null ? '—' : formatMinutes(wait)}
                          {v.assignedDoctor && <div className="muted">{v.assignedDoctor}</div>}
                        </td>
                        <td>
                          <Badge
                            tone={
                              v.status === 'WAITING' || v.status === 'IN_TREATMENT'
                                ? 'info'
                                : v.status === 'LEFT_WITHOUT_BEING_SEEN'
                                  ? 'warning'
                                  : 'neutral'
                            }
                          >
                            {edStatusLabel(v.status)}
                          </Badge>
                          {v.departedAt && (
                            <div className="muted">{formatDateTime(v.departedAt)}</div>
                          )}
                          {v.dispositionNote && <div className="muted">{v.dispositionNote}</div>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </Table>
            </div>
          )
        }
      </QueryView>
    </Card>
  );
}
