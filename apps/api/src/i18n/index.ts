import { sq } from './sq.js';
import { sr } from './sr.js';

/**
 * Server-side translations for messages people receive (notifications, email, SMS). Source texts
 * are English and double as keys; the Albanian and Serbian dictionaries map them to their translation, with
 * {placeholders} for values. Anything not yet translated falls back to English.
 */
export type Locale = 'sq' | 'en' | 'sr';
export const DEFAULT_LOCALE: Locale = 'sq';

export const toLocale = (value: string | null | undefined): Locale =>
  value === 'en' || value === 'sq' || value === 'sr' ? value : DEFAULT_LOCALE;

const DICTIONARIES: Partial<Record<Locale, Record<string, string>>> = { sq, sr };

export type TrVars = Record<string, string | number | Date | null | undefined>;

const dateFormats = new Map<Locale, Intl.DateTimeFormat>();
/** Dates in messages: "05 Nov, 14:30" / "05 nën, 14:30", in local (Kosovo) time. */
export function formatDateFor(locale: Locale, d: Date): string {
  let f = dateFormats.get(locale);
  if (!f) {
    f = new Intl.DateTimeFormat(
      locale === 'sq' ? 'sq-AL' : locale === 'sr' ? 'sr-Latn-RS' : 'en-GB',
      {
        day: '2-digit',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
        timeZone: 'Europe/Belgrade',
      },
    );
    dateFormats.set(locale, f);
  }
  return f.format(d);
}

/** Translates an English source text into `locale` and fills in {placeholders}. */
export function tr(locale: Locale, text: string, vars?: TrVars): string {
  const template = DICTIONARIES[locale]?.[text] ?? text;
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (m, k: string) => {
    const v = vars[k];
    if (v === undefined || v === null) return m;
    return v instanceof Date ? formatDateFor(locale, v) : String(v);
  });
}
