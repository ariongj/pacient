import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../../api/client';
import {
  dispositionLabel,
  sourceLabel,
  useHospitalMutation,
  usePatientStays,
  type Stay,
} from '../../../api/hospital';
import {
  Badge,
  Button,
  Card,
  DefinitionList,
  EmptyState,
  ErrorAlert,
  QueryView,
  StatusBadge,
} from '../../../components/ui';
import { formatDate, formatDateTime } from '../../../format';
import { t } from '../../../i18n';
import { AdmitDialog, DischargeDialog, TransferDialog } from '../../hospital/dialogs';
import '../../hospital/hospital.css';
import { useChartRole } from './shared';

function StayCard({ stay, isDoctor }: { stay: Stay; isDoctor: boolean }) {
  const [dialog, setDialog] = useState<'transfer' | 'discharge' | null>(null);
  const [showSummary, setShowSummary] = useState(false);
  const release = useHospitalMutation(
    () => api(`/hospital/admissions/${stay.id}/release`, { method: 'POST' }),
    { patientId: stay.patientId },
  );
  const current = stay.status === 'ADMITTED';
  return (
    <Card
      title={
        <>
          {stay.unitName}
          {stay.bedLabel ? ` · ${t('Bed {label}', { label: stay.bedLabel })}` : ''}{' '}
          <StatusBadge value={stay.status} />
        </>
      }
      actions={
        <>
          {current && (
            <Button size="sm" variant="secondary" onClick={() => setDialog('transfer')}>
              {t('Transfer')}
            </Button>
          )}
          {current && isDoctor && (
            <Button size="sm" onClick={() => setDialog('discharge')}>
              {t('Discharge')}
            </Button>
          )}
          {stay.summarySigned && !stay.releasedToPatientAt && isDoctor && (
            <Button
              size="sm"
              variant="secondary"
              loading={release.isPending}
              onClick={() => release.mutate(undefined)}
            >
              {t('Release letter to patient')}
            </Button>
          )}
        </>
      }
    >
      <DefinitionList
        items={[
          [t('Admitted'), `${formatDateTime(stay.admittedAt)} · ${sourceLabel(stay.source)}`],
          [t('Reason for admission'), stay.reason],
          [t('Attending doctor'), stay.attendingDoctorName],
          ...(current && stay.expectedDischargeAt
            ? ([[t('Expected discharge'), formatDate(stay.expectedDischargeAt)]] as [
                string,
                string,
              ][])
            : []),
          ...(stay.dischargedAt
            ? ([
                [
                  t('Discharged'),
                  [
                    formatDateTime(stay.dischargedAt),
                    stay.disposition ? dispositionLabel(stay.disposition) : null,
                    stay.dischargedByName,
                  ]
                    .filter(Boolean)
                    .join(' · '),
                ],
              ] as [string, string][])
            : []),
        ]}
      />
      {stay.movements.length > 1 && (
        <details>
          <summary>
            {t('Bed and ward movements ({count})', { count: stay.movements.length })}
          </summary>
          <ol className="list">
            {stay.movements.map((m) => (
              <li key={m.id}>
                {formatDateTime(m.movedAt)} ·{' '}
                {m.fromUnitName
                  ? t('{from} → {to}', {
                      from: `${m.fromUnitName}${m.fromBedLabel ? ` ${m.fromBedLabel}` : ''}`,
                      to: `${m.toUnitName}${m.toBedLabel ? ` ${m.toBedLabel}` : ''}`,
                    })
                  : `${m.toUnitName}${m.toBedLabel ? ` ${m.toBedLabel}` : ''}`}
                {m.reason ? <span className="muted"> – {m.reason}</span> : null}
              </li>
            ))}
          </ol>
        </details>
      )}
      {stay.dischargeSummary && (
        <div className="stack" style={{ gap: '0.5rem', marginTop: '0.75rem' }}>
          <div className="row-between no-print">
            <span>
              {stay.summarySigned ? (
                <Badge tone="success">
                  {t('Summary signed {date}', { date: formatDateTime(stay.dischargeSignedAt) })}
                </Badge>
              ) : (
                <Badge tone="warning">{t('Draft summary')}</Badge>
              )}{' '}
              {stay.releasedToPatientAt && <Badge tone="info">{t('Released to patient')}</Badge>}
            </span>
            <span className="row" style={{ gap: '0.35rem' }}>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setShowSummary((v) => !v)}
                aria-expanded={showSummary}
              >
                {showSummary ? t('Hide summary') : t('Show summary')}
              </Button>
              {showSummary && (
                <Button size="sm" variant="ghost" onClick={() => window.print()}>
                  {t('Print')}
                </Button>
              )}
            </span>
          </div>
          {showSummary && <pre className="summary-text">{stay.dischargeSummary}</pre>}
        </div>
      )}
      <ErrorAlert error={release.error} />
      {dialog === 'transfer' && (
        <TransferDialog
          open
          onClose={() => setDialog(null)}
          admissionId={stay.id}
          patientId={stay.patientId}
          currentBedId={stay.bedId}
        />
      )}
      {dialog === 'discharge' && (
        <DischargeDialog
          open
          onClose={() => setDialog(null)}
          admissionId={stay.id}
          patientId={stay.patientId}
        />
      )}
    </Card>
  );
}

/** Hospital stays of the patient: current admission, movements, discharge letters. */
export function AdmissionsTab({ patientId }: { patientId: string }) {
  const { isDoctor } = useChartRole();
  const stays = usePatientStays(patientId);
  const demographics = useQuery({
    queryKey: ['patient', patientId, 'demographics'],
    queryFn: () =>
      api<{ id: string; firstName: string; lastName: string }>(`/patients/${patientId}`),
  });
  const [admitting, setAdmitting] = useState(false);
  return (
    <div className="stack">
      <QueryView query={stays}>
        {(items) => {
          const current = items.some((s) => s.status === 'ADMITTED');
          return (
            <>
              {isDoctor && !current && (
                <div className="row-between">
                  <span className="muted">{t('The patient is not currently admitted.')}</span>
                  <Button onClick={() => setAdmitting(true)} disabled={!demographics.data}>
                    {t('Admit to hospital')}
                  </Button>
                </div>
              )}
              {items.length === 0 ? (
                <EmptyState title={t('No hospital stays')} />
              ) : (
                items.map((s) => <StayCard key={s.id} stay={s} isDoctor={isDoctor} />)
              )}
            </>
          );
        }}
      </QueryView>
      {isDoctor && demographics.data && (
        <AdmitDialog
          open={admitting}
          onClose={() => setAdmitting(false)}
          preset={{ patient: demographics.data }}
        />
      )}
    </div>
  );
}
