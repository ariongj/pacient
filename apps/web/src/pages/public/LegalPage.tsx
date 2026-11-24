import { useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { kindPath, useLegalDocument, type LegalKind } from '../../api/platform';
import { useAuth } from '../../auth/AuthContext';
import { ErrorAlert, Loading } from '../../components/ui';
import { formatDate } from '../../format';
import { t, useLocale } from '../../i18n';
import { LanguageSwitcher } from '../../i18n/LanguageSwitcher';
import { LegalText } from '../admin/platform/LegalText';

/**
 * Public terms of use (/legal/terms) and privacy notice (/legal/privacy): the current published
 * version in the reader's language, with the operator's contact details. No sign-in needed.
 */
export function LegalPage() {
  const { pathname } = useLocation();
  const kind: LegalKind = pathname.startsWith(kindPath('PRIVACY')) ? 'PRIVACY' : 'TERMS';
  const other: LegalKind = kind === 'TERMS' ? 'PRIVACY' : 'TERMS';
  const { locale } = useLocale();
  const { user } = useAuth();
  const doc = useLegalDocument(kind, locale);
  const fallbackTitle = kind === 'TERMS' ? t('Terms of use') : t('Privacy notice');
  const title = doc.data?.title ?? fallbackTitle;

  useEffect(() => {
    document.title = `${title} · Pacient`;
  }, [title]);

  const notPublished = doc.error instanceof ApiError && doc.error.status === 404;
  const operator = doc.data?.operator;
  return (
    <div className="auth-page">
      <main className="auth-card" id="main" style={{ width: 'min(46rem, 100%)' }}>
        <div className="brand brand-lg">
          <span className="brand-mark" aria-hidden="true">
            +
          </span>
          <strong>Pacient</strong>
          <span style={{ marginLeft: 'auto' }}>
            <LanguageSwitcher />
          </span>
        </div>
        <h1>{title}</h1>
        {doc.isPending && <Loading />}
        {notPublished && (
          <p className="muted">
            {t(
              'Not published yet. The operator of the service publishes this text before go-live.',
            )}
          </p>
        )}
        {doc.error && !notPublished && <ErrorAlert error={doc.error} />}
        {doc.data && (
          <>
            <p className="muted">
              {t('Version {version}, in force since {date}', {
                version: doc.data.version,
                date: formatDate(doc.data.publishedAt),
              })}
              {doc.data.locale !== locale && ` · ${t('Not yet available in your language.')}`}
            </p>
            <LegalText body={doc.data.body} />
            {operator && (operator.name || operator.supportEmail || operator.privacyEmail) && (
              <section aria-label={t('Contact')} className="muted" style={{ marginTop: '1.5rem' }}>
                {operator.name && (
                  <p>
                    <strong>{operator.name}</strong>
                    {operator.address && <> · {operator.address}</>}
                  </p>
                )}
                <p>
                  {operator.supportEmail && (
                    <>
                      {t('Support')}:{' '}
                      <a href={`mailto:${operator.supportEmail}`}>{operator.supportEmail}</a>
                    </>
                  )}
                  {operator.supportEmail && operator.privacyEmail && ' · '}
                  {operator.privacyEmail && (
                    <>
                      {t('Personal data')}:{' '}
                      <a href={`mailto:${operator.privacyEmail}`}>{operator.privacyEmail}</a>
                    </>
                  )}
                </p>
              </section>
            )}
          </>
        )}
        <p style={{ marginTop: '1.5rem' }}>
          <Link to={kindPath(other)}>
            {other === 'TERMS' ? t('Terms of use') : t('Privacy notice')}
          </Link>{' '}
          · <Link to={user ? '/' : '/login'}>{user ? t('Back to Pacient') : t('Sign in')}</Link>
        </p>
      </main>
    </div>
  );
}
