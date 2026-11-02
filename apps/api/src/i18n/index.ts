import { sq } from './sq.js';

/**
 * Server-side translations for messages people receive (notifications, email, SMS). Source texts
 * are English and double as keys; the Albanian dictionary maps them to their translation, with
 * {placeholders} for values. Anything not yet translated falls back to English.
 */
export type Locale = 'sq' | 'en';
export const DEFAULT_LOCALE: Locale = 'sq';

export const toLocale = (value: string | null | undefined): Locale =>
  value === 'en' ? 'en' : value === 'sq' ? 'sq' : DEFAULT_LOCALE;

export type TrVars = Record<string, string | number | Date | null | undefined>;

const dateFormats = new Map<Locale, Intl.DateTimeFormat>();
/** Dates in messages: "05 Nov, 14:30" / "05 nën, 14:30", in local (Kosovo) time. */
export function formatDateFor(locale: Locale, d: Date): string {
  let f = dateFormats.get(locale);
  if (!f) {
    f = new Intl.DateTimeFormat(locale === 'sq' ? 'sq-AL' : 'en-GB', {
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZone: 'Europe/Belgrade',
    });
    dateFormats.set(locale, f);
  }
  return f.format(d);
}

/** Translates an English source text into `locale` and fills in {placeholders}. */
export function tr(locale: Locale, text: string, vars?: TrVars): string {
  const template = locale === 'sq' ? (sq[text] ?? text) : text;
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (m, k: string) => {
    const v = vars[k];
    if (v === undefined || v === null) return m;
    return v instanceof Date ? formatDateFor(locale, v) : String(v);
  });
}
