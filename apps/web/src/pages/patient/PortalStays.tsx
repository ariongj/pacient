import { useState } from 'react';
import { dispositionLabel, usePatientStays } from '../../api/hospital';
import { useAuth } from '../../auth/AuthContext';
import {
  Badge,
  Button,
  Card,
  DefinitionList,
  EmptyState,
  PageHeader,
  QueryView,
} from '../../components/ui';
import { formatDate, formatDateTime } from '../../format';
import { t } from '../../i18n';
import '../hospital/hospital.css';
import { usePatientId } from './shared';

/** The patient's hospital stays and the discharge letters the doctor released. */
export function PortalStays() {
  const { acting } = useAuth();
  const patientId = usePatientId();
  const stays = usePatientStays(patientId);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <>
      <PageHeader
        title={t('Hospital stays')}
        subtitle={
          acting
            ? t('Hospital stays of your family member and their discharge letters.')
            : t(
                'Your hospital stays and discharge letters. A letter appears here once your doctor has released it.',
              )
        }
      />
      <QueryView query={stays}>
        {(items) =>
          items.length === 0 ? (
            <EmptyState title={t('No hospital stays')}>
              {t('When you are admitted to hospital, your stay appears here.')}
            </EmptyState>
          ) : (
            <div className="stack">
              {items.map((s) => (
                <Card
                  key={s.id}
                  title={
                    <>
                      {s.unitName}{' '}
                      {s.status === 'ADMITTED' ? (
                        <Badge tone="info">{t('Currently admitted')}</Badge>
                      ) : (
                        <Badge tone="neutral">{t('Discharged')}</Badge>
                      )}
                    </>
                  }
                  actions={
                    s.dischargeSummary ? (
                      <span className="row no-print" style={{ gap: '0.35rem' }}>
                        <Button
                          size="sm"
                          variant="secondary"
                          aria-expanded={open === s.id}
                          onClick={() => setOpen(open === s.id ? null : s.id)}
                        >
                          {open === s.id ? t('Hide letter') : t('Read discharge letter')}
                        </Button>
                        {open === s.id && (
                          <Button size="sm" variant="ghost" onClick={() => window.print()}>
                            {t('Print')}
                          </Button>
                        )}
                      </span>
                    ) : undefined
                  }
                >
                  <DefinitionList
                    items={[
                      [t('Admitted'), formatDateTime(s.admittedAt)],
                      [t('Reason'), s.reason],
                      [t('Doctor'), s.attendingDoctorName],
                      ...(s.dischargedAt
                        ? ([
                            [
                              t('Discharged'),
                              `${formatDate(s.dischargedAt)}${s.disposition ? ` · ${dispositionLabel(s.disposition)}` : ''}`,
                            ],
                          ] as [string, string][])
                        : []),
                    ]}
                  />
                  {s.dischargedAt && !s.dischargeSummary && (
                    <p className="muted">{t('Your discharge letter has not been released yet.')}</p>
                  )}
                  {open === s.id && s.dischargeSummary && (
                    <pre className="summary-text">{s.dischargeSummary}</pre>
                  )}
                </Card>
              ))}
            </div>
          )
        }
      </QueryView>
    </>
  );
}
