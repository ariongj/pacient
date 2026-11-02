/**
 * Minimal HL7 v2.x (ER7, pipe-delimited) parser and builder for laboratory messages
 * (ORU^R01 results in, ORM^O01 orders out, ACK replies). It implements the parts of the standard a
 * laboratory interface needs – segments, fields, components, repetitions and escape sequences – and
 * deliberately nothing more. Interfaces with a real laboratory must still be validated against that
 * laboratory's conformance profile (blueprint §6).
 */
export interface Hl7Segment {
  name: string;
  /** fields[n] is SEG-n (for MSH, fields[1] is MSH-1, the field separator). */
  fields: string[];
}

export interface Hl7Message {
  segments: Hl7Segment[];
  get(name: string): Hl7Segment | undefined;
  all(name: string): Hl7Segment[];
}

export class Hl7Error extends Error {}

const ESCAPES: Record<string, string> = { F: '|', S: '^', T: '&', R: '~', E: '\\' };

export function unescapeHl7(value: string): string {
  return value.replace(/\\([FSTRE])\\/g, (_, c: string) => ESCAPES[c]!).replace(/\\\.br\\/g, '\n');
}

export function escapeHl7(value: string): string {
  return value
    .replace(/\\/g, '\\E\\')
    .replace(/\|/g, '\\F\\')
    .replace(/\^/g, '\\S\\')
    .replace(/&/g, '\\T\\')
    .replace(/~/g, '\\R\\')
    .replace(/\r?\n/g, '\\.br\\');
}

export function parseHl7(raw: string): Hl7Message {
  const text = raw.replace(/^\uFEFF/, '').trim();
  if (!text.startsWith('MSH')) throw new Hl7Error('Message must start with an MSH segment');
  const fieldSep = text[3];
  if (fieldSep !== '|') throw new Hl7Error('Only the standard "|" field separator is supported');
  const segments = text
    .split(/\r\n|\r|\n/)
    .filter((l) => l.trim())
    .map((line) => {
      const parts = line.split('|');
      const name = parts[0]!;
      if (!/^[A-Z][A-Z0-9]{2}$/.test(name)) throw new Hl7Error(`Invalid segment name "${name}"`);
      // Normalise so that fields[n] is SEG-n for every segment type.
      const fields = name === 'MSH' ? ['MSH', '|', ...parts.slice(1)] : parts;
      return { name, fields };
    });
  return {
    segments,
    get: (name) => segments.find((s) => s.name === name),
    all: (name) => segments.filter((s) => s.name === name),
  };
}

/** Field n of a segment; component c (1-based) and repetition r (0-based) optional. */
export function field(seg: Hl7Segment | undefined, n: number, c?: number, r = 0): string {
  if (!seg) return '';
  const value = seg.fields[n] ?? '';
  if (seg.name === 'MSH' && n <= 2) return value;
  const rep = value.split('~')[r] ?? '';
  return unescapeHl7(c ? (rep.split('^')[c - 1] ?? '') : rep).trim();
}

/** HL7 TS (YYYYMMDD[HHMM[SS]][+/-ZZZZ]) → Date; null if absent or invalid. */
export function parseHl7Date(ts: string): Date | null {
  const m = /^(\d{4})(\d{2})(\d{2})(?:(\d{2})(\d{2})(?:(\d{2}))?)?(?:\.\d+)?([+-]\d{4})?$/.exec(
    ts.trim(),
  );
  if (!m) return null;
  const [, y, mo, d, h = '00', mi = '00', s = '00', tz] = m;
  const offset = tz ? `${tz.slice(0, 3)}:${tz.slice(3)}` : 'Z';
  const date = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}${offset}`);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatHl7Date(d: Date, dateOnly = false): string {
  const iso = d.toISOString().replace(/[-:T]/g, '');
  return dateOnly ? iso.slice(0, 8) : `${iso.slice(0, 14)}+0000`;
}

const seg = (...fields: string[]) => fields.join('|');

export interface MshInfo {
  sendingApp: string;
  sendingFacility: string;
  receivingApp: string;
  receivingFacility: string;
  type: string;
  controlId: string;
}

function msh(m: MshInfo) {
  return seg(
    'MSH',
    '^~\\&',
    m.sendingApp,
    m.sendingFacility,
    m.receivingApp,
    m.receivingFacility,
    formatHl7Date(new Date()),
    '',
    m.type,
    m.controlId,
    'P',
    '2.5.1',
  );
}

/** Acknowledgement: AA accepted, AE application error, AR rejected. */
export function buildAck(
  original: Hl7Message | null,
  code: 'AA' | 'AE' | 'AR',
  text: string,
  controlId: string,
) {
  const o = original?.get('MSH');
  return [
    msh({
      sendingApp: 'PACIENT',
      sendingFacility: field(o, 6) || 'PACIENT',
      receivingApp: field(o, 3),
      receivingFacility: field(o, 4),
      type: `ACK^${field(o, 9, 2) || 'R01'}^ACK`,
      controlId,
    }),
    seg('MSA', code, field(o, 10), escapeHl7(text).slice(0, 80)),
  ].join('\r');
}

export interface OrderForHl7 {
  placerOrderNumber: string;
  testCode: string;
  testName: string;
  priority: 'ROUTINE' | 'URGENT' | 'STAT';
  specimen: string | null;
  clinicalNotes: string | null;
  createdAt: Date;
  orderingDoctor: { id: string; name: string; licenseNumber: string | null };
  patient: {
    nationalId: string;
    firstName: string;
    lastName: string;
    dateOfBirth: string;
    sex: string;
  };
  facilityCode: string;
}

const SEX: Record<string, string> = { FEMALE: 'F', MALE: 'M', OTHER: 'O', UNKNOWN: 'U' };
const PRIORITY: Record<string, string> = { ROUTINE: 'R', URGENT: 'A', STAT: 'S' };

/** New-order message (ORM^O01) a laboratory system can import. */
export function buildOrm(o: OrderForHl7, controlId: string): string {
  const doctor = `${o.orderingDoctor.licenseNumber ?? o.orderingDoctor.id}^${escapeHl7(o.orderingDoctor.name)}`;
  return [
    msh({
      sendingApp: 'PACIENT',
      sendingFacility: o.facilityCode,
      receivingApp: 'LIS',
      receivingFacility: o.facilityCode,
      type: 'ORM^O01^ORM_O01',
      controlId,
    }),
    seg(
      'PID',
      '1',
      '',
      `${o.patient.nationalId}^^^KS^NI`,
      '',
      `${escapeHl7(o.patient.lastName)}^${escapeHl7(o.patient.firstName)}`,
      '',
      o.patient.dateOfBirth.replace(/-/g, ''),
      SEX[o.patient.sex] ?? 'U',
    ),
    seg(
      'ORC',
      'NW',
      o.placerOrderNumber,
      '',
      '',
      '',
      '',
      '',
      '',
      formatHl7Date(o.createdAt),
      '',
      '',
      doctor,
    ),
    seg(
      'OBR',
      '1',
      o.placerOrderNumber,
      '',
      `${o.testCode}^${escapeHl7(o.testName)}^LN`,
      PRIORITY[o.priority] ?? 'R',
      formatHl7Date(o.createdAt),
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      escapeHl7(o.specimen ?? ''),
      doctor,
    ),
    ...(o.clinicalNotes ? [seg('NTE', '1', 'L', escapeHl7(o.clinicalNotes))] : []),
  ].join('\r');
}
