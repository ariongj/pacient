import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { kindPath, usePlatformInfo } from '../../api/platform';
import { useAuth } from '../../auth/AuthContext';
import { SupportContacts } from '../../components/ContactOperator';
import { Alert, Loading } from '../../components/ui';
import { t } from '../../i18n';
import { AuthCard } from '../shared/LoginPage';

/**
 * Public help page (/help): how to reach the operator of the service, support hours, "in an
 * emergency call 112" and what the operator can and cannot see. No sign-in needed. Round 2,
 * builder G.
 */
export function HelpPage() {
  const info = usePlatformInfo();
  const { user } = useAuth();
  const canRequest = user?.role === 'DIRECTOR' || user?.role === 'IT_SUPPORT';
  const i = info.data;
  const hasContacts = Boolean(i && (i.supportEmail || i.supportPhone || i.supportHours));
  const title = t('Help and contact');
  useEffect(() => {
    document.title = `${title} · Pacient`;
  }, [title]);
  return (
    <AuthCard>
      <h1>{title}</h1>
      <Alert tone="danger" title={t('In an emergency call 112')}>
        {t(
          'Pacient is not an emergency service, and neither its support nor messages to your care team are answered around the clock.',
        )}
      </Alert>

      <section aria-labelledby="help-operator">
        <h2 id="help-operator">{t('The operator of the service')}</h2>
        {info.isPending && <Loading />}
        {i?.operatorName && (
          <p>
            <strong>{i.operatorName}</strong>
            {i.operatorAddress && <> · {i.operatorAddress}</>}
          </p>
        )}
        {i && hasContacts ? (
          <p>
            <SupportContacts info={i} />
          </p>
        ) : (
          !info.isPending && (
            <p className="muted">
              {t('The operator has not published its contact details yet. Ask your facility.')}
            </p>
          )
        )}
        {i?.privacyEmail && (
          <p>
            {t('Personal data')}: <a href={`mailto:${i.privacyEmail}`}>{i.privacyEmail}</a>
          </p>
        )}
        {canRequest && (
          <p>
            <Link to="/operator-requests">{t('Write a request to the operator')}</Link>
          </p>
        )}
      </section>

      <section aria-labelledby="help-who">
        <h2 id="help-who">{t('Who helps with what')}</h2>
        <ul>
          <li>
            {t(
              'Patients: questions about your health record, appointments or results go to your health facility or your care team. The operator cannot answer them.',
            )}
          </li>
          <li>
            {t('Staff: your facility’s IT support helps with your account, sign-in and devices.')}
          </li>
          <li>
            {t(
              'Directors and IT support of a facility write to the operator in Pacient under “Contact the operator”: billing, accounts, technical problems, data protection and security incidents.',
            )}
          </li>
        </ul>
        <p className="muted">
          {t(
            'Never send patient information to the operator: no names, personal numbers or health details.',
          )}
        </p>
      </section>

      <section aria-labelledby="help-sees">
        <h2 id="help-sees">{t('What the operator can and cannot see')}</h2>
        <p>{t('The operator’s administrators can see:')}</p>
        <ul>
          <li>{t('accounts: name, e-mail, role, facility, and whether sign-in works')}</li>
          <li>{t('the facilities that are customers, their subscriptions and invoices')}</li>
          <li>{t('the requests facilities send them')}</li>
          <li>{t('how the service is running, without health data')}</li>
        </ul>
        <p>{t('They cannot see:')}</p>
        <ul>
          <li>
            {t(
              'health records: diagnoses, results, medicines, notes, documents or messages with care teams',
            )}
          </li>
          <li>{t('lists of patients, or who is a patient of which facility')}</li>
        </ul>
        <p className="muted">
          {t('Every access to a health record is logged, and patients can see who opened theirs.')}
        </p>
      </section>

      <p style={{ marginTop: '1.5rem' }}>
        <Link to={kindPath('TERMS')}>{t('Terms of use')}</Link> ·{' '}
        <Link to={kindPath('PRIVACY')}>{t('Privacy notice')}</Link> ·{' '}
        <Link to={user ? '/' : '/login'}>{user ? t('Back to Pacient') : t('Sign in')}</Link>
      </p>
    </AuthCard>
  );
}
