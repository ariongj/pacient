import type { CareRecord } from '../../api/ems';
import { t } from '../../i18n';

/** Readable summary of a care record entry. */
export function careText(r: CareRecord): string {
  if (r.kind !== 'OBSERVATION') return r.text ?? '';
  const d = r.data as Record<string, number | boolean | undefined>;
  const parts: string[] = [];
  if (d.systolic !== undefined) parts.push(`${t('BP')} ${d.systolic}/${d.diastolic ?? '–'}`);
  if (d.heartRate !== undefined) parts.push(`${t('HR')} ${d.heartRate}`);
  if (d.respiratoryRate !== undefined) parts.push(`${t('RR')} ${d.respiratoryRate}`);
  if (d.spo2 !== undefined) parts.push(`SpO₂ ${d.spo2}%`);
  if (d.gcs !== undefined) parts.push(`GCS ${d.gcs}`);
  if (d.glucose !== undefined) parts.push(`${t('Glucose')} ${d.glucose}`);
  if (d.temperature !== undefined) parts.push(`${d.temperature} °C`);
  if (d.onOxygen) parts.push(t('on oxygen'));
  return parts.join(' · ');
}

export const KIND_LABEL: Record<CareRecord['kind'], string> = {
  OBSERVATION: 'Observations',
  INTERVENTION: 'Intervention',
  MEDICATION: 'Medicine given',
  NOTE: 'Note',
};
