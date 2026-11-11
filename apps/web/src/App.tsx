import { t } from './i18n';
import { Navigate, Route, Routes } from 'react-router-dom';
import { HOME_BY_ROLE, useAuth } from './auth/AuthContext';
import { Layout } from './components/Layout';
import { RequireRole } from './components/RequireRole';
import { EmptyState, Loading } from './components/ui';
import { NotificationsPage } from './components/Notifications';
import type { Role } from './api/types';
import { lazy, Suspense, type ReactElement } from 'react';

// Each page is loaded when it is first opened, so nobody downloads the whole application.
const ModulesPage = lazy(() =>
  import('./pages/shared/ModulesPage').then((m) => ({ default: m.ModulesPage })),
);
const DowntimePage = lazy(() =>
  import('./pages/downtime/DowntimePage').then((m) => ({ default: m.DowntimePage })),
);
const WristbandPage = lazy(() =>
  import('./pages/shared/WristbandPage').then((m) => ({ default: m.WristbandPage })),
);
const PrivacyAdminPage = lazy(() =>
  import('./pages/privacy/PrivacyAdminPage').then((m) => ({ default: m.PrivacyAdminPage })),
);
const SystemHealth = lazy(() =>
  import('./pages/ministry/SystemHealth').then((m) => ({ default: m.SystemHealth })),
);
const InteractionChecker = lazy(() =>
  import('./pages/tools/InteractionChecker').then((m) => ({ default: m.InteractionChecker })),
);
const BloodBankPage = lazy(() =>
  import('./pages/bloodbank/BloodBankPage').then((m) => ({ default: m.BloodBankPage })),
);
const NutritionPage = lazy(() =>
  import('./pages/nutrition/NutritionPage').then((m) => ({ default: m.NutritionPage })),
);
const BillingPage = lazy(() =>
  import('./pages/billing/BillingPage').then((m) => ({ default: m.BillingPage })),
);
const PortalBilling = lazy(() =>
  import('./pages/patient/PortalBilling').then((m) => ({ default: m.PortalBilling })),
);
const EarlyWarningBoard = lazy(() =>
  import('./pages/hospital/EarlyWarningBoard').then((m) => ({ default: m.EarlyWarningBoard })),
);
const SurveillancePage = lazy(() =>
  import('./pages/surveillance/SurveillancePage').then((m) => ({ default: m.SurveillancePage })),
);
const VideoVisit = lazy(() =>
  import('./pages/video/VideoVisit').then((m) => ({ default: m.VideoVisit })),
);
const AvailabilityPage = lazy(() =>
  import('./pages/doctor/AvailabilityPage').then((m) => ({ default: m.AvailabilityPage })),
);
const VaccinationDuePage = lazy(() =>
  import('./pages/vaccination/VaccinationDuePage').then((m) => ({ default: m.VaccinationDuePage })),
);
const PortalVaccinations = lazy(() =>
  import('./pages/patient/PortalVaccinations').then((m) => ({ default: m.PortalVaccinations })),
);
const VaccinationCoverage = lazy(() =>
  import('./pages/ministry/VaccinationCoverage').then((m) => ({ default: m.VaccinationCoverage })),
);
const SecurityPage = lazy(() =>
  import('./pages/shared/SecurityPage').then((m) => ({ default: m.SecurityPage })),
);
const TheatreSchedule = lazy(() =>
  import('./pages/theatre/TheatreSchedule').then((m) => ({ default: m.TheatreSchedule })),
);
const StockPage = lazy(() =>
  import('./pages/pharmacy/StockPage').then((m) => ({ default: m.StockPage })),
);
const StockOverview = lazy(() =>
  import('./pages/ministry/StockOverview').then((m) => ({ default: m.StockOverview })),
);
const ImageViewer = lazy(() =>
  import('./pages/imaging/ImageViewer').then((m) => ({ default: m.ImageViewer })),
);
const BedBoard = lazy(() =>
  import('./pages/hospital/BedBoard').then((m) => ({ default: m.BedBoard })),
);
const EdBoard = lazy(() => import('./pages/ed/EdBoard').then((m) => ({ default: m.EdBoard })));
const BirthsPage = lazy(() =>
  import('./pages/births/BirthsPage').then((m) => ({ default: m.BirthsPage })),
);
const TemporaryIdentitiesPage = lazy(() =>
  import('./pages/births/TemporaryIdentitiesPage').then((m) => ({
    default: m.TemporaryIdentitiesPage,
  })),
);
const ImagingWorklist = lazy(() =>
  import('./pages/imaging/ImagingWorklist').then((m) => ({ default: m.ImagingWorklist })),
);
const UnitsPage = lazy(() =>
  import('./pages/director/UnitsPage').then((m) => ({ default: m.UnitsPage })),
);
const PartnersPage = lazy(() =>
  import('./pages/ministry/PartnersPage').then((m) => ({ default: m.PartnersPage })),
);
const ApiDocsPage = lazy(() =>
  import('./pages/developers/ApiDocsPage').then((m) => ({ default: m.ApiDocsPage })),
);
const PortalStays = lazy(() =>
  import('./pages/patient/PortalStays').then((m) => ({ default: m.PortalStays })),
);
const PortalImaging = lazy(() =>
  import('./pages/patient/PortalImaging').then((m) => ({ default: m.PortalImaging })),
);
const DirectorDuplicates = lazy(() =>
  import('./pages/director/DirectorDuplicates').then((m) => ({ default: m.DirectorDuplicates })),
);
const PortalDocuments = lazy(() =>
  import('./pages/patient/PortalDocuments').then((m) => ({ default: m.PortalDocuments })),
);
const PortalConsents = lazy(() =>
  import('./pages/patient/PortalConsents').then((m) => ({ default: m.PortalConsents })),
);
const DoctorCover = lazy(() =>
  import('./pages/doctor/DoctorCover').then((m) => ({ default: m.DoctorCover })),
);
const DirectorDashboard = lazy(() =>
  import('./pages/director/DirectorDashboard').then((m) => ({ default: m.DirectorDashboard })),
);
const DirectorPatients = lazy(() =>
  import('./pages/director/DirectorPatients').then((m) => ({ default: m.DirectorPatients })),
);
const StaffPage = lazy(() =>
  import('./pages/shared/StaffPage').then((m) => ({ default: m.StaffPage })),
);
const DoctorHome = lazy(() =>
  import('./pages/doctor/DoctorHome').then((m) => ({ default: m.DoctorHome })),
);
const DoctorPatients = lazy(() =>
  import('./pages/doctor/DoctorPatients').then((m) => ({ default: m.DoctorPatients })),
);
const DoctorSchedule = lazy(() =>
  import('./pages/doctor/DoctorSchedule').then((m) => ({ default: m.DoctorSchedule })),
);
const PatientChart = lazy(() =>
  import('./pages/doctor/PatientChart').then((m) => ({ default: m.PatientChart })),
);
const RegisterPatient = lazy(() =>
  import('./pages/doctor/RegisterPatient').then((m) => ({ default: m.RegisterPatient })),
);
const FacilityStatsPage = lazy(() =>
  import('./pages/ministry/FacilityStatsPage').then((m) => ({ default: m.FacilityStatsPage })),
);
const MinistryFacilities = lazy(() =>
  import('./pages/ministry/MinistryFacilities').then((m) => ({ default: m.MinistryFacilities })),
);
const NationalDashboard = lazy(() =>
  import('./pages/ministry/NationalDashboard').then((m) => ({ default: m.NationalDashboard })),
);
const PortalAccessLog = lazy(() =>
  import('./pages/patient/PortalAccessLog').then((m) => ({ default: m.PortalAccessLog })),
);
const PortalAccount = lazy(() =>
  import('./pages/patient/PortalAccount').then((m) => ({ default: m.PortalAccount })),
);
const PortalAppointments = lazy(() =>
  import('./pages/patient/PortalAppointments').then((m) => ({ default: m.PortalAppointments })),
);
const PortalHistory = lazy(() =>
  import('./pages/patient/PortalHistory').then((m) => ({ default: m.PortalHistory })),
);
const PortalHome = lazy(() =>
  import('./pages/patient/PortalHome').then((m) => ({ default: m.PortalHome })),
);
const PortalResults = lazy(() =>
  import('./pages/patient/PortalResults').then((m) => ({ default: m.PortalResults })),
);
const AccountPage = lazy(() =>
  import('./pages/shared/AccountPage').then((m) => ({ default: m.AccountPage })),
);
const ActivatePage = lazy(() =>
  import('./pages/shared/ActivatePage').then((m) => ({ default: m.ActivatePage })),
);
const AuditLogPage = lazy(() =>
  import('./pages/shared/AuditLogPage').then((m) => ({ default: m.AuditLogPage })),
);
const LoginPage = lazy(() =>
  import('./pages/shared/LoginPage').then((m) => ({ default: m.LoginPage })),
);
const EmergencyReviewPage = lazy(() =>
  import('./pages/director/EmergencyReviewPage').then((m) => ({ default: m.EmergencyReviewPage })),
);
const IntegrationsPage = lazy(() =>
  import('./pages/director/IntegrationsPage').then((m) => ({ default: m.IntegrationsPage })),
);
const EmergencyOversightPage = lazy(() =>
  import('./pages/ministry/EmergencyOversightPage').then((m) => ({
    default: m.EmergencyOversightPage,
  })),
);
const PortalReferrals = lazy(() =>
  import('./pages/patient/PortalReferrals').then((m) => ({ default: m.PortalReferrals })),
);
const AnnouncementsManagePage = lazy(() =>
  import('./pages/shared/AnnouncementsManagePage').then((m) => ({
    default: m.AnnouncementsManagePage,
  })),
);
const MessagesPage = lazy(() =>
  import('./pages/shared/MessagesPage').then((m) => ({ default: m.MessagesPage })),
);
const MfaSetupPage = lazy(() =>
  import('./pages/shared/MfaSetupPage').then((m) => ({ default: m.MfaSetupPage })),
);
const ForgotPasswordPage = lazy(() =>
  import('./pages/shared/PasswordResetPages').then((m) => ({ default: m.ForgotPasswordPage })),
);
const ResetPasswordPage = lazy(() =>
  import('./pages/shared/PasswordResetPages').then((m) => ({ default: m.ResetPasswordPage })),
);
const ReferralsPage = lazy(() =>
  import('./pages/shared/ReferralsPage').then((m) => ({ default: m.ReferralsPage })),
);
const ReportsPage = lazy(() =>
  import('./pages/shared/ReportsPage').then((m) => ({ default: m.ReportsPage })),
);
const NurseHome = lazy(() =>
  import('./pages/nurse/NurseHome').then((m) => ({ default: m.NurseHome })),
);
const NurseSchedule = lazy(() =>
  import('./pages/nurse/NurseSchedule').then((m) => ({ default: m.NurseSchedule })),
);
const PharmacyQueue = lazy(() =>
  import('./pages/pharmacy/PharmacyQueue').then((m) => ({ default: m.PharmacyQueue })),
);
const ReceptionAppointments = lazy(() =>
  import('./pages/reception/ReceptionAppointments').then((m) => ({
    default: m.ReceptionAppointments,
  })),
);
const ReceptionPatients = lazy(() =>
  import('./pages/reception/ReceptionPatients').then((m) => ({ default: m.ReceptionPatients })),
);
const ReceptionToday = lazy(() =>
  import('./pages/reception/ReceptionToday').then((m) => ({ default: m.ReceptionToday })),
);
const ChannelsPage = lazy(() =>
  import('./pages/shared/ChannelsPage').then((m) => ({ default: m.ChannelsPage })),
);
const TasksPage = lazy(() =>
  import('./pages/shared/TasksPage').then((m) => ({ default: m.TasksPage })),
);
const DeathsPage = lazy(() =>
  import('./pages/deaths/DeathsPage').then((m) => ({ default: m.DeathsPage })),
);
const CertificatesPage = lazy(() =>
  import('./pages/certificates/CertificatesPage').then((m) => ({ default: m.CertificatesPage })),
);
const VerifyCertificatePage = lazy(() =>
  import('./pages/certificates/VerifyCertificatePage').then((m) => ({
    default: m.VerifyCertificatePage,
  })),
);
const PortalCertificatesPage = lazy(() =>
  import('./pages/certificates/PortalCertificatesPage').then((m) => ({
    default: m.PortalCertificatesPage,
  })),
);
const WaitingListsPage = lazy(() =>
  import('./pages/waiting/WaitingListsPage').then((m) => ({ default: m.WaitingListsPage })),
);
const PortalWaitingListsPage = lazy(() =>
  import('./pages/waiting/PortalWaitingListsPage').then((m) => ({
    default: m.PortalWaitingListsPage,
  })),
);
const RegistersPage = lazy(() =>
  import('./pages/registers/RegistersPage').then((m) => ({ default: m.RegistersPage })),
);
const IncidentsPage = lazy(() =>
  import('./pages/incidents/IncidentsPage').then((m) => ({ default: m.IncidentsPage })),
);
const MaternityPage = lazy(() =>
  import('./pages/maternity/MaternityPage').then((m) => ({ default: m.MaternityPage })),
);
const PortalPregnancyPage = lazy(() =>
  import('./pages/maternity/PortalPregnancyPage').then((m) => ({ default: m.PortalPregnancyPage })),
);
const ScreeningPage = lazy(() =>
  import('./pages/screening/ScreeningPage').then((m) => ({ default: m.ScreeningPage })),
);
const PortalScreeningPage = lazy(() =>
  import('./pages/screening/PortalScreeningPage').then((m) => ({ default: m.PortalScreeningPage })),
);
const EPrescriptionsPage = lazy(() =>
  import('./pages/erx/EPrescriptionsPage').then((m) => ({ default: m.EPrescriptionsPage })),
);
const PortalEPrescriptionsPage = lazy(() =>
  import('./pages/erx/PortalEPrescriptionsPage').then((m) => ({
    default: m.PortalEPrescriptionsPage,
  })),
);
const LicencesPage = lazy(() =>
  import('./pages/licences/LicencesPage').then((m) => ({ default: m.LicencesPage })),
);
const ComplaintsPage = lazy(() =>
  import('./pages/complaints/ComplaintsPage').then((m) => ({ default: m.ComplaintsPage })),
);
const PortalComplaintsPage = lazy(() =>
  import('./pages/complaints/PortalComplaintsPage').then((m) => ({
    default: m.PortalComplaintsPage,
  })),
);
const OrganDonationRegistryPage = lazy(() =>
  import('./pages/directives/OrganDonationRegistryPage').then((m) => ({
    default: m.OrganDonationRegistryPage,
  })),
);
const PortalWishesPage = lazy(() =>
  import('./pages/directives/PortalWishesPage').then((m) => ({ default: m.PortalWishesPage })),
);
const EmsPage = lazy(() => import('./pages/ems/EmsPage').then((m) => ({ default: m.EmsPage })));
const InfectionPage = lazy(() =>
  import('./pages/infection/InfectionPage').then((m) => ({ default: m.InfectionPage })),
);
const SepsisPage = lazy(() =>
  import('./pages/sepsis/SepsisPage').then((m) => ({ default: m.SepsisPage })),
);
const RostersPage = lazy(() =>
  import('./pages/rosters/RostersPage').then((m) => ({ default: m.RostersPage })),
);
const HomeCarePage = lazy(() =>
  import('./pages/homecare/HomeCarePage').then((m) => ({ default: m.HomeCarePage })),
);
const PortalHomeVisitsPage = lazy(() =>
  import('./pages/homecare/PortalHomeVisitsPage').then((m) => ({
    default: m.PortalHomeVisitsPage,
  })),
);
const EquipmentPage = lazy(() =>
  import('./pages/equipment/EquipmentPage').then((m) => ({ default: m.EquipmentPage })),
);
const RemoteMonitoringPage = lazy(() =>
  import('./pages/remote/RemoteMonitoringPage').then((m) => ({ default: m.RemoteMonitoringPage })),
);
const PortalReadingsPage = lazy(() =>
  import('./pages/remote/PortalReadingsPage').then((m) => ({ default: m.PortalReadingsPage })),
);
const OncologyPage = lazy(() =>
  import('./pages/oncology/OncologyPage').then((m) => ({ default: m.OncologyPage })),
);
const DialysisPage = lazy(() =>
  import('./pages/dialysis/DialysisPage').then((m) => ({ default: m.DialysisPage })),
);
const MentalHealthPage = lazy(() =>
  import('./pages/mentalhealth/MentalHealthPage').then((m) => ({ default: m.MentalHealthPage })),
);
const BloodDonorsPage = lazy(() =>
  import('./pages/donors/BloodDonorsPage').then((m) => ({ default: m.BloodDonorsPage })),
);
const PortalDonorPage = lazy(() =>
  import('./pages/donors/PortalDonorPage').then((m) => ({ default: m.PortalDonorPage })),
);
const OpenDataPage = lazy(() =>
  import('./pages/opendata/OpenDataPage').then((m) => ({ default: m.OpenDataPage })),
);
const AccessReviewsPage = lazy(() =>
  import('./pages/accessreviews/AccessReviewsPage').then((m) => ({ default: m.AccessReviewsPage })),
);
const TerminologyPage = lazy(() =>
  import('./pages/terminology/TerminologyPage').then((m) => ({ default: m.TerminologyPage })),
);
const SupportPage = lazy(() =>
  import('./pages/support/SupportPage').then((m) => ({ default: m.SupportPage })),
);
const LabWorkPage = lazy(() =>
  import('./pages/labwork/LabWorkPage').then((m) => ({ default: m.LabWorkPage })),
);
const PromsPage = lazy(() =>
  import('./pages/proms/PromsPage').then((m) => ({ default: m.PromsPage })),
);
const PortalQuestionnairesPage = lazy(() =>
  import('./pages/proms/PortalQuestionnairesPage').then((m) => ({
    default: m.PortalQuestionnairesPage,
  })),
);

const STAFF: Role[] = [
  'MINISTRY',
  'DIRECTOR',
  'DOCTOR',
  'NURSE',
  'PHARMACIST',
  'RECEPTION',
  'LAB_TECHNICIAN',
  'IT_SUPPORT',
];
const guard = (roles: Role[], el: ReactElement) => <RequireRole roles={roles}>{el}</RequireRole>;

function HomeRedirect() {
  const { status, user } = useAuth();
  if (status === 'loading') return <Loading label={t('Restoring your session…')} />;
  return <Navigate to={user ? HOME_BY_ROLE[user.role] : '/login'} replace />;
}

export function App() {
  return (
    <Suspense fallback={<Loading label={t('Loading…')} />}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/activate" element={<ActivatePage />} />
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        <Route path="/reset-password" element={<ResetPasswordPage />} />
        <Route path="/setup-two-step" element={<MfaSetupPage />} />
        <Route path="/verify" element={<VerifyCertificatePage />} />
        <Route path="/open-data" element={<OpenDataPage />} />
        <Route path="/verify/:code" element={<VerifyCertificatePage />} />
        <Route path="/" element={<HomeRedirect />} />

        <Route
          element={
            <RequireRole roles={[...STAFF, 'PATIENT']}>
              <Layout />
            </RequireRole>
          }
        >
          <Route path="/account" element={<AccountPage />} />
          <Route path="/notifications" element={<NotificationsPage />} />
          <Route path="/modules" element={<ModulesPage />} />

          <Route
            path="/portal"
            element={
              <RequireRole roles={['PATIENT']}>
                <PortalHome />
              </RequireRole>
            }
          />
          <Route
            path="/portal/history"
            element={
              <RequireRole roles={['PATIENT']}>
                <PortalHistory />
              </RequireRole>
            }
          />
          <Route
            path="/portal/results"
            element={
              <RequireRole roles={['PATIENT']}>
                <PortalResults />
              </RequireRole>
            }
          />
          <Route
            path="/portal/appointments"
            element={
              <RequireRole roles={['PATIENT']}>
                <PortalAppointments />
              </RequireRole>
            }
          />
          <Route
            path="/portal/access-log"
            element={
              <RequireRole roles={['PATIENT']}>
                <PortalAccessLog />
              </RequireRole>
            }
          />
          <Route
            path="/portal/messages"
            element={
              <RequireRole roles={['PATIENT']}>
                <MessagesPage />
              </RequireRole>
            }
          />
          <Route
            path="/portal/documents"
            element={
              <RequireRole roles={['PATIENT']}>
                <PortalDocuments />
              </RequireRole>
            }
          />
          <Route
            path="/portal/consents"
            element={
              <RequireRole roles={['PATIENT']}>
                <PortalConsents />
              </RequireRole>
            }
          />
          <Route
            path="/wards"
            element={guard(['DOCTOR', 'NURSE', 'RECEPTION', 'DIRECTOR'], <BedBoard />)}
          />
          <Route path="/ed" element={guard(['DOCTOR', 'NURSE', 'RECEPTION'], <EdBoard />)} />
          <Route path="/births" element={guard(['DOCTOR', 'NURSE', 'RECEPTION'], <BirthsPage />)} />
          <Route
            path="/identities"
            element={guard(
              ['DOCTOR', 'NURSE', 'RECEPTION', 'DIRECTOR'],
              <TemporaryIdentitiesPage />,
            )}
          />
          <Route path="/imaging" element={guard(['DOCTOR', 'NURSE'], <ImagingWorklist />)} />
          <Route path="/director/units" element={guard(['DIRECTOR'], <UnitsPage />)} />
          <Route path="/ministry/partners" element={guard(['MINISTRY'], <PartnersPage />)} />
          <Route
            path="/developers"
            element={guard(['MINISTRY', 'DIRECTOR', 'DOCTOR'], <ApiDocsPage />)}
          />
          <Route path="/portal/stays" element={guard(['PATIENT'], <PortalStays />)} />
          <Route path="/portal/imaging" element={guard(['PATIENT'], <PortalImaging />)} />
          <Route path="/theatre" element={guard(['DOCTOR', 'NURSE'], <TheatreSchedule />)} />
          <Route
            path="/pharmacy/stock"
            element={guard(['PHARMACIST', 'DIRECTOR'], <StockPage />)}
          />
          <Route path="/ministry/stock" element={guard(['MINISTRY'], <StockOverview />)} />
          <Route
            path="/imaging/viewer/:orderId"
            element={guard(['DOCTOR', 'NURSE', 'PATIENT'], <ImageViewer />)}
          />
          <Route path="/doctor/availability" element={guard(['DOCTOR'], <AvailabilityPage />)} />
          <Route
            path="/vaccinations/due"
            element={guard(['NURSE', 'DOCTOR', 'RECEPTION'], <VaccinationDuePage />)}
          />
          <Route path="/portal/vaccinations" element={guard(['PATIENT'], <PortalVaccinations />)} />
          <Route
            path="/ministry/vaccination"
            element={guard(['MINISTRY'], <VaccinationCoverage />)}
          />
          <Route
            path="/director/vaccination"
            element={guard(['DIRECTOR'], <VaccinationCoverage />)}
          />
          <Route path="/account/security" element={<SecurityPage />} />
          <Route
            path="/tools/interactions"
            element={guard(['DOCTOR', 'PHARMACIST', 'NURSE', 'MINISTRY'], <InteractionChecker />)}
          />
          <Route
            path="/blood-bank"
            element={guard(['DOCTOR', 'NURSE', 'DIRECTOR'], <BloodBankPage />)}
          />
          <Route path="/nutrition" element={guard(['NURSE', 'DOCTOR'], <NutritionPage />)} />
          <Route path="/billing" element={guard(['RECEPTION', 'DIRECTOR'], <BillingPage />)} />
          <Route path="/portal/billing" element={guard(['PATIENT'], <PortalBilling />)} />
          <Route
            path="/wards/early-warning"
            element={guard(['DOCTOR', 'NURSE'], <EarlyWarningBoard />)}
          />
          <Route
            path="/surveillance"
            element={guard(['MINISTRY', 'DIRECTOR', 'DOCTOR'], <SurveillancePage />)}
          />
          <Route
            path="/video/:appointmentId"
            element={guard(['DOCTOR', 'PATIENT'], <VideoVisit />)}
          />
          <Route
            path="/maternity"
            element={guard(['DOCTOR', 'NURSE', 'DIRECTOR', 'MINISTRY'], <MaternityPage />)}
          />
          <Route path="/portal/pregnancy" element={guard(['PATIENT'], <PortalPregnancyPage />)} />
          <Route
            path="/screening"
            element={guard(['DOCTOR', 'NURSE', 'DIRECTOR', 'MINISTRY'], <ScreeningPage />)}
          />
          <Route path="/portal/screening" element={guard(['PATIENT'], <PortalScreeningPage />)} />
          <Route
            path="/e-prescriptions"
            element={guard(
              ['DOCTOR', 'PHARMACIST', 'DIRECTOR', 'MINISTRY'],
              <EPrescriptionsPage />,
            )}
          />
          <Route
            path="/portal/e-prescriptions"
            element={guard(['PATIENT'], <PortalEPrescriptionsPage />)}
          />
          <Route path="/licences" element={guard(['DIRECTOR', 'MINISTRY'], <LicencesPage />)} />
          <Route
            path="/complaints"
            element={guard(
              ['DOCTOR', 'NURSE', 'PHARMACIST', 'RECEPTION', 'DIRECTOR', 'MINISTRY'],
              <ComplaintsPage />,
            )}
          />
          <Route path="/portal/complaints" element={guard(['PATIENT'], <PortalComplaintsPage />)} />
          <Route
            path="/organ-donation"
            element={guard(['MINISTRY'], <OrganDonationRegistryPage />)}
          />
          <Route path="/portal/wishes" element={guard(['PATIENT'], <PortalWishesPage />)} />
          <Route
            path="/ems"
            element={guard(['DOCTOR', 'NURSE', 'DIRECTOR', 'MINISTRY'], <EmsPage />)}
          />
          <Route
            path="/infection"
            element={guard(
              ['DOCTOR', 'NURSE', 'PHARMACIST', 'DIRECTOR', 'MINISTRY'],
              <InfectionPage />,
            )}
          />
          <Route path="/sepsis" element={guard(['DOCTOR', 'NURSE', 'DIRECTOR'], <SepsisPage />)} />
          <Route
            path="/rosters"
            element={guard(
              ['DOCTOR', 'NURSE', 'PHARMACIST', 'RECEPTION', 'DIRECTOR'],
              <RostersPage />,
            )}
          />
          <Route
            path="/home-care"
            element={guard(['DOCTOR', 'NURSE', 'DIRECTOR'], <HomeCarePage />)}
          />
          <Route
            path="/portal/home-visits"
            element={guard(['PATIENT'], <PortalHomeVisitsPage />)}
          />
          <Route
            path="/equipment"
            element={guard(['DOCTOR', 'NURSE', 'DIRECTOR', 'MINISTRY'], <EquipmentPage />)}
          />
          <Route
            path="/remote-monitoring"
            element={guard(['DOCTOR', 'NURSE', 'DIRECTOR'], <RemoteMonitoringPage />)}
          />
          <Route path="/portal/readings" element={guard(['PATIENT'], <PortalReadingsPage />)} />
          <Route
            path="/oncology"
            element={guard(['DOCTOR', 'NURSE', 'DIRECTOR', 'MINISTRY'], <OncologyPage />)}
          />
          <Route
            path="/dialysis"
            element={guard(['DOCTOR', 'NURSE', 'DIRECTOR', 'MINISTRY'], <DialysisPage />)}
          />
          <Route
            path="/mental-health"
            element={guard(['DOCTOR', 'NURSE', 'DIRECTOR', 'MINISTRY'], <MentalHealthPage />)}
          />
          <Route
            path="/blood-donors"
            element={guard(
              ['DOCTOR', 'NURSE', 'RECEPTION', 'DIRECTOR', 'MINISTRY'],
              <BloodDonorsPage />,
            )}
          />
          <Route path="/portal/blood-donation" element={guard(['PATIENT'], <PortalDonorPage />)} />
          <Route
            path="/access-reviews"
            element={guard(['DIRECTOR', 'MINISTRY'], <AccessReviewsPage />)}
          />
          <Route
            path="/terminology"
            element={guard(
              ['MINISTRY', 'DIRECTOR', 'DOCTOR', 'NURSE', 'PHARMACIST', 'LAB_TECHNICIAN'],
              <TerminologyPage />,
            )}
          />
          <Route path="/support" element={guard(STAFF, <SupportPage />)} />
          <Route
            path="/lab"
            element={guard(['LAB_TECHNICIAN', 'DOCTOR', 'DIRECTOR'], <LabWorkPage />)}
          />
          <Route path="/proms" element={guard(['DOCTOR', 'NURSE', 'DIRECTOR'], <PromsPage />)} />
          <Route
            path="/portal/questionnaires"
            element={guard(['PATIENT'], <PortalQuestionnairesPage />)}
          />
          <Route
            path="/deaths"
            element={guard(['DOCTOR', 'DIRECTOR', 'MINISTRY'], <DeathsPage />)}
          />
          <Route
            path="/certificates"
            element={guard(['DOCTOR', 'DIRECTOR'], <CertificatesPage />)}
          />
          <Route
            path="/portal/certificates"
            element={guard(['PATIENT'], <PortalCertificatesPage />)}
          />
          <Route
            path="/waiting-lists"
            element={guard(['DOCTOR', 'RECEPTION', 'DIRECTOR', 'MINISTRY'], <WaitingListsPage />)}
          />
          <Route
            path="/portal/waiting-lists"
            element={guard(['PATIENT'], <PortalWaitingListsPage />)}
          />
          <Route
            path="/registers"
            element={guard(['DOCTOR', 'NURSE', 'DIRECTOR', 'MINISTRY'], <RegistersPage />)}
          />
          <Route
            path="/incidents"
            element={guard(
              ['DOCTOR', 'NURSE', 'PHARMACIST', 'RECEPTION', 'DIRECTOR', 'MINISTRY'],
              <IncidentsPage />,
            )}
          />
          <Route
            path="/downtime"
            element={guard(['DIRECTOR', 'DOCTOR', 'NURSE', 'RECEPTION'], <DowntimePage />)}
          />
          <Route
            path="/wristband/:patientId"
            element={guard(['NURSE', 'RECEPTION', 'DOCTOR'], <WristbandPage />)}
          />
          <Route path="/privacy" element={guard(['DIRECTOR', 'MINISTRY'], <PrivacyAdminPage />)} />
          <Route path="/ministry/system" element={guard(['MINISTRY'], <SystemHealth />)} />
          <Route
            path="/director/duplicates"
            element={guard(['DIRECTOR'], <DirectorDuplicates />)}
          />
          <Route
            path="/doctor/cover"
            element={
              <RequireRole roles={['DOCTOR']}>
                <DoctorCover />
              </RequireRole>
            }
          />
          <Route
            path="/portal/referrals"
            element={
              <RequireRole roles={['PATIENT']}>
                <PortalReferrals />
              </RequireRole>
            }
          />
          <Route
            path="/portal/account"
            element={
              <RequireRole roles={['PATIENT']}>
                <PortalAccount />
              </RequireRole>
            }
          />

          <Route
            path="/doctor"
            element={
              <RequireRole roles={['DOCTOR']}>
                <DoctorHome />
              </RequireRole>
            }
          />
          <Route
            path="/doctor/patients"
            element={
              <RequireRole roles={['DOCTOR']}>
                <DoctorPatients />
              </RequireRole>
            }
          />
          <Route
            path="/doctor/patients/new"
            element={
              <RequireRole roles={['DOCTOR']}>
                <RegisterPatient />
              </RequireRole>
            }
          />
          <Route
            path="/doctor/patients/:patientId"
            element={
              <RequireRole roles={['DOCTOR']}>
                <PatientChart />
              </RequireRole>
            }
          />
          <Route
            path="/doctor/messages"
            element={
              <RequireRole roles={['DOCTOR']}>
                <MessagesPage />
              </RequireRole>
            }
          />
          <Route
            path="/doctor/referrals"
            element={
              <RequireRole roles={['DOCTOR']}>
                <ReferralsPage />
              </RequireRole>
            }
          />
          <Route
            path="/doctor/schedule"
            element={
              <RequireRole roles={['DOCTOR']}>
                <DoctorSchedule />
              </RequireRole>
            }
          />

          <Route
            path="/director"
            element={
              <RequireRole roles={['DIRECTOR']}>
                <DirectorDashboard />
              </RequireRole>
            }
          />
          <Route
            path="/director/staff"
            element={
              <RequireRole roles={['DIRECTOR']}>
                <StaffPage />
              </RequireRole>
            }
          />
          <Route
            path="/director/patients"
            element={
              <RequireRole roles={['DIRECTOR']}>
                <DirectorPatients />
              </RequireRole>
            }
          />
          <Route
            path="/director/referrals"
            element={
              <RequireRole roles={['DIRECTOR']}>
                <ReferralsPage />
              </RequireRole>
            }
          />
          <Route
            path="/director/emergency-access"
            element={
              <RequireRole roles={['DIRECTOR']}>
                <EmergencyReviewPage />
              </RequireRole>
            }
          />
          <Route
            path="/director/reports"
            element={
              <RequireRole roles={['DIRECTOR']}>
                <ReportsPage />
              </RequireRole>
            }
          />
          <Route
            path="/director/announcements"
            element={
              <RequireRole roles={['DIRECTOR']}>
                <AnnouncementsManagePage />
              </RequireRole>
            }
          />
          <Route
            path="/director/integrations"
            element={
              <RequireRole roles={['DIRECTOR']}>
                <IntegrationsPage />
              </RequireRole>
            }
          />
          <Route
            path="/director/audit"
            element={
              <RequireRole roles={['DIRECTOR']}>
                <AuditLogPage />
              </RequireRole>
            }
          />

          <Route
            path="/ministry"
            element={
              <RequireRole roles={['MINISTRY']}>
                <NationalDashboard />
              </RequireRole>
            }
          />
          <Route
            path="/ministry/facilities"
            element={
              <RequireRole roles={['MINISTRY']}>
                <MinistryFacilities />
              </RequireRole>
            }
          />
          <Route
            path="/ministry/facilities/:facilityId"
            element={
              <RequireRole roles={['MINISTRY']}>
                <FacilityStatsPage />
              </RequireRole>
            }
          />
          <Route
            path="/ministry/staff"
            element={
              <RequireRole roles={['MINISTRY']}>
                <StaffPage />
              </RequireRole>
            }
          />
          <Route
            path="/ministry/reports"
            element={
              <RequireRole roles={['MINISTRY']}>
                <ReportsPage />
              </RequireRole>
            }
          />
          <Route
            path="/ministry/emergency-access"
            element={
              <RequireRole roles={['MINISTRY']}>
                <EmergencyOversightPage />
              </RequireRole>
            }
          />
          <Route
            path="/ministry/announcements"
            element={
              <RequireRole roles={['MINISTRY']}>
                <AnnouncementsManagePage />
              </RequireRole>
            }
          />
          <Route
            path="/ministry/audit"
            element={
              <RequireRole roles={['MINISTRY']}>
                <AuditLogPage />
              </RequireRole>
            }
          />

          <Route path="/channels" element={guard(STAFF, <ChannelsPage />)} />
          <Route path="/tasks" element={guard(['DOCTOR', 'NURSE'], <TasksPage />)} />
          <Route
            path="/messages"
            element={guard(['PATIENT', 'DOCTOR', 'NURSE'], <MessagesPage />)}
          />
          <Route path="/nurse" element={guard(['NURSE'], <NurseHome />)} />
          <Route path="/nurse/patients" element={guard(['NURSE'], <DoctorPatients />)} />
          <Route path="/nurse/patients/:patientId" element={guard(['NURSE'], <PatientChart />)} />
          <Route path="/nurse/schedule" element={guard(['NURSE'], <NurseSchedule />)} />
          <Route path="/pharmacy" element={guard(['PHARMACIST'], <PharmacyQueue />)} />
          <Route path="/reception" element={guard(['RECEPTION'], <ReceptionToday />)} />
          <Route path="/reception/patients" element={guard(['RECEPTION'], <ReceptionPatients />)} />
          <Route
            path="/reception/patients/new"
            element={guard(['RECEPTION'], <RegisterPatient />)}
          />
          <Route
            path="/reception/appointments"
            element={guard(['RECEPTION'], <ReceptionAppointments />)}
          />

          <Route
            path="*"
            element={
              <EmptyState title={t('Page not found')}>
                {t('Check the address or use the menu.')}
              </EmptyState>
            }
          />
        </Route>
      </Routes>
    </Suspense>
  );
}
