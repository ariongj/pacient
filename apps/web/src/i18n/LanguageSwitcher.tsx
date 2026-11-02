import { useEffect } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { CHOSEN_KEY, LOCALES, t, useLocale, type Locale } from '.';

/** Shqip / English toggle. Signed-in users keep their choice on every device. */
export function LanguageSwitcher({ compact = false }: { compact?: boolean }) {
  const { locale, setLocale } = useLocale();
  const { user } = useAuth();

  function choose(l: Locale) {
    if (l === locale) return;
    if (user) {
      void api('/auth/me/preferences', { method: 'PATCH', body: { locale: l } }).catch(() => {
        /* the interface still switches; the preference is saved next time */
      });
    } else {
      try {
        sessionStorage.setItem(CHOSEN_KEY, '1');
      } catch {
        /* ignore */
      }
    }
    setLocale(l);
  }

  return (
    <div className="lang-switch" role="group" aria-label={t('Language')}>
      {LOCALES.map((l) => (
        <button
          key={l.value}
          type="button"
          lang={l.value}
          aria-pressed={locale === l.value}
          className={locale === l.value ? 'active' : undefined}
          onClick={() => choose(l.value)}
          title={l.label}
        >
          {compact ? l.short : l.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Keeps the interface language and the signed-in user's saved preference in step: a language
 * picked on the sign-in page is saved to the profile; otherwise the profile's language is used.
 */
export function LocaleSync() {
  const { user } = useAuth();
  const { locale, setLocale } = useLocale();
  const userId = user?.id;
  const saved = user?.locale;
  useEffect(() => {
    if (!userId || !saved) return;
    let chosen = false;
    try {
      chosen = sessionStorage.getItem(CHOSEN_KEY) === '1';
      sessionStorage.removeItem(CHOSEN_KEY);
    } catch {
      /* ignore */
    }
    if (chosen) {
      if (saved !== locale) {
        void api('/auth/me/preferences', { method: 'PATCH', body: { locale } }).catch(() => {});
      }
    } else if (saved !== locale) {
      setLocale(saved);
    }
    // Only when a different user signs in.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);
  return null;
}
