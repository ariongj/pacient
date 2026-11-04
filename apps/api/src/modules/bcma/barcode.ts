/**
 * Medicine pack barcodes. Accepts EAN-13, EAN-8, UPC-A, GTIN-14 and GS1 element strings that
 * start with AI (01) (as encoded in GS1 DataMatrix / GS1-128); returns a normalised GTIN-13 when
 * possible so it can be compared with medication_catalog.barcode.
 */
export function gtinCheckDigit(digitsWithoutCheck: string): number {
  let sum = 0;
  const d = digitsWithoutCheck.split('').reverse();
  for (let i = 0; i < d.length; i++) sum += Number(d[i]) * (i % 2 === 0 ? 3 : 1);
  return (10 - (sum % 10)) % 10;
}

export function isValidGtin(code: string): boolean {
  if (!/^\d{8}$|^\d{12,14}$/.test(code)) return false;
  return gtinCheckDigit(code.slice(0, -1)) === Number(code.at(-1));
}

/** Normalises a scanned value to GTIN-13 (or returns the trimmed value when it is not a GTIN). */
export function normaliseBarcode(raw: string): string {
  // eslint-disable-next-line no-control-regex
  let v = raw.trim().replace(/[\u0000-\u001f]/g, '');
  const gs1 = /^(?:\]d2|\]C1)?01(\d{14})/.exec(v);
  if (gs1) v = gs1[1]!;
  if (/^\d{14}$/.test(v) && v.startsWith('0')) v = v.slice(1);
  if (/^\d{12}$/.test(v)) v = `0${v}`; // UPC-A → EAN-13
  return v;
}

/** Internal-use EAN-13 (prefix 200–299) with a valid check digit, for demo catalogue items. */
export function internalEan13(seq: number, prefix = 290): string {
  const body = `${prefix}${String(seq).padStart(9, '0')}`.slice(0, 12);
  return `${body}${gtinCheckDigit(body)}`;
}
