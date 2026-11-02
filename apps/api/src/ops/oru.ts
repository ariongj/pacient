import { escapeHl7, formatHl7Date } from '../lib/hl7.js';

/**
 * Builds an ORU^R01 result message as a laboratory system would send it. Used by the development
 * lab simulator and by the integration tests.
 */
export interface OruInput {
  controlId: string;
  placerOrderNumber: string;
  fillerOrderNumber?: string;
  patient: {
    nationalId: string;
    lastName: string;
    firstName: string;
    dateOfBirth: string;
    sex?: string;
  };
  observations: {
    code: string;
    name: string;
    value: string;
    unit?: string;
    referenceRange?: string;
    /** N, L, H, LL, HH, A, AA */
    flag?: string;
    /** P preliminary, F final, C corrected */
    status?: string;
  }[];
  collectedAt?: Date;
  laboratory?: string;
}

export function buildOru(i: OruInput): string {
  const now = formatHl7Date(new Date());
  const collected = formatHl7Date(i.collectedAt ?? new Date(Date.now() - 2 * 3_600_000));
  const lab = i.laboratory ?? 'CENTRAL_LAB';
  return [
    `MSH|^~\\&|LIS|${lab}|PACIENT|PACIENT|${now}||ORU^R01^ORU_R01|${i.controlId}|P|2.5.1`,
    `PID|1||${i.patient.nationalId}^^^KS^NI||${escapeHl7(i.patient.lastName)}^${escapeHl7(i.patient.firstName)}||${i.patient.dateOfBirth.replace(/-/g, '')}|${i.patient.sex ?? 'U'}`,
    `ORC|RE|${i.placerOrderNumber}|${i.fillerOrderNumber ?? ''}`,
    `OBR|1|${i.placerOrderNumber}|${i.fillerOrderNumber ?? ''}|${i.observations[0]?.code ?? ''}^${escapeHl7(i.observations[0]?.name ?? '')}^LN|||${collected}`,
    ...i.observations.map(
      (o, n) =>
        `OBX|${n + 1}|${/^-?\d+(\.\d+)?$/.test(o.value) ? 'NM' : 'ST'}|${o.code}^${escapeHl7(o.name)}^LN||${escapeHl7(o.value)}|${escapeHl7(o.unit ?? '')}|${escapeHl7(o.referenceRange ?? '')}|${o.flag ?? 'N'}|||${o.status ?? 'F'}|||${now}`,
    ),
  ].join('\r');
}
