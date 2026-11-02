import { env } from '../config/env.js';

const E164 = /^\+[1-9][0-9]{6,14}$/;

/**
 * Normalises user input to E.164: "044 123 456" → "+38344123456" (default country code),
 * "00383 44 123 456" → "+38344123456". Returns null when the result is not a plausible number.
 */
export function normalizePhone(
  input: string,
  defaultCountryCode = env.SMS_DEFAULT_COUNTRY_CODE,
): string | null {
  let s = input.trim().replace(/[\s().-]/g, '');
  if (s.startsWith('00')) s = `+${s.slice(2)}`;
  else if (s.startsWith('0')) s = `${defaultCountryCode}${s.slice(1)}`;
  else if (!s.startsWith('+')) s = `${defaultCountryCode}${s}`;
  return E164.test(s) ? s : null;
}

/** "+38344123456" → "+383 •••• 456" for display without revealing the full number. */
export const maskPhone = (phone: string) => `${phone.slice(0, 4)} •••• ${phone.slice(-3)}`;
