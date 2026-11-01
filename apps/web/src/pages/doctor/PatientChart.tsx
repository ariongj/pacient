import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../../api/client';
import type { ClinicalSummary } from '../../api/types';
import { useUser } from '../../auth/AuthContext';
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorAlert,
  Loading,
  StatusBadge,
  TabPanel,
  Tabs,
} from '../../components/ui';
import { age, formatDate, humanize } from '../../format';
import { AccessPanel } from './chart/AccessPanel';
import { ALLERGY_ASSESSMENT_TEXT, AllergiesTab } from './chart/AllergiesTab';
import { BookAppointmentDialog } from './chart/BookAppointmentDialog';
import { CareTeamTab } from './chart/CareTeamTab';
import { CorrectionsTab } from './chart/CorrectionsTab';
import { MedicationsTab } from './chart/MedicationsTab';
import { ProblemsTab } from './chart/ProblemsTab';
import { ResultsTab } from './chart/ResultsTab';
import { SummaryTab } from './chart/SummaryTab';
import { VisitsTab } from './chart/VisitsTab';
import { VitalsTab } from './chart/VitalsTab';

/** GET /patients/:id – demographics without clinical data. */
interface PatientDemographics {
  id: string;
  nationalId: string;
  firstName: string;
  lastName: string;
  dateOfBirth: string;
  sex: string;
  bloodType: string;
  primaryFacilityId: string;
  hasPortalAccount: boolean;
  inMyCare: boolean;
}

const TAB_IDS = [
  'summary',
  'visits',
  'problems',
  'medications',
  'allergies',
  'vitals',
  'results',
  'corrections',
  'care-team',
] as const;
type TabId = (typeof TAB_IDS)[number];

export function PatientChart() {
  const { patientId = '' } = useParams();
  const user = useUser();
  const [params, setParams] = useSearchParams();
  const [booking, setBooking] = useState(false);
  const requested = params.get('tab') as TabId | null;
  const tab: TabId = requested && TAB_IDS.includes(requested) ? requested : 'summary';

  const demographics = useQuery({
    queryKey: ['patient', patientId, 'demographics'],
    queryFn: () => api<PatientDemographics>(`/patients/${patientId}`),
  });
  const summary = useQuery({
    queryKey: ['patient', patientId, 'summary'],
    queryFn: () => api<ClinicalSummary>(`/patients/${patientId}/summary`),
    enabled: demographics.isSuccess,
  });

  if (demographics.isPending) return <Loading label="Loading patient…" />;
  if (demographics.error) {
    const err = demographics.error;
    return (
      <Card
        title={
          err instanceof ApiError && err.status === 403
            ? 'No access to this patient'
            : 'Patient unavailable'
        }
      >
        {err instanceof ApiError && err.status === 403 ? (
          <p>
            This patient is not registered at your facility and is not in your care. Records are not
            shared across institutions.
          </p>
        ) : (
          <ErrorAlert error={err} />
        )}
        <Link to="/doctor/patients">Back to patients</Link>
      </Card>
    );
  }

  const p = demographics.data;
  const sameFacility = p.primaryFacilityId === user.facility?.id;
  const noClinicalAccess = summary.error instanceof ApiError && summary.error.status === 403;
  const s = summary.data;
  const allergies = s?.allergies ?? [];
  const activeAllergies = allergies.filter(
    (a) => a.verificationStatus === 'CONFIRMED' || a.verificationStatus === 'UNCONFIRMED',
  );
  const assessment = s?.patient.allergyAssessment;

  const setTab = (id: TabId) => setParams({ tab: id }, { replace: true });

  return (
    <>
      <section
        className={`patient-banner ${s?.accessBasis === 'EMERGENCY' ? 'emergency-banner' : ''}`}
        aria-label="Patient identification"
      >
        <div>
          <h1>
            {p.lastName}, {p.firstName}
          </h1>
          <div className="banner-facts">
            <span>
              {age(p.dateOfBirth)} y · {humanize(p.sex)}
            </span>
            <span>DOB {formatDate(p.dateOfBirth)}</span>
            <span>
              National ID <code>{p.nationalId}</code>
            </span>
            <span>Blood type {p.bloodType === 'UNKNOWN' ? 'unknown' : p.bloodType}</span>
            {p.hasPortalAccount && <Badge tone="success">Portal user</Badge>}
          </div>
        </div>
        {s && (
          <div aria-label="Allergies">
            {activeAllergies.length > 0 ? (
              <div className="row">
                <strong>Allergies:</strong>
                {activeAllergies.map((a) => (
                  <span key={a.id} className="row" style={{ gap: '0.25rem' }}>
                    <Badge
                      tone={
                        a.severity === 'SEVERE' || a.severity === 'LIFE_THREATENING'
                          ? 'danger'
                          : 'warning'
                      }
                    >
                      {a.substance} — {humanize(a.severity)}
                    </Badge>
                    {a.verificationStatus === 'UNCONFIRMED' && <StatusBadge value="UNCONFIRMED" />}
                  </span>
                ))}
              </div>
            ) : (
              assessment && (
                <Badge tone={assessment === 'NO_KNOWN_ALLERGIES' ? 'success' : 'warning'}>
                  {ALLERGY_ASSESSMENT_TEXT[assessment]}
                </Badge>
              )
            )}
          </div>
        )}
        {s && (
          <div className="row" style={{ marginLeft: 'auto' }}>
            <Button variant="secondary" size="sm" onClick={() => setBooking(true)}>
              Book appointment
            </Button>
          </div>
        )}
      </section>

      {s?.accessBasis === 'EMERGENCY' && (
        <Alert tone="danger" title="Emergency access">
          You are viewing this record under break-glass access. It expires automatically, every view
          is audited, and the patient and your director can see it.
        </Alert>
      )}

      {summary.isPending && <Loading label="Loading record…" />}
      {noClinicalAccess && <AccessPanel patientId={patientId} sameFacility={sameFacility} />}
      {summary.error && !noClinicalAccess && <ErrorAlert error={summary.error} />}

      {s && (
        <>
          <Tabs<TabId>
            label="Patient record sections"
            active={tab}
            onChange={setTab}
            tabs={[
              { id: 'summary', label: 'Summary' },
              { id: 'visits', label: 'Visits', count: s.counts.encounters },
              { id: 'problems', label: 'Problems', count: s.counts.diagnoses },
              { id: 'medications', label: 'Medications', count: s.counts.prescriptions },
              { id: 'allergies', label: 'Allergies', count: allergies.length },
              { id: 'vitals', label: 'Vitals' },
              { id: 'results', label: 'Results', count: s.counts.labResults },
              { id: 'corrections', label: 'Corrections', count: s.counts.openCorrectionRequests },
              { id: 'care-team', label: 'Care team' },
            ]}
          />
          <TabPanel id={tab}>
            {tab === 'summary' && <SummaryTab summary={s} />}
            {tab === 'visits' && <VisitsTab patientId={patientId} />}
            {tab === 'problems' && (
              <ProblemsTab patientId={patientId} encounters={s.recentEncounters} />
            )}
            {tab === 'medications' && (
              <MedicationsTab
                patientId={patientId}
                encounters={s.recentEncounters}
                allergies={allergies}
              />
            )}
            {tab === 'allergies' && (
              <AllergiesTab patientId={patientId} assessment={s.patient.allergyAssessment} />
            )}
            {tab === 'vitals' && (
              <VitalsTab patientId={patientId} encounters={s.recentEncounters} />
            )}
            {tab === 'results' && (
              <ResultsTab patientId={patientId} encounters={s.recentEncounters} />
            )}
            {tab === 'corrections' && <CorrectionsTab patientId={patientId} />}
            {tab === 'care-team' && <CareTeamTab patientId={patientId} />}
          </TabPanel>
          <BookAppointmentDialog
            patientId={patientId}
            open={booking}
            onClose={() => setBooking(false)}
          />
        </>
      )}

      {!s && !summary.isPending && !noClinicalAccess && !summary.error && (
        <EmptyState title="No record available" />
      )}
    </>
  );
}
