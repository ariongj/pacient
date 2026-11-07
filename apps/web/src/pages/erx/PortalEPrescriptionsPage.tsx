import { ACTIVE_STATUSES, usePatientEPrescriptions, type EPrescription } from '../../api/erx';
import { useAuth } from '../../auth/AuthContext';
import { Card, EmptyState, PageHeader, QueryView } from '../../components/ui';
import { formatDate } from '../../format';
import { t } from '../../i18n';
import { CodeQr, CodeText, DispensingTable, ErxSummary } from './ErxComponents';

/** The patient's (or child's) e-prescriptions: the code to show at any pharmacy, and history. */
export function PortalEPrescriptionsPage() {
  const { user, acting } = useAuth();
  const patientId = acting?.patientId ?? user?.patientId ?? null;
  const list = usePatientEPrescriptions(patientId);
  return (
    <>
      <PageHeader
        title={
          acting
            ? t('E-prescriptions – {name}', { name: acting.firstName })
            : t('My e-prescriptions')
        }
        subtitle={t(
          'Take the code (or show the QR code) to any pharmacy together with your national ID card. The pharmacy sees only the medicine, how to take it and your allergies – never your diagnoses.',
        )}
      />
      <QueryView query={list}>
        {(items) => {
          const active = items.filter((e) => ACTIVE_STATUSES.includes(e.status));
          const past = items.filter((e) => !ACTIVE_STATUSES.includes(e.status));
          return (
            <>
              <Card title={t('Ready at the pharmacy')}>
                {active.length === 0 ? (
                  <EmptyState title={t('No e-prescriptions to collect')} />
                ) : (
                  <div className="stack">
                    {active.map((e) => (
                      <ActiveEPrescription key={e.prescriptionId} e={e} />
                    ))}
                  </div>
                )}
              </Card>
              <Card title={t('Earlier e-prescriptions')}>
                {past.length === 0 ? (
                  <EmptyState title={t('No earlier e-prescriptions')} />
                ) : (
                  <ul className="list">
                    {past.map((e) => (
                      <li key={e.prescriptionId}>
                        <div>
                          <strong>{e.medication}</strong> — {e.dosage}
                          {e.frequency ? `, ${e.frequency}` : ''}
                        </div>
                        <div className="muted">
                          {t('Prescribed {date}', { date: formatDate(e.issuedAt) })}
                        </div>
                        <ErxSummary e={e} />
                        {e.dispensings.length > 0 && (
                          <details>
                            <summary>{t('Dispensing history')}</summary>
                            <DispensingTable
                              items={e.dispensings}
                              caption={t('Dispensing history')}
                            />
                          </details>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </>
          );
        }}
      </QueryView>
    </>
  );
}

function ActiveEPrescription({ e }: { e: EPrescription }) {
  return (
    <article className="card" style={{ padding: '1rem' }} aria-label={e.medication}>
      <div className="row" style={{ flexWrap: 'wrap', gap: '1rem', alignItems: 'flex-start' }}>
        {e.code && <CodeQr code={e.code} />}
        <div className="stack" style={{ gap: '0.4rem', minWidth: 0, flex: 1 }}>
          <h3 style={{ margin: 0 }}>{e.medication}</h3>
          <div>
            {e.dosage}
            {e.frequency ? ` · ${e.frequency}` : ''}
          </div>
          {e.instructions && <div className="muted">{e.instructions}</div>}
          {e.code && (
            <div>
              <div className="muted">{t('Code for the pharmacy')}</div>
              <CodeText code={e.code} />
            </div>
          )}
          <ErxSummary e={e} />
          {e.suppliesRemaining > 0 && e.repeatsAllowed > 0 && (
            <div className="muted">{t('{n} supplies left', { n: e.suppliesRemaining })}</div>
          )}
        </div>
      </div>
      {e.dispensings.length > 0 && (
        <details>
          <summary>{t('Dispensing history')}</summary>
          <DispensingTable items={e.dispensings} caption={t('Dispensing history')} />
        </details>
      )}
    </article>
  );
}
