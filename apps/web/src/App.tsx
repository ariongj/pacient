import { DowntimePage } from './pages/downtime/DowntimePage';
import { WristbandPage } from './pages/shared/WristbandPage';
import { PrivacyAdminPage } from './pages/privacy/PrivacyAdminPage';
import { SystemHealth } from './pages/ministry/SystemHealth';
import { InteractionChecker } from './pages/tools/InteractionChecker';
import { BloodBankPage } from './pages/bloodbank/BloodBankPage';
import { NutritionPage } from './pages/nutrition/NutritionPage';
import { BillingPage } from './pages/billing/BillingPage';
import { PortalBilling } from './pages/patient/PortalBilling';
import { EarlyWarningBoard } from './pages/hospital/EarlyWarningBoard';
import { SurveillancePage } from './pages/surveillance/SurveillancePage';
import { VideoVisit } from './pages/video/VideoVisit';
import { AvailabilityPage } from './pages/doctor/AvailabilityPage';
import { VaccinationDuePage } from './pages/vaccination/VaccinationDuePage';
import { PortalVaccinations } from './pages/patient/PortalVaccinations';
import { VaccinationCoverage } from './pages/ministry/VaccinationCoverage';
import { SecurityPage } from './pages/shared/SecurityPage';
import { TheatreSchedule } from './pages/theatre/TheatreSchedule';
import { StockPage } from './pages/pharmacy/StockPage';
import { StockOverview } from './pages/ministry/StockOverview';
import { ImageViewer } from './pages/imaging/ImageViewer';
import { BedBoard } from './pages/hospital/BedBoard';
import { EdBoard } from './pages/ed/EdBoard';
import { BirthsPage } from './pages/births/BirthsPage';
import { TemporaryIdentitiesPage } from './pages/births/TemporaryIdentitiesPage';
import { ImagingWorklist } from './pages/imaging/ImagingWorklist';
import { UnitsPage } from './pages/director/UnitsPage';
import { PartnersPage } from './pages/ministry/PartnersPage';
import { ApiDocsPage } from './pages/developers/ApiDocsPage';
import { PortalStays } from './pages/patient/PortalStays';
import { PortalImaging } from './pages/patient/PortalImaging';
import { t } from './i18n';
import { DirectorDuplicates } from './pages/director/DirectorDuplicates';
import { PortalDocuments } from './pages/patient/PortalDocuments';
import { PortalConsents } from './pages/patient/PortalConsents';
import { DoctorCover } from './pages/doctor/DoctorCover';
import { Navigate, Route, Routes } from 'react-router-dom';
import { HOME_BY_ROLE, useAuth } from './auth/AuthContext';
import { Layout } from './components/Layout';
import { RequireRole } from './components/RequireRole';
import { EmptyState, Loading } from './components/ui';
import { DirectorDashboard } from './pages/director/DirectorDashboard';
import { DirectorPatients } from './pages/director/DirectorPatients';
import { StaffPage } from './pages/shared/StaffPage';
import { DoctorHome } from './pages/doctor/DoctorHome';
import { DoctorPatients } from './pages/doctor/DoctorPatients';
import { DoctorSchedule } from './pages/doctor/DoctorSchedule';
import { PatientChart } from './pages/doctor/PatientChart';
import { RegisterPatient } from './pages/doctor/RegisterPatient';
import { FacilityStatsPage } from './pages/ministry/FacilityStatsPage';
import { MinistryFacilities } from './pages/ministry/MinistryFacilities';
import { NationalDashboard } from './pages/ministry/NationalDashboard';
import { PortalAccessLog } from './pages/patient/PortalAccessLog';
import { PortalAccount } from './pages/patient/PortalAccount';
import { PortalAppointments } from './pages/patient/PortalAppointments';
import { PortalHistory } from './pages/patient/PortalHistory';
import { PortalHome } from './pages/patient/PortalHome';
import { PortalResults } from './pages/patient/PortalResults';
import { AccountPage } from './pages/shared/AccountPage';
import { ActivatePage } from './pages/shared/ActivatePage';
import { AuditLogPage } from './pages/shared/AuditLogPage';
import { LoginPage } from './pages/shared/LoginPage';
import { NotificationsPage } from './components/Notifications';
import { EmergencyReviewPage } from './pages/director/EmergencyReviewPage';
import { IntegrationsPage } from './pages/director/IntegrationsPage';
import { EmergencyOversightPage } from './pages/ministry/EmergencyOversightPage';
import { PortalReferrals } from './pages/patient/PortalReferrals';
import { AnnouncementsManagePage } from './pages/shared/AnnouncementsManagePage';
import { MessagesPage } from './pages/shared/MessagesPage';
import { MfaSetupPage } from './pages/shared/MfaSetupPage';
import { ForgotPasswordPage, ResetPasswordPage } from './pages/shared/PasswordResetPages';
import { ReferralsPage } from './pages/shared/ReferralsPage';
import { ReportsPage } from './pages/shared/ReportsPage';
import { NurseHome } from './pages/nurse/NurseHome';
import { NurseSchedule } from './pages/nurse/NurseSchedule';
import { PharmacyQueue } from './pages/pharmacy/PharmacyQueue';
import { ReceptionAppointments } from './pages/reception/ReceptionAppointments';
import { ReceptionPatients } from './pages/reception/ReceptionPatients';
import { ReceptionToday } from './pages/reception/ReceptionToday';
import { ChannelsPage } from './pages/shared/ChannelsPage';
import { TasksPage } from './pages/shared/TasksPage';
import type { Role } from './api/types';
import type { ReactElement } from 'react';
import { DeathsPage } from './pages/deaths/DeathsPage';
import { CertificatesPage } from './pages/certificates/CertificatesPage';
import { VerifyCertificatePage } from './pages/certificates/VerifyCertificatePage';
import { PortalCertificatesPage } from './pages/certificates/PortalCertificatesPage';
import { WaitingListsPage } from './pages/waiting/WaitingListsPage';
import { PortalWaitingListsPage } from './pages/waiting/PortalWaitingListsPage';
import { RegistersPage } from './pages/registers/RegistersPage';
import { IncidentsPage } from './pages/incidents/IncidentsPage';
import { MaternityPage } from './pages/maternity/MaternityPage';
import { PortalPregnancyPage } from './pages/maternity/PortalPregnancyPage';
import { ScreeningPage } from './pages/screening/ScreeningPage';
import { PortalScreeningPage } from './pages/screening/PortalScreeningPage';
import { EPrescriptionsPage } from './pages/erx/EPrescriptionsPage';
import { PortalEPrescriptionsPage } from './pages/erx/PortalEPrescriptionsPage';
import { LicencesPage } from './pages/licences/LicencesPage';
import { ComplaintsPage } from './pages/complaints/ComplaintsPage';
import { PortalComplaintsPage } from './pages/complaints/PortalComplaintsPage';
import { OrganDonationRegistryPage } from './pages/directives/OrganDonationRegistryPage';
import { PortalWishesPage } from './pages/directives/PortalWishesPage';

const STAFF: Role[] = ['MINISTRY', 'DIRECTOR', 'DOCTOR', 'NURSE', 'PHARMACIST', 'RECEPTION'];
const guard = (roles: Role[], el: ReactElement) => <RequireRole roles={roles}>{el}</RequireRole>;

function HomeRedirect() {
  const { status, user } = useAuth();
  if (status === 'loading') return <Loading label={t('Restoring your session…')} />;
  return <Navigate to={user ? HOME_BY_ROLE[user.role] : '/login'} replace />;
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/activate" element={<ActivatePage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route path="/setup-two-step" element={<MfaSetupPage />} />
      <Route path="/verify" element={<VerifyCertificatePage />} />
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
          element={guard(['DOCTOR', 'NURSE', 'RECEPTION', 'DIRECTOR'], <TemporaryIdentitiesPage />)}
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
        <Route path="/pharmacy/stock" element={guard(['PHARMACIST', 'DIRECTOR'], <StockPage />)} />
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
          element={guard(['DOCTOR', 'PHARMACIST', 'DIRECTOR', 'MINISTRY'], <EPrescriptionsPage />)}
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
        <Route path="/deaths" element={guard(['DOCTOR', 'DIRECTOR', 'MINISTRY'], <DeathsPage />)} />
        <Route path="/certificates" element={guard(['DOCTOR', 'DIRECTOR'], <CertificatesPage />)} />
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
        <Route path="/director/duplicates" element={guard(['DIRECTOR'], <DirectorDuplicates />)} />
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
        <Route path="/messages" element={guard(['PATIENT', 'DOCTOR', 'NURSE'], <MessagesPage />)} />
        <Route path="/nurse" element={guard(['NURSE'], <NurseHome />)} />
        <Route path="/nurse/patients" element={guard(['NURSE'], <DoctorPatients />)} />
        <Route path="/nurse/patients/:patientId" element={guard(['NURSE'], <PatientChart />)} />
        <Route path="/nurse/schedule" element={guard(['NURSE'], <NurseSchedule />)} />
        <Route path="/pharmacy" element={guard(['PHARMACIST'], <PharmacyQueue />)} />
        <Route path="/reception" element={guard(['RECEPTION'], <ReceptionToday />)} />
        <Route path="/reception/patients" element={guard(['RECEPTION'], <ReceptionPatients />)} />
        <Route path="/reception/patients/new" element={guard(['RECEPTION'], <RegisterPatient />)} />
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
  );
}
