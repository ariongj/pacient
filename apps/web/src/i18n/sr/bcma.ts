/**
 * Serbian (sr, Latin) translations, keyed by the English source text. Keep {placeholders}.
 * Barcode-checked medication administration and patient wristbands.
 */
export const bcma: Record<string, string> = {
  // Bedside checks (MAR)
  'STOP – do not give': 'STOP – ne davati',
  'This cannot be overridden. Check the patient and the medicine and scan again.':
    'Ovo se ne može zaobići. Proverite pacijenta i lek i skenirajte ponovo.',
  'Check before giving': 'Proverite pre davanja',
  Scanned: 'Skenirano',
  'Wristband only': 'Samo narukvica',
  'Pack only': 'Samo pakovanje',
  'Override reason': 'Razlog zaobilaženja',
  'Override: {reason}': 'Zaobilaženje: {reason}',
  'This is not a wristband code. Scan the patient’s wristband first.':
    'Ovo nije kod narukvice. Prvo skenirajte narukvicu pacijenta.',
  'That was a wristband. Now scan the medicine pack.':
    'To je bila narukvica. Sada skenirajte pakovanje leka.',
  Steps: 'Koraci',
  '1. Wristband': '1. Narukvica',
  '(not scanned)': '(bez skeniranja)',
  '2. Medicine pack': '2. Pakovanje leka',
  '3. Check and confirm': '3. Provera i potvrda',
  'Scan the patient’s wristband': 'Skenirajte narukvicu pacijenta',
  'Wristband cannot be scanned': 'Narukvica ne može da se skenira',
  'Scan the medicine pack': 'Skenirajte pakovanje leka',
  'Patient confirmed': 'Pacijent potvrđen',
  'Pack cannot be scanned': 'Pakovanje ne može da se skenira',
  'wristband matches this chart': 'narukvica odgovara ovom kartonu',
  'not scanned': 'bez skeniranja',
  'Last given {time}': 'Poslednji put dato {time}',
  'Reason for giving without a complete check': 'Razlog davanja bez potpune provere',
  'At least {count} characters. The reason is recorded in the audit log.':
    'Najmanje {count} znakova. Razlog se beleži u dnevniku revizije.',
  'Start again': 'Počni ispočetka',
  'Give with reason': 'Daj uz razlog',
  'Confirm dose given': 'Potvrdi davanje doze',
  'No doses given yet': 'Još nema datih doza',
  'Scanning {pct}%': 'Skeniranje {pct}%',
  '{unit}, last {days} days: {scanned} of {given} doses given with both scans; {overridden} overrides':
    '{unit}, poslednjih {days} dana: {scanned} od {given} datih doza sa oba skeniranja; {overridden} zaobilaženja',
  'Scan to give': 'Skeniraj i daj',
  'Barcode check': 'Provera bar-kodom',
  'Giving without scanning': 'Davanje bez skeniranja',
  'Use “Scan to give” whenever possible. A dose recorded as given without scanning the wristband and the pack needs a reason, which is audited.':
    'Kad god je moguće koristite „Skeniraj i daj“. Doza zabeležena kao data bez skeniranja narukvice i pakovanja zahteva razlog, koji se revidira.',
  // Server messages shown in forms
  'A reason of at least 10 characters is required to give a dose without both scans or despite a warning':
    'Za davanje doze bez oba skeniranja ili uprkos upozorenju potreban je razlog od najmanje 10 znakova',
  'The wristband scan could not be confirmed': 'Skeniranje narukvice nije potvrđeno',
  'The medicine pack scan could not be confirmed': 'Skeniranje pakovanja leka nije potvrđeno',
  'Wristbands are printed only for admitted patients or patients in the emergency department':
    'Narukvice se štampaju samo za hospitalizovane pacijente ili pacijente u urgentnom centru',
  'A scanned wristband must include the scanned code':
    'Skenirana narukvica mora sadržati skenirani kod',
  'A scanned pack must include the scanned barcode':
    'Skenirano pakovanje mora sadržati skenirani bar-kod',
  // Wristband
  'Print wristband': 'Štampaj narukvicu',
  'Temporary number (newborn)': 'Privremeni broj (novorođenče)',
  'Wristband preview': 'Pregled narukvice',
  'Wristband code': 'Kod narukvice',
  DOB: 'Dat. rođ.',
  ALLERGY: 'ALERGIJA',
  'Patient wristband': 'Identifikaciona narukvica pacijenta',
  'A wristband identifies the patient at every dose, sample and transfusion.':
    'Narukvica identifikuje pacijenta pri svakoj dozi, uzorku i transfuziji.',
  'Wristband ready': 'Narukvica je spremna',
  'Printing creates a new signed code for this patient and is recorded in the audit log. Check the patient’s name and date of birth with the patient before putting the band on.':
    'Štampanje stvara novi potpisani kod za ovog pacijenta i beleži se u dnevniku revizije. Pre stavljanja narukvice proverite ime i datum rođenja sa pacijentom.',
  'Not confirmed by the laboratory – not printed': 'Nije potvrđeno u laboratoriji – ne štampa se',
  Stay: 'Boravak',
  'Allergies not recorded': 'Alergije nisu zabeležene',
  'Record the allergy status in the chart as soon as possible.':
    'Što pre zabeležite alergijski status u kartonu.',
  'Print again': 'Štampaj ponovo',
  'Issue a new wristband': 'Izdaj novu narukvicu',
  'Create and print wristband': 'Napravi i štampaj narukvicu',
  '{name} has been admitted': '{name} je primljen/a na lečenje',
  'Print the wristband now – it is scanned before every dose.':
    'Odštampajte narukvicu sada – skenira se pre svake doze.',
  // Scanner
  'Code read': 'Kod je očitan',
  'Camera on – hold the code in front of the camera': 'Kamera uključena – držite kod ispred kamere',
  'The camera is not available. Use the scanner or type the code.':
    'Kamera nije dostupna. Koristite skener ili upišite kod.',
  'Scan or type, then Enter': 'Skenirajte ili upišite, pa Enter',
  'Enter code': 'Unesi kod',
  'Stop camera': 'Zaustavi kameru',
  'Use camera': 'Koristi kameru',
  'Handheld scanners type the code and press Enter for you.':
    'Ručni skeneri sami upisuju kod i pritiskaju Enter.',
  'Camera preview': 'Prikaz kamere',
};
