import { apiRaw, apiUpload } from './client';

export type DocumentCategory =
  | 'REFERRAL_LETTER'
  | 'DISCHARGE_SUMMARY'
  | 'IMAGING_REPORT'
  | 'LAB_REPORT'
  | 'CONSENT_FORM'
  | 'CLINICAL_PHOTO'
  | 'PATIENT_PROVIDED'
  | 'OTHER';

export interface PatientDocument {
  id: string;
  patientId: string;
  encounterId: string | null;
  category: DocumentCategory;
  title: string;
  fileName: string;
  mimeType: 'application/pdf' | 'image/jpeg' | 'image/png';
  sizeBytes: number;
  scanStatus: 'CLEAN' | 'NOT_SCANNED';
  source: 'STAFF' | 'PATIENT';
  visibleToPatient: boolean;
  confidentialFromGuardians: boolean;
  status: 'CURRENT' | 'ENTERED_IN_ERROR';
  errorReason: string | null;
  markedInErrorAt: string | null;
  createdAt: string;
  uploadedById: string;
  uploadedBy: string;
  uploadedByRole: string;
}

export const CATEGORY_LABELS: Record<DocumentCategory, string> = {
  REFERRAL_LETTER: 'Referral letter',
  DISCHARGE_SUMMARY: 'Discharge summary',
  IMAGING_REPORT: 'Imaging report',
  LAB_REPORT: 'Laboratory report',
  CONSENT_FORM: 'Consent form',
  CLINICAL_PHOTO: 'Clinical photo',
  PATIENT_PROVIDED: 'Provided by patient',
  OTHER: 'Other',
};

export const ACCEPTED_TYPES = ['application/pdf', 'image/jpeg', 'image/png'];
export const MAX_BYTES = 10 * 1024 * 1024;

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Client-side checks before uploading (the server checks again, including the file signature). */
export function checkFile(file: File | null | undefined): string | null {
  if (!file) return 'Choose a file';
  if (!ACCEPTED_TYPES.includes(file.type)) return 'Only PDF, JPEG or PNG files can be uploaded';
  if (file.size > MAX_BYTES) return 'The file is too large (maximum 10 MB)';
  if (file.size === 0) return 'The file is empty';
  return null;
}

export function uploadDocument(
  patientId: string,
  file: File,
  meta: {
    category?: DocumentCategory;
    title?: string;
    encounterId?: string;
    visibleToPatient?: boolean;
    confidentialFromGuardians?: boolean;
  },
) {
  return apiUpload<PatientDocument>(`/patients/${patientId}/documents`, file, file.name, {
    category: meta.category,
    title: meta.title,
    encounterId: meta.encounterId,
    visibleToPatient: meta.visibleToPatient,
    confidentialFromGuardians: meta.confidentialFromGuardians,
  });
}

/**
 * Opens a document in a new tab. The content needs the in-memory access token, so it is fetched
 * here and shown from a temporary blob URL. The tab is opened synchronously (before the fetch) so
 * pop-up blockers allow it; if it is blocked anyway, the file is downloaded instead.
 */
export async function openDocument(doc: PatientDocument) {
  const tab = window.open('', '_blank');
  try {
    const res = await apiRaw(`/patients/${doc.patientId}/documents/${doc.id}/content`);
    const type = ACCEPTED_TYPES.includes(doc.mimeType) ? doc.mimeType : 'application/octet-stream';
    const url = URL.createObjectURL(new Blob([await res.arrayBuffer()], { type }));
    if (tab) {
      tab.location.href = url;
    } else {
      const a = document.createElement('a');
      a.href = url;
      a.download = doc.fileName;
      a.click();
    }
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (err) {
    tab?.close();
    throw err;
  }
}
