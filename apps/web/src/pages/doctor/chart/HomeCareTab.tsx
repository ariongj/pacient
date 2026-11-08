import { useState } from 'react';
import { usePatientHomeCare } from '../../../api/homecare';
import { Button, Card, EmptyState, QueryView, Table } from '../../../components/ui';
import { formatDate, formatDateTime } from '../../../format';
import { t } from '../../../i18n';
import {
  EpisodeDialog,
  EpisodeStatusBadge,
  ReferDialog,
  taskList,
} from '../../homecare/HomeCareComponents';

/**
 * The patient's home care: referrals to community nursing teams, their care plans and visits.
 * Integration point for hospital discharge: the "Refer at discharge" action opens the same referral
 * (the discharge flow itself is unchanged).
 */
export function HomeCareTab({ patientId }: { patientId: string }) {
  const query = usePatientHomeCare(patientId);
  const [referring, setReferring] = useState<false | 'normal' | 'discharge'>(false);
  const [openId, setOpenId] = useState<string | null>(null);
  return (
    <QueryView query={query}>
      {(data) => (
        <Card
          title={t('Home care')}
          actions={
            data.canRefer && (
              <span style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                <Button size="sm" onClick={() => setReferring('normal')}>
                  {t('Refer to home care')}
                </Button>
                <Button size="sm" variant="secondary" onClick={() => setReferring('discharge')}>
                  {t('Refer at discharge')}
                </Button>
              </span>
            )
          }
        >
          {data.items.length === 0 ? (
            <EmptyState title={t('No home care')}>
              {t('Refer the patient to a community nursing team for visits at home.')}
            </EmptyState>
          ) : (
            <Table caption={t('Home care')}>
              <thead>
                <tr>
                  <th>{t('Team')}</th>
                  <th>{t('Reason for referral')}</th>
                  <th>{t('Needs')}</th>
                  <th>{t('Status')}</th>
                  <th>{t('Next visit')}</th>
                  <th>
                    <span className="sr-only">{t('Actions')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((e) => {
                  const next = e.visits
                    .filter((v) => v.status === 'PLANNED')
                    .sort((a, b) => a.scheduledFor.localeCompare(b.scheduledFor))[0];
                  return (
                    <tr key={e.id}>
                      <td>
                        {e.teamName}
                        <div className="muted">{e.teamFacilityName}</div>
                      </td>
                      <td>
                        {e.reason}
                        <div className="muted">
                          {e.referredBy} · {formatDate(e.createdAt)}
                        </div>
                      </td>
                      <td>{taskList(e.carePlan.tasks)}</td>
                      <td>
                        <EpisodeStatusBadge status={e.status} />
                        {e.endedAt && <div className="muted">{formatDate(e.endedAt)}</div>}
                      </td>
                      <td>{next ? formatDateTime(next.scheduledFor) : '—'}</td>
                      <td>
                        <Button size="sm" variant="secondary" onClick={() => setOpenId(e.id)}>
                          {t('Open|action')}
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          )}
          <ReferDialog
            patientId={patientId}
            defaultAddress={data.defaultAddress}
            open={Boolean(referring)}
            fromDischarge={referring === 'discharge'}
            onClose={() => setReferring(false)}
          />
          <EpisodeDialog id={openId} onClose={() => setOpenId(null)} />
        </Card>
      )}
    </QueryView>
  );
}
