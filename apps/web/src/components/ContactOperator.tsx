import { Link } from 'react-router-dom';
import { usePlatformInfo, type PlatformInfo } from '../api/platform';
import { useAuth } from '../auth/AuthContext';
import { t } from '../i18n';

/** A phone number as a tel: link (spaces, dots and dashes dropped). */
export const telHref = (phone: string) => `tel:${phone.replace(/[^\d+]/g, '')}`;

/** Support e-mail, phone and hours, as links, separated by " · "; null when none is set. */
export function SupportContacts({ info }: { info: PlatformInfo }) {
  const parts = [
    info.supportEmail && (
      <a key="email" href={`mailto:${info.supportEmail}`}>
        {info.supportEmail}
      </a>
    ),
    info.supportPhone && (
      <a key="phone" href={telHref(info.supportPhone)}>
        {info.supportPhone}
      </a>
    ),
    info.supportHours && (
      <span key="hours">{t('Support hours: {hours}', { hours: info.supportHours })}</span>
    ),
  ].filter(Boolean);
  if (!parts.length) return null;
  return (
    <>
      {parts.map((p, i) => (
        <span key={i}>
          {i > 0 && ' · '}
          {p}
        </span>
      ))}
    </>
  );
}

/**
 * How to reach the operator of the service – support e-mail, phone and hours from /platform/info –
 * in three places: the Layout footer ('footer'), the sign-in page ('login') and inside the
 * subscription alerts of a director ('inline'). Directors and IT support also get the way to
 * write a request in Pacient. Shows only what the operator has filled in; the help page link is
 * always there.
 */
export function ContactOperator({ variant }: { variant: 'footer' | 'login' | 'inline' }) {
  const info = usePlatformInfo();
  const { user } = useAuth();
  const contacts = info.data ? <SupportContacts info={info.data} /> : null;
  const hasContacts = Boolean(
    info.data && (info.data.supportEmail || info.data.supportPhone || info.data.supportHours),
  );
  const canRequest = user?.role === 'DIRECTOR' || user?.role === 'IT_SUPPORT';

  if (variant === 'footer') {
    return (
      <span className="contact-operator">
        {' · '}
        {hasContacts && (
          <>
            {t('Support')}: {contacts}
            {' · '}
          </>
        )}
        <Link to="/help">{t('Help and contact')}</Link>
      </span>
    );
  }

  if (variant === 'login') {
    return (
      <p className="muted" style={{ fontSize: '0.85rem' }}>
        {t('Trouble signing in? Staff ask their facility’s IT support first.')}{' '}
        {hasContacts && (
          <>
            {t('The operator of the service')}: {contacts}.{' '}
          </>
        )}
        <Link to="/help">{t('Help and contact')}</Link>
      </p>
    );
  }

  return (
    <p style={{ margin: '0.5rem 0 0' }}>
      {hasContacts && (
        <>
          {t('Contact the operator')}: {contacts}
          {canRequest && ' · '}
        </>
      )}
      {canRequest && <Link to="/operator-requests?new=BILLING">{t('Write a request')}</Link>}
      {!hasContacts && !canRequest && <Link to="/help">{t('Help and contact')}</Link>}
    </p>
  );
}
