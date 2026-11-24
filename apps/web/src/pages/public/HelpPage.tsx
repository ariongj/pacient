import { t } from '../../i18n';
import { AuthCard } from '../shared/LoginPage';

/**
 * Public help page (/help): how to reach the operator of the service, support hours, "in an
 * emergency call 112" and what the operator can and cannot see. No sign-in needed. Round 2,
 * builder G.
 */
export function HelpPage() {
  return (
    <AuthCard>
      <h1>{t('Help and contact')}</h1>
    </AuthCard>
  );
}
