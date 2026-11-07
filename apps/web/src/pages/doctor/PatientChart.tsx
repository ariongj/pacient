import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api, ApiError, downloadFile } from '../../api/client';
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
import { ImmunizationsTab } from './chart/ImmunizationsTab';
import { MarTab } from './chart/MarTab';
import { useChartRole } from './chart/shared';
import { TasksTab } from './chart/TasksTab';
import { MedicationsTab } from './chart/MedicationsTab';
import { ProblemsTab } from './chart/ProblemsTab';
import { ReferDialog } from './chart/ReferDialog';
import { ResultsTab } from './chart/ResultsTab';
import { DocumentsTab } from './chart/DocumentsTab';
import { AdmissionsTab } from './chart/AdmissionsTab';
import { EmergencyTab } from './chart/EmergencyTab';
import { ImagingTab } from './chart/ImagingTab';
import { SurgeryTab } from './chart/SurgeryTab';
import { TransfusionTab } from './chart/TransfusionTab';
import { NutritionTab } from './chart/NutritionTab';
import { BirthsTab } from './chart/BirthsTab';
import { ConsentsTab } from './chart/ConsentsTab';
import { SummaryTab } from './chart/SummaryTab';
import { VisitsTab } from './chart/VisitsTab';
import { VitalsTab } from './chart/VitalsTab';
import { CertificatesTab } from './chart/CertificatesTab';
import { RegistersTab } from './chart/RegistersTab';
import { WaitingListTab } from './chart/WaitingListTab';
import { DeathTab } from './chart/DeathTab';
import { PregnancyTab } from './chart/PregnancyTab';
import { ScreeningTab } from './chart/ScreeningTab';
import { DirectivesTab } from './chart/DirectivesTab';
import { t } from '../../i18n';
import { displayName } from '../../api/identity';
import { ConfirmIdentityDialog } from '../births/IdentityDialogs';

/** GET /patients/:id – demographics without clinical data. */
interface PatientDemographics {
  /** Set when this record was a duplicate merged into another one. */
  mergedIntoId?: string | null;
  /** NEWBORN / UNIDENTIFIED while the national ID is a temporary number. */
  temporaryIdentity?: 'NEWBORN' | 'UNIDENTIFIED' | null;
  identityNote?: string | null;
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
  /** Set when a death certificate has been signed. */
  deceasedAt?: string | null;
}

const TAB_IDS = [
  'summary',
  'visits',
  'problems',
  'medications',
  'mar',
  'tasks',
  'allergies',
  'vitals',
  'results',
  'vaccinations',
  'admissions',
  'emergency',
  'imaging',
  'surgery',
  'transfusion',
  'nutrition',
  'births',
  'directives',
  'pregnancy',
  'screening',
  'registers',
  'waiting',
  'certificates',
  'death',
  'documents',
  'consents',
  'corrections',
  'care-team',
] as const;
type TabId = (typeof TAB_IDS)[number];

export function PatientChart() {
  const { patientId = '' } = useParams();
  const user = useUser();
  const [params, setParams] = useSearchParams();
  const [booking, setBooking] = useState(false);
  const [referring, setReferring] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [confirmingIdentity, setConfirmingIdentity] = useState(false);
  const [exportError, setExportError] = useState<unknown>(null);
  const { isDoctor, base } = useChartRole();
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

  if (demographics.isPending) return <Loading label={t('Loading patient…')} />;
  if (demographics.error) {
    const err = demographics.error;
    return (
      <Card
        title={
          err instanceof ApiError && err.status === 403
            ? t('No access to this patient')
            : t('Patient unavailable')
        }
      >
        {err instanceof ApiError && err.status === 403 ? (
          <p>
            {t(
              'This patient is not registered at your facility and is not in your care. Records are not shared across institutions.',
            )}
          </p>
        ) : (
          <ErrorAlert error={err} />
        )}
        <Link to={`${base}/patients`}>{t('Back to patients')}</Link>
      </Card>
    );
  }

  const p = demographics.data;
  if (p.mergedIntoId) {
    return (
      <Card title={t('This record was merged')}>
        <p>
          {t(
            'This was a duplicate record and has been merged into another record. All entries are now in the surviving record.',
          )}
        </p>
        <Link to={`${base}/patients/${p.mergedIntoId}`}>{t('Open the surviving record')}</Link>
      </Card>
    );
  }
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
        aria-label={t('Patient identification')}
      >
        <div>
          <h1>
            {p.temporaryIdentity === 'UNIDENTIFIED'
              ? displayName(p)
              : `${p.lastName}, ${p.firstName}`}
          </h1>
          {p.temporaryIdentity && (
            <div
              className="row"
              style={{ gap: '0.5rem', flexWrap: 'wrap', marginBottom: '0.25rem' }}
            >
              <Badge tone="warning">
                {p.temporaryIdentity === 'NEWBORN'
                  ? t('Temporary ID – awaiting civil registration')
                  : t('Temporary ID – awaiting confirmation')}
              </Badge>
              {p.temporaryIdentity === 'UNIDENTIFIED' && p.identityNote && (
                <span className="muted">{p.identityNote}</span>
              )}
              <Button size="sm" variant="secondary" onClick={() => setConfirmingIdentity(true)}>
                {p.temporaryIdentity === 'NEWBORN' ? t('Enter national ID') : t('Confirm identity')}
              </Button>
            </div>
          )}
          <div className="banner-facts">
            <span>
              {t('{age} y', { age: age(p.dateOfBirth) })} · {humanize(p.sex)}
            </span>
            <span>{t('DOB {date}', { date: formatDate(p.dateOfBirth) })}</span>
            <span>
              {t('National ID')} <code>{p.nationalId}</code>
            </span>
            <span>
              {t('Blood type {type}', {
                type: p.bloodType === 'UNKNOWN' ? t('unknown') : p.bloodType,
              })}
            </span>
            {p.deceasedAt && (
              <Badge tone="danger">
                {t('Deceased {date}', { date: formatDate(p.deceasedAt) })}
              </Badge>
            )}
            {p.hasPortalAccount && <Badge tone="success">{t('Portal user')}</Badge>}
          </div>
        </div>
        {s && (
          <div aria-label={t('Allergies')}>
            {activeAllergies.length > 0 ? (
              <div className="row">
                <strong>{t('Allergies:')}</strong>
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
                  {t(ALLERGY_ASSESSMENT_TEXT[assessment])}
                </Badge>
              )
            )}
          </div>
        )}
        {s && (
          <div className="row no-print" style={{ marginLeft: 'auto' }}>
            {isDoctor && !p.deceasedAt && (
              <>
                <Button variant="secondary" size="sm" onClick={() => setBooking(true)}>
                  {t('Book appointment')}
                </Button>
                <Button variant="secondary" size="sm" onClick={() => setReferring(true)}>
                  {t('Refer')}
                </Button>
              </>
            )}
            {p.hasPortalAccount && (
              <Link
                className="btn btn-secondary btn-sm"
                to={`/messages?patientId=${encodeURIComponent(patientId)}`}
              >
                {t('Message patient')}
              </Link>
            )}
            {(user.role === 'NURSE' || user.role === 'DOCTOR' || user.role === 'RECEPTION') && (
              <Link className="btn btn-secondary btn-sm" to={`/wristband/${patientId}`}>
                {t('Print wristband')}
              </Link>
            )}
            <Button
              variant="ghost"
              size="sm"
              loading={exporting}
              title={t('HL7 FHIR R4 bundle (Patient/$everything). The export is audited.')}
              onClick={async () => {
                setExporting(true);
                setExportError(null);
                try {
                  await downloadFile(
                    `/fhir/Patient/${patientId}/$everything`,
                    `patient-${patientId}.fhir.json`,
                  );
                } catch (err) {
                  setExportError(err);
                } finally {
                  setExporting(false);
                }
              }}
            >
              {t('Download FHIR')}
            </Button>
          </div>
        )}
      </section>

      <ErrorAlert error={exportError} />
      {s?.accessBasis === 'EMERGENCY' && (
        <Alert tone="danger" title={t('Emergency access')}>
          {t(
            'You are viewing this record under break-glass access. It expires automatically, every view is audited, and the patient and your director can see it.',
          )}
        </Alert>
      )}

      {summary.isPending && <Loading label={t('Loading record…')} />}
      {noClinicalAccess && <AccessPanel patientId={patientId} sameFacility={sameFacility} />}
      {summary.error && !noClinicalAccess && <ErrorAlert error={summary.error} />}

      {s && (
        <>
          <Tabs<TabId>
            label={t('Patient record sections')}
            active={tab}
            onChange={setTab}
            tabs={[
              { id: 'summary', label: t('Summary') },
              { id: 'visits', label: t('Visits'), count: s.counts.encounters },
              { id: 'problems', label: t('Problems'), count: s.counts.diagnoses },
              { id: 'medications', label: t('Medications'), count: s.counts.prescriptions },
              { id: 'mar', label: t('Administration') },
              { id: 'tasks', label: t('Care tasks') },
              { id: 'allergies', label: t('Allergies'), count: allergies.length },
              { id: 'vitals', label: t('Vitals') },
              { id: 'results', label: t('Results'), count: s.counts.labResults },
              { id: 'vaccinations', label: t('Vaccinations'), count: s.immunizations.length },
              { id: 'admissions', label: t('Hospital stays') },
              { id: 'emergency', label: t('Emergency') },
              { id: 'imaging', label: t('Imaging') },
              { id: 'surgery', label: t('Operations') },
              { id: 'transfusion', label: t('Transfusions') },
              { id: 'nutrition', label: t('Nutrition') },
              { id: 'births', label: t('Birth & maternity') },
              { id: 'directives', label: t('Wishes and directives') },
              { id: 'pregnancy', label: t('Pregnancy') },
              { id: 'screening', label: t('Screening|cancer') },
              { id: 'registers', label: t('Chronic care') },
              { id: 'waiting', label: t('Waiting lists') },
              { id: 'certificates', label: t('Certificates') },
              { id: 'documents', label: t('Documents') },
              { id: 'consents', label: t('Consent') },
              {
                id: 'corrections',
                label: t('Corrections'),
                count: s.counts.openCorrectionRequests,
              },
              { id: 'care-team', label: t('Care team') },
              // Doctors may certify; everyone else sees the tab once a death is recorded.
              ...(user.role === 'DOCTOR' || p.deceasedAt
                ? [{ id: 'death' as const, label: t('Death certificate') }]
                : []),
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
            {tab === 'mar' && <MarTab patientId={patientId} />}
            {tab === 'directives' && <DirectivesTab patientId={patientId} />}
            {tab === 'pregnancy' && <PregnancyTab patientId={patientId} />}
            {tab === 'screening' && <ScreeningTab patientId={patientId} />}
            {tab === 'registers' && <RegistersTab patientId={patientId} />}
            {tab === 'waiting' && <WaitingListTab patientId={patientId} />}
            {tab === 'certificates' && <CertificatesTab patientId={patientId} />}
            {tab === 'death' && <DeathTab patientId={patientId} />}
            {tab === 'tasks' && <TasksTab patientId={patientId} />}
            {tab === 'allergies' && (
              <AllergiesTab patientId={patientId} assessment={s.patient.allergyAssessment} />
            )}
            {tab === 'vitals' && (
              <VitalsTab patientId={patientId} encounters={s.recentEncounters} />
            )}
            {tab === 'results' && (
              <ResultsTab patientId={patientId} encounters={s.recentEncounters} />
            )}
            {tab === 'vaccinations' && (
              <ImmunizationsTab patientId={patientId} encounters={s.recentEncounters} />
            )}
            {tab === 'admissions' && <AdmissionsTab patientId={patientId} />}
            {tab === 'emergency' && <EmergencyTab patientId={patientId} />}
            {tab === 'imaging' && <ImagingTab patientId={patientId} />}
            {tab === 'surgery' && <SurgeryTab patientId={patientId} />}
            {tab === 'transfusion' && <TransfusionTab patientId={patientId} />}
            {tab === 'nutrition' && <NutritionTab patientId={patientId} />}
            {tab === 'births' && <BirthsTab patientId={patientId} />}
            {tab === 'documents' && <DocumentsTab patientId={patientId} />}
            {tab === 'consents' && <ConsentsTab patientId={patientId} />}
            {tab === 'corrections' && <CorrectionsTab patientId={patientId} />}
            {tab === 'care-team' && <CareTeamTab patientId={patientId} />}
          </TabPanel>
          {isDoctor && (
            <>
              <BookAppointmentDialog
                patientId={patientId}
                open={booking}
                onClose={() => setBooking(false)}
              />
              <ReferDialog
                patientId={patientId}
                summary={s}
                open={referring}
                onClose={() => setReferring(false)}
              />
            </>
          )}
        </>
      )}

      {!s && !summary.isPending && !noClinicalAccess && !summary.error && (
        <EmptyState title={t('No record available')} />
      )}
      {p.temporaryIdentity && (
        <ConfirmIdentityDialog
          patient={confirmingIdentity ? { ...p, temporaryIdentity: p.temporaryIdentity } : null}
          onClose={() => setConfirmingIdentity(false)}
        />
      )}
    </>
  );
}
