/**
 * Serbian Latin (sr) translations for document versions and storage, keyed by the English source
 * text. Keep {placeholders}.
 */
export const storage: Record<string, string> = {
  'Version {n}': 'Verzija {n}',
  'Version history': 'Istorija verzija',
  'Earlier versions stay in the record unchanged. “{title}”':
    'Ranije verzije ostaju nepromenjene u kartonu. „{title}”',
  Latest: 'Najnovija',
  'Upload new version': 'Otpremi novu verziju',
  'The new file replaces “{title}” in the record. The current version stays in the history, and the sharing stays the same.':
    'Nova datoteka zamenjuje „{title}” u kartonu. Trenutna verzija ostaje u istoriji, a deljenje ostaje isto.',
  '“{title}” stays in the record for audit but is hidden from the patient and flagged for the care team. This cannot be undone.':
    '„{title}” ostaje u kartonu radi revizije, ali je skriven od pacijenta i označen za tim za negu. Ovo se ne može poništiti.',
  /* Server messages */
  'A newer version of this document already exists': 'Novija verzija ovog dokumenta već postoji',
  'You can only replace documents you added yourself':
    'Možete zameniti samo dokumente koje ste sami dodali',
  'Documents provided by the patient can only be replaced by the patient':
    'Dokumente koje je dostavio pacijent može zameniti samo pacijent',
  'Change the sharing of the latest version instead': 'Promenite deljenje najnovije verzije',
  'The document store is temporarily unavailable. Please try again shortly.':
    'Skladište dokumenata je privremeno nedostupno. Pokušajte ponovo uskoro.',
  /* API documentation */
  'Upload a new version of a document': 'Otpremi novu verziju dokumenta',
  'All versions of a document': 'Sve verzije dokumenta',
  'care team (staff documents)': 'tim za negu (dokumenti osoblja)',
  'the patient or guardian (documents they provided)':
    'pacijent ili staratelj (dokumenti koje su dostavili)',
};
