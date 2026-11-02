import { Fragment, createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { sq } from './sq';

/**
 * Lightweight i18n. Source strings are written in English and wrapped in t(); the Albanian
 * dictionary maps English text to its translation, with {placeholders} for values. Anything not
 * yet translated falls back to English, so a missing entry never breaks a screen.
 *
 *   t('Test results')                       → "Rezultatet e analizave"
 *   t('{count} pending', { count: 3 })      → "3 në pritje"
 *   tn(n, '{count} result', '{count} results')
 */
export type Locale = 'sq' | 'en';
export const LOCALES: { value: Locale; label: string; short: string }[] = [
  { value: 'sq', label: 'Shqip', short: 'SQ' },
  { value: 'en', label: 'English', short: 'EN' },
];

const STORAGE_KEY = 'pacient.locale';
/** Set when the user picked a language before signing in, so it can be saved to their profile. */
export const CHOSEN_KEY = 'pacient.localeChosen';

function initialLocale(): Locale {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'sq' || stored === 'en') return stored;
  } catch {
    /* storage unavailable */
  }
  return 'sq';
}

let current: Locale = initialLocale();
if (typeof document !== 'undefined') document.documentElement.lang = current;

export const getLocale = () => current;
/** BCP 47 tag for Intl formatting. */
export const intlLocale = () => (current === 'sq' ? 'sq-AL' : 'en-GB');

type Vars = Record<string, string | number | null | undefined>;

export function t(text: string, vars?: Vars): string {
  const template = current === 'sq' ? (sq[text] ?? text) : text;
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (m, k: string) =>
    vars[k] === undefined || vars[k] === null ? m : String(vars[k]),
  );
}

/** Singular/plural (Albanian, like English, distinguishes 1 from everything else). */
export function tn(count: number, one: string, other: string, vars?: Vars): string {
  return t(count === 1 ? one : other, { count, ...vars });
}

const LocaleContext = createContext<{ locale: Locale; setLocale: (l: Locale) => void } | null>(
  null,
);

/**
 * Holds the current language. Changing it re-mounts the children so every t() call re-renders –
 * place it inside the auth provider so the session survives a language switch.
 */
export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setState] = useState<Locale>(current);
  const setLocale = useCallback((l: Locale) => {
    if (l === current) return;
    current = l;
    document.documentElement.lang = l;
    try {
      localStorage.setItem(STORAGE_KEY, l);
    } catch {
      /* ignore */
    }
    setState(l);
  }, []);
  return (
    <LocaleContext.Provider value={{ locale, setLocale }}>
      <Fragment key={locale}>{children}</Fragment>
    </LocaleContext.Provider>
  );
}

export function useLocale() {
  const ctx = useContext(LocaleContext);
  if (!ctx) throw new Error('useLocale must be used inside LocaleProvider');
  return ctx;
}
