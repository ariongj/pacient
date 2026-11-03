import { useMutation, useQueryClient } from '@tanstack/react-query';
import { t } from '../i18n';
import { api } from './client';

export type Modality = 'XRAY' | 'CT' | 'MRI' | 'ULTRASOUND' | 'MAMMOGRAPHY' | 'FLUOROSCOPY';
export type ImagingStatus = 'ORDERED' | 'SCHEDULED' | 'PERFORMED' | 'REPORTED' | 'CANCELLED';
export type ImagingPriority = 'ROUTINE' | 'URGENT' | 'STAT';
export type YesNoUnknown = 'NO' | 'YES' | 'UNKNOWN';

export interface SafetyChecks {
  pregnancy?: YesNoUnknown;
  contrast?: boolean;
  contrastAllergy?: YesNoUnknown;
  renalImpairment?: YesNoUnknown;
  implants?: 'NO' | 'YES';
  implantsNote?: string | null;
  note?: string | null;
}

export interface ImagingOrder {
  /** Set once images are available in the PACS. */
  studyInstanceUid?: string | null;
  imagesAvailableAt?: string | null;
  id: string;
  accessionNumber: string;
  patientId: string;
  modality: Modality;
  bodyPart: string;
  clinicalQuestion: string;
  priority: ImagingPriority;
  safetyChecks: SafetyChecks | null;
  status: ImagingStatus;
  scheduledAt: string | null;
  performedAt: string | null;
  findings: string | null;
  impression: string | null;
  critical: boolean;
  reportedAt: string | null;
  acknowledgedAt: string | null;
  releasedAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  createdAt: string;
  orderedById: string;
  orderedBy: string;
  reportedBy: string | null;
  performedBy: string | null;
}

export interface WorklistItem extends ImagingOrder {
  patientName: string;
  nationalId: string;
  sex: string;
  dateOfBirth: string;
}

export interface RadiologyWorklist {
  items: WorklistItem[];
  counts: Partial<Record<ImagingStatus, number>>;
  isRadiologist: boolean;
}

/** Released report as the patient sees it. */
export interface PatientImagingReport {
  /** Set once images are available in the PACS. */
  studyInstanceUid?: string | null;
  imagesAvailableAt?: string | null;
  id: string;
  accessionNumber: string;
  modality: Modality;
  bodyPart: string;
  performedAt: string | null;
  findings: string | null;
  impression: string | null;
  reportedAt: string | null;
  reportedBy: string | null;
  releasedAt: string | null;
  orderedBy: string;
}

export const MODALITIES: Modality[] = [
  'XRAY',
  'CT',
  'MRI',
  'ULTRASOUND',
  'MAMMOGRAPHY',
  'FLUOROSCOPY',
];

export function modalityLabel(m: Modality): string {
  switch (m) {
    case 'XRAY':
      return t('X-ray');
    case 'CT':
      return t('CT');
    case 'MRI':
      return t('MRI');
    case 'ULTRASOUND':
      return t('Ultrasound');
    case 'MAMMOGRAPHY':
      return t('Mammography');
    case 'FLUOROSCOPY':
      return t('Fluoroscopy');
  }
}

/** Common examinations per modality (free text is allowed too). */
export function bodyPartPresets(m: Modality): string[] {
  const presets: Record<Modality, string[]> = {
    XRAY: [
      'Chest (PA and lateral)',
      'Abdomen',
      'Spine – lumbar',
      'Pelvis and hips',
      'Knee',
      'Hand and wrist',
      'Ankle and foot',
    ],
    CT: [
      'Head (without contrast)',
      'Chest (CT pulmonary angiography)',
      'Abdomen and pelvis',
      'Spine – cervical',
      'Sinuses',
    ],
    MRI: ['Brain', 'Spine – lumbar', 'Knee', 'Shoulder', 'Abdomen'],
    ULTRASOUND: [
      'Abdomen',
      'Pelvis',
      'Thyroid',
      'Kidneys and bladder',
      'Obstetric',
      'Leg veins (Doppler)',
    ],
    MAMMOGRAPHY: ['Both breasts (screening)', 'Diagnostic mammography'],
    FLUOROSCOPY: ['Barium swallow', 'Micturating cystourethrography'],
  };
  return presets[m].map((p) => t(p));
}

export const yesNoUnknownOptions = () => [
  { value: 'NO', label: t('No') },
  { value: 'YES', label: t('Yes') },
  { value: 'UNKNOWN', label: t('Unknown') },
];

/** Which safety questions apply (mirrors the server rules). */
export function safetyQuestions(
  m: Modality,
  patient: { sex: string; age: number } | null,
): { pregnancy: boolean; pregnancyRequired: boolean; contrast: boolean; implants: boolean } {
  const ionising = ['XRAY', 'CT', 'FLUOROSCOPY', 'MAMMOGRAPHY'].includes(m);
  const pregnancyRequired =
    ionising && patient?.sex === 'FEMALE' && patient.age >= 12 && patient.age <= 55;
  return {
    pregnancy: ionising && patient?.sex !== 'MALE',
    pregnancyRequired,
    contrast: m === 'CT' || m === 'MRI',
    implants: m === 'MRI',
  };
}

export function safetySummary(c: SafetyChecks | null): string[] {
  if (!c) return [];
  const yn = (v: string) => (v === 'YES' ? t('Yes') : v === 'NO' ? t('No') : t('Unknown'));
  const out: string[] = [];
  if (c.pregnancy) out.push(t('Pregnancy: {answer}', { answer: yn(c.pregnancy) }));
  if (c.contrast !== undefined) out.push(c.contrast ? t('With contrast') : t('Without contrast'));
  if (c.contrastAllergy)
    out.push(t('Contrast allergy: {answer}', { answer: yn(c.contrastAllergy) }));
  if (c.renalImpairment)
    out.push(t('Reduced kidney function: {answer}', { answer: yn(c.renalImpairment) }));
  if (c.implants)
    out.push(
      c.implants === 'YES'
        ? t('Implant/pacemaker: {note}', { note: c.implantsNote ?? '' })
        : t('No implants or pacemaker'),
    );
  if (c.note) out.push(c.note);
  return out;
}

/** Mutation on an imaging order that refreshes every imaging view and the worklist. */
export function useImagingAction<TVars>(
  request: (vars: TVars) => { path: string; body?: unknown },
  onDone?: () => void,
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: TVars) => {
      const { path, body } = request(vars);
      return api(`/imaging${path}`, { method: 'POST', body: body ?? {} });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['imaging'] });
      void qc.invalidateQueries({ queryKey: ['worklist'] });
      void qc.invalidateQueries({ queryKey: ['patient'] });
      onDone?.();
    },
  });
}
