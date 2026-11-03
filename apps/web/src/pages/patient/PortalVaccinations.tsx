import { Link } from 'react-router-dom';
import { ageFromDob, useVaccinationStatus } from '../../api/vaccination';
import { useAuth, useUser } from '../../auth/AuthContext';
import { Alert, Card, PageHeader, QueryView } from '../../components/ui';
import { formatDate } from '../../format';
import { t } from '../../i18n';
import {
  PrintButton,
  VaccinationSummary,
  VaccinationTimeline,
} from '../vaccination/VaccinationCard';
import '../vaccination/vaccination.css';

/**
 * Vaccination card for the patient – or, for a guardian acting for a child, for the child:
 * the national calendar with given, due, overdue and upcoming doses, printable as a booklet.
 */
export function PortalVaccinations() {
  const user = useUser();
  const { acting } = useAuth();
  const patientId = acting?.patientId ?? user.patientId;
  const status = useVaccinationStatus(patientId);
  const name = acting ? acting.firstName : null;

  return (
    <>
      <PageHeader
        title={name ? t('{name}’s vaccinations', { name }) : t('My vaccinations')}
        subtitle={t('Based on the national childhood immunization calendar.')}
        actions={<PrintButton />}
      />
      <QueryView query={status}>
        {(s) => {
          const open = s.doses.filter((d) => d.state === 'DUE' || d.state === 'OVERDUE');
          return (
            <div className="stack">
              <Card
                title={
                  <>
                    {s.patient.firstName} {s.patient.lastName}{' '}
                    <span className="muted">
                      · {formatDate(s.patient.dateOfBirth)} ({ageFromDob(s.patient.dateOfBirth)})
                    </span>
                  </>
                }
              >
                <VaccinationSummary status={s} />
                {open.length > 0 && (
                  <Alert
                    tone={open.some((d) => d.state === 'OVERDUE') ? 'warning' : 'info'}
                    title={t('A vaccination is due')}
                  >
                    {t(
                      'Book an appointment with your family doctor or the vaccination clinic, and bring this booklet with you.',
                    )}{' '}
                    <Link to="/portal/appointments" className="no-print">
                      {t('Request an appointment')}
                    </Link>
                  </Alert>
                )}
              </Card>
              <Card title={t('Vaccination booklet')}>
                <VaccinationTimeline status={s} />
                {s.other && s.other.length > 0 && (
                  <>
                    <h3>{t('Other vaccinations')}</h3>
                    <ul className="list">
                      {s.other.map((o) => (
                        <li key={o.immunizationId} className="row-between">
                          <span>
                            <strong>{o.vaccine}</strong>
                            {o.doseNumber ? ` · ${t('dose {dose}', { dose: o.doseNumber })}` : ''}
                          </span>
                          <span className="muted">{formatDate(o.administeredAt)}</span>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                <p className="muted small">
                  {t(
                    'If a vaccination you received elsewhere is missing, show its record to your family doctor so it can be added.',
                  )}
                </p>
              </Card>
            </div>
          );
        }}
      </QueryView>
    </>
  );
}
