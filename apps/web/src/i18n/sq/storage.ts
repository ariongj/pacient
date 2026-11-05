/**
 * Albanian (sq) translations for document versions and storage, keyed by the English source
 * text. Keep {placeholders}.
 */
export const storage: Record<string, string> = {
  'Version {n}': 'Versioni {n}',
  'Version history': 'Historiku i versioneve',
  'Earlier versions stay in the record unchanged. “{title}”':
    'Versionet e mëparshme mbeten të pandryshuara në kartelë. “{title}”',
  Latest: 'Më i fundit',
  'Upload new version': 'Ngarko version të ri',
  'The new file replaces “{title}” in the record. The current version stays in the history, and the sharing stays the same.':
    'Skedari i ri zëvendëson “{title}” në kartelë. Versioni aktual mbetet në historik dhe ndarja mbetet e njëjtë.',
  '“{title}” stays in the record for audit but is hidden from the patient and flagged for the care team. This cannot be undone.':
    '“{title}” mbetet në kartelë për auditim, por fshihet nga pacienti dhe shënohet për ekipin e kujdesit. Kjo nuk mund të zhbëhet.',
  /* Server messages */
  'A newer version of this document already exists':
    'Ekziston tashmë një version më i ri i këtij dokumenti',
  'You can only replace documents you added yourself':
    'Mund të zëvendësoni vetëm dokumentet që i keni shtuar vetë',
  'Documents provided by the patient can only be replaced by the patient':
    'Dokumentet e sjella nga pacienti mund t’i zëvendësojë vetëm pacienti',
  'Change the sharing of the latest version instead': 'Ndryshoni ndarjen e versionit më të fundit',
  'The document store is temporarily unavailable. Please try again shortly.':
    'Depoja e dokumenteve nuk është e disponueshme përkohësisht. Provoni sërish pas pak.',
  /* API documentation */
  'Upload a new version of a document': 'Ngarko një version të ri të dokumentit',
  'All versions of a document': 'Të gjitha versionet e një dokumenti',
  'care team (staff documents)': 'ekipi i kujdesit (dokumentet e stafit)',
  'the patient or guardian (documents they provided)':
    'pacienti ose kujdestari (dokumentet që i kanë sjellë)',
};
