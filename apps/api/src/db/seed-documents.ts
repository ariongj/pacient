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
      title: 'Referim në kardiologji',
      fileName: 'referim-kardiologji.pdf',
      visibleToPatient: true,
      source: 'STAFF',
      createdAt: daysAgo(12),
      pdf: simplePdf('Leter referimi - Kardiologji', [
        'DOKUMENT DEMONSTRUES SINTETIK - nuk eshte pacient i vertete.',
        '',
        'I nderuar koleg,',
        'Ju lutem vleresoni kete paciente per palpitacione gjate mundimit fizik ne muajin e fundit.',
        'EKG-ja ne klinike tregoi ritem sinusal. Tensioni i gjakut 138/86 mmHg.',
        'Terapia aktuale: amlodipine 5 mg nje here ne dite.',
        '',
        'Mjekesi familjare, Qendra Klinike Universitare e Kosoves',
      ]),
    },
    {
      category: 'DISCHARGE_SUMMARY' as const,
      title: 'Letër daljeje – kirurgji ditore',
      fileName: 'leter-daljeje.pdf',
      visibleToPatient: false,
      source: 'STAFF',
      createdAt: daysAgo(40),
      pdf: simplePdf('Leter daljeje', [
        'DOKUMENT DEMONSTRUES SINTETIK - nuk eshte pacient i vertete.',
        '',
        'U pranua per nderhyrje te planifikuar ditore; sherim pa nderlikime.',
        'U lirua ne shtepi te njejten dite me analgjezik per tri dite.',
        'Kontroll te mjeku familjar pas dy javesh.',
      ]),
    },
    {
      category: 'PATIENT_PROVIDED' as const,
      title: 'Analizë gjaku nga një klinikë jashtë vendit',
      fileName: 'analize-gjaku-jashte-vendit.pdf',
      visibleToPatient: true,
      source: 'PATIENT',
      createdAt: daysAgo(5),
      pdf: simplePdf('Raport laboratorik (sjelle nga pacientja)', [
        'DOKUMENT DEMONSTRUES SINTETIK - nuk eshte pacient i vertete.',
        '',
        'Hemoglobina 131 g/L   (120-160)',
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
