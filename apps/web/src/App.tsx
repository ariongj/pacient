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

function HomeRedirect() {
  const { status, user } = useAuth();
  if (status === 'loading') return <Loading label="Restoring your session…" />;
  return <Navigate to={user ? HOME_BY_ROLE[user.role] : '/login'} replace />;
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/activate" element={<ActivatePage />} />
      <Route path="/" element={<HomeRedirect />} />

      <Route
        element={
          <RequireRole roles={['PATIENT', 'DOCTOR', 'DIRECTOR', 'MINISTRY']}>
            <Layout />
          </RequireRole>
        }
      >
        <Route path="/account" element={<AccountPage />} />

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
          path="/ministry/audit"
          element={
            <RequireRole roles={['MINISTRY']}>
              <AuditLogPage />
            </RequireRole>
          }
        />

        <Route
          path="*"
          element={
            <EmptyState title="Page not found">Check the address or use the menu.</EmptyState>
          }
        />
      </Route>
    </Routes>
  );
}
