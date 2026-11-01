import { Navigate, useNavigate } from 'react-router-dom';
import { HOME_BY_ROLE, needsMfaEnrollment, useAuth } from '../../auth/AuthContext';
import { TwoStepEnrollment } from '../../components/TwoStep';
import { Alert, Button, Loading } from '../../components/ui';
import { AuthCard } from './LoginPage';

/** Mandatory enrollment for staff before they can open their workspace. */
export function MfaSetupPage() {
  const { status, user, logout } = useAuth();
  const navigate = useNavigate();
  if (status === 'loading') return <Loading />;
  if (!user) return <Navigate to="/login" replace />;
  if (!needsMfaEnrollment(user)) return <Navigate to={HOME_BY_ROLE[user.role]} replace />;
  return (
    <AuthCard>
      <h1>Set up two-step sign-in</h1>
      <Alert tone="info">
        Your organisation requires two-step sign-in for every staff account before you can access
        patient information.
      </Alert>
      <TwoStepEnrollment onDone={() => navigate(HOME_BY_ROLE[user.role], { replace: true })} />
      <div style={{ marginTop: '1rem' }}>
        <Button
          variant="ghost"
          size="sm"
          onClick={async () => {
            await logout();
            navigate('/login', { replace: true });
          }}
        >
          Sign out
        </Button>
      </div>
    </AuthCard>
  );
}
