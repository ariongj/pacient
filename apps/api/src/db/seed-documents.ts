/** Demo documents for the development seed (synthetic content only). */
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { sealBuffer } from '../lib/secret-box.js';
import { db } from './client.js';
import { documentContents, patientDocuments, patients } from './schema.js';

/** A minimal, valid one-page PDF with a few lines of text (Helvetica, A4). */
export function simplePdf(title: string, lines: string[]): Buffer {
  const esc = (t: string) => t.replace(/[\\()]/g, (c) => `\\${c}`).replace(/[^\x20-\x7e]/g, '-');
  const text = [
    'BT',
    '/F1 16 Tf',
    '56 780 Td',
    `(${esc(title)}) Tj`,
    '/F1 11 Tf',
    '0 -28 Td',
    ...lines.flatMap((l) => [`(${esc(l)}) Tj`, '0 -16 Td']),
    'ET',
  ].join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(text, 'latin1')} >>\nstream\n${text}\nendstream`,
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

export async function seedDocuments({
  demoPatientId,
  demoDoctorId,
  facilityId,
}: {
  demoPatientId: string;
  demoDoctorId: string;
  facilityId: string;
}) {
  const docs = [
    {
      category: 'REFERRAL_LETTER' as const,
      title: 'Referral to cardiology',
      fileName: 'referral-cardiology.pdf',
      visibleToPatient: true,
      source: 'STAFF',
      createdAt: daysAgo(12),
      pdf: simplePdf('Referral letter - Cardiology', [
        'SYNTHETIC DEMO DOCUMENT - not a real patient.',
        '',
        'Dear colleague,',
        'Please assess this patient for palpitations on exertion over the past month.',
        'ECG at our clinic showed sinus rhythm. Blood pressure 138/86 mmHg.',
        'Current medication: amlodipine 5 mg once daily.',
        '',
        'Family Medicine, University Clinical Center Prishtina',
      ]),
    },
    {
      category: 'DISCHARGE_SUMMARY' as const,
      title: 'Discharge summary – day surgery',
      fileName: 'discharge-summary.pdf',
      visibleToPatient: false,
      source: 'STAFF',
      createdAt: daysAgo(40),
      pdf: simplePdf('Discharge summary', [
        'SYNTHETIC DEMO DOCUMENT - not a real patient.',
        '',
        'Admitted for elective day-case procedure; uneventful recovery.',
        'Discharged home the same day with analgesia for three days.',
        'Follow-up with the family doctor in two weeks.',
      ]),
    },
    {
      category: 'PATIENT_PROVIDED' as const,
      title: 'Blood test from a clinic abroad',
      fileName: 'blood-test-abroad.pdf',
      visibleToPatient: true,
      source: 'PATIENT',
      createdAt: daysAgo(5),
      pdf: simplePdf('Laboratory report (provided by the patient)', [
        'SYNTHETIC DEMO DOCUMENT - not a real patient.',
        '',
        'Haemoglobin 131 g/L   (120-160)',
        'Ferritin 22 ug/L      (15-150)',
        'TSH 2.1 mIU/L         (0.4-4.0)',
      ]),
    },
  ];
  const [patient] = await db
    .select({ userId: patients.userId })
    .from(patients)
    .where(eq(patients.id, demoPatientId));
  for (const d of docs) {
    const [row] = await db
      .insert(patientDocuments)
      .values({
        patientId: demoPatientId,
        category: d.category,
        title: d.title,
        fileName: d.fileName,
        mimeType: 'application/pdf',
        sizeBytes: d.pdf.length,
        sha256: createHash('sha256').update(d.pdf).digest('hex'),
        source: d.source,
        visibleToPatient: d.visibleToPatient,
        facilityId: d.source === 'STAFF' ? facilityId : null,
        uploadedById: d.source === 'PATIENT' && patient?.userId ? patient.userId : demoDoctorId,
        createdAt: d.createdAt,
      })
      .returning({ id: patientDocuments.id });
    await db.insert(documentContents).values({ documentId: row!.id, content: sealBuffer(d.pdf) });
  }
}
