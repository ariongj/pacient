import type { ReactNode } from 'react';
import { arrivalModeLabel, edStatusLabel, useEdHistory } from '../../api/ed';
import { useAuth } from '../../auth/AuthContext';
import {
  Badge,
  Card,
  DefinitionList,
  EmptyState,
  PageHeader,
  QueryView,
} from '../../components/ui';
import { formatDateTime } from '../../format';
import { t } from '../../i18n';
import { usePatientId } from './shared';

/**
 * The patient's visits to an emergency department: why they came, who treated them, how it ended
 * and the advice they were given to take home (e.g. when to have stitches removed).
 */
export function PortalEmergency() {
  const { acting } = useAuth();
  const visits = useEdHistory(usePatientId());
  return (
    <>
      <PageHeader
        title={t('Emergency visits')}
        subtitle={
          acting
            ? t('Emergency department visits of your family member and the advice given.')
            : t('Your emergency department visits, how they ended and the advice you were given.')
        }
      />
      <QueryView query={visits}>
        {(items) =>
          items.length === 0 ? (
            <EmptyState title={t('No emergency visits')}>
              {t('If you are seen in an emergency department, the visit appears here.')}
            </EmptyState>
          ) : (
            <div className="stack">
              {items.map((v) => {
                const open = v.status === 'WAITING' || v.status === 'IN_TREATMENT';
                const details: [string, ReactNode][] = [
                  [t('Where'), v.facilityName],
                  [t('Reason'), v.chiefComplaint],
                  [t('Arrival'), arrivalModeLabel(v.arrivalMode)],
                  [t('Treating doctor'), v.assignedDoctor ?? '—'],
                ];
                if (v.departedAt) {
                  details.push([t('Left the department'), formatDateTime(v.departedAt)]);
                }
                return (
                  <Card
                    key={v.id}
                    title={
                      <>
                        {formatDateTime(v.arrivedAt)}{' '}
                        <Badge tone={open ? 'info' : 'neutral'}>{edStatusLabel(v.status)}</Badge>
                      </>
                    }
                  >
                    <DefinitionList items={details} />
                    {v.dispositionNote && (
                      <div className="note" style={{ marginTop: '0.75rem' }}>
                        <strong>{t('Advice from the emergency department')}</strong>
                        <p style={{ margin: '0.25rem 0 0', whiteSpace: 'pre-wrap' }}>
                          {v.dispositionNote}
                        </p>
                      </div>
                    )}
                  </Card>
                );
              })}
            </div>
          )
        }
      </QueryView>
    </>
  );
}
