/**
 * Serbian Latin (sr) translations for data protection, keyed by the English source text. Keep {placeholders}.
 */
export const privacy: Record<string, string> = {
  'National register of data protection requests, retention of operational data and legal holds.':
    'Nacionalni registar zahteva za zaštitu podataka, čuvanje operativnih podataka i zakonska zadržavanja.',
  'Data protection requests, legal holds and retention for patients of your facility.':
    'Zahtevi za zaštitu podataka, zakonska zadržavanja i čuvanje podataka za pacijente vaše ustanove.',
  Retention: 'Čuvanje podataka',
  'Data subject requests': 'Zahtevi lica na koje se podaci odnose',
  'Record a request': 'Evidentiraj zahtev',
  'Patients can ask for a copy, correction, restriction, erasure or a portable export of their data, or object to a use. The law requires an answer within 30 days.':
    'Pacijenti mogu tražiti kopiju, ispravku, ograničenje, brisanje ili prenosivi izvoz svojih podataka, ili prigovoriti nekoj upotrebi. Zakon nalaže odgovor u roku od 30 dana.',
  'Type of request': 'Vrsta zahteva',
  'Only overdue': 'Samo sa isteklim rokom',
  'No requests': 'Nema zahteva',
  Handle: 'Obradi',
  'For requests made in person, by post or by email. The patient must be identified first.':
    'Za zahteve podnete lično, poštom ili e-poštom. Pacijent se prvo mora identifikovati.',
  'National ID number': 'Lični broj',
  'What the patient asks for': 'Šta pacijent traži',
  'No clinical details are needed.': 'Klinički detalji nisu potrebni.',
  'Record request': 'Evidentiraj zahtev',
  Request: 'Zahtev',
  'Health records cannot be erased while the legal retention period runs. Explain this to the patient; operational data can be removed and a note of disagreement can be added to the record.':
    'Zdravstveni podaci se ne mogu brisati dok traje zakonski rok čuvanja. Objasnite to pacijentu; operativni podaci se mogu ukloniti, a u karton se može dodati napomena o neslaganju.',
  'Corrections to clinical entries are made by the treating doctor through a correction request in the chart.':
    'Ispravke kliničkih unosa vrši lekar koji leči pacijenta, putem zahteva za ispravku u kartonu.',
  'New status': 'Novi status',
  'Required when completing or rejecting. The patient is told the request was answered.':
    'Obavezno pri završetku ili odbijanju. Pacijent dobija obaveštenje da je zahtev dobio odgovor.',
  'Only operational data is removed: delivery logs, expired sessions and similar. Health records and the audit trail are never deleted by this job, and patients under a legal hold are skipped.':
    'Uklanjaju se samo operativni podaci: evidencije isporuke, istekle sesije i slično. Zdravstveni podaci i revizioni dnevnik se nikada ne brišu ovim postupkom, a pacijenti pod zakonskim zadržavanjem se preskaču.',
  'Retention policies': 'Pravila čuvanja',
  'Preview next run': 'Pregled sledećeg pokretanja',
  'Run now': 'Pokreni sada',
  'The job runs every night at 02:00.': 'Postupak se pokreće svake noći u 02:00.',
  'Retention periods are set by the Ministry.': 'Rokove čuvanja određuje Ministarstvo.',
  'Kept for': 'Čuvaju se',
  Action: 'Radnja',
  'Last run': 'Poslednje pokretanje',
  'Next run': 'Sledeće pokretanje',
  Paused: 'Pauzirano',
  Anonymise: 'Anonimizuj',
  'Expired operational data will be removed now. This cannot be undone. The run is recorded in the audit trail.':
    'Operativni podaci kojima je istekao rok biće sada uklonjeni. Ovo se ne može poništiti. Pokretanje se beleži u revizionom dnevniku.',
  'Keep for (days)': 'Čuvaj (dana)',
  'Legal basis': 'Pravni osnov',
  'A legal hold preserves everything about a patient – for a court case, complaint or investigation. Retention skips held patients until the hold is released.':
    'Zakonsko zadržavanje čuva sve o pacijentu – za sudski postupak, žalbu ili istragu. Postupak čuvanja preskače te pacijente dok se zadržavanje ne ukine.',
  'Show released holds': 'Prikaži ukinuta zadržavanja',
  'No active legal holds': 'Nema aktivnih zakonskih zadržavanja',
  'No released legal holds': 'Nema ukinutih zakonskih zadržavanja',
  Placed: 'Postavljeno',
  Released: 'Ukinuto',
  'For example the court case or complaint number.': 'Na primer broj sudskog predmeta ili žalbe.',
  'Place hold': 'Postavi zadržavanje',
  'Release legal hold': 'Ukini zakonsko zadržavanje',
  'Release the hold on {name}? Normal retention applies again afterwards.':
    'Ukinuti zadržavanje za {name}? Nakon toga ponovo važe uobičajeni rokovi čuvanja.',
  'Reason for release': 'Razlog ukidanja',
  'Deadline to answer a request': 'Rok za odgovor na zahtev',
  '30 days': '30 dana',
  'Breach notification to the Agency': 'Obaveštenje Agenciji o povredi',
  '72 hours': '72 sata',
  'Transfers outside Kosovo': 'Prenosi van Kosova',
  'Records of processing': 'Evidencija radnji obrade',
  'Lawful basis': 'Pravni osnov',
  'Data protection impact assessment – key controls':
    'Procena uticaja na zaštitu podataka – ključne mere',
  'Access only for the patient’s care team; emergency access is justified and reviewed.':
    'Pristup samo za tim koji brine o pacijentu; hitni pristup se obrazlaže i proverava.',
  'Every view and change is written to an append-only audit trail patients can see.':
    'Svaki pregled i izmena upisuju se u revizioni dnevnik koji se ne može menjati i koji pacijenti vide.',
  'Encryption in transit and of sensitive fields at rest; no health details in email or SMS.':
    'Šifrovanje pri prenosu i osetljivih polja pri čuvanju; bez zdravstvenih detalja u e-pošti ili SMS-u.',
  'Two-step sign-in for staff; sessions expire and devices are tracked.':
    'Prijava u dva koraka za osoblje; sesije ističu i uređaji se prate.',
  'Operational data is removed on schedule; legal holds preserve records when needed.':
    'Operativni podaci se uklanjaju po rasporedu; zakonska zadržavanja čuvaju podatke kada je potrebno.',
  'Personal data breach': 'Povreda podataka o ličnosti',
  'Report a suspected breach to the data protection officer at once. The controller notifies the Information and Privacy Agency within 72 hours, and the patients affected without undue delay when the risk to them is high.':
    'Svaku sumnju na povredu odmah prijavite službeniku za zaštitu podataka. Rukovalac obaveštava Agenciju za informisanje i privatnost u roku od 72 sata, a pogođene pacijente bez nepotrebnog odlaganja kada je rizik za njih visok.',
  'The full documentation is kept in PRIVACY.md in the system documentation.':
    'Potpuna dokumentacija nalazi se u PRIVACY.md u dokumentaciji sistema.',
  'Copy of my data (access)': 'Kopija mojih podataka (pristup)',
  'Correction (rectification)': 'Ispravka',
  'Restrict processing': 'Ograniči obradu',
  Erasure: 'Brisanje',
  'Objection to processing': 'Prigovor na obradu',
  'Data portability': 'Prenosivost podataka',
  'By post': 'Poštom',
  'By email': 'E-poštom',
  'Your child’s data rights': 'Prava vašeg deteta u vezi sa podacima',
  'Your data rights': 'Vaša prava u vezi sa podacima',
  'Under the Law on Protection of Personal Data you can get a copy of your data, have it corrected, restrict or object to its use, and ask for erasure. We answer within 30 days.':
    'Prema Zakonu o zaštiti podataka o ličnosti možete dobiti kopiju svojih podataka, tražiti ispravku, ograničiti ili prigovoriti njihovoj upotrebi i tražiti brisanje. Odgovaramo u roku od 30 dana.',
  'Get a copy of my data': 'Preuzmi kopiju mojih podataka',
  'Download your record, also in the FHIR format other systems can read.':
    'Preuzmite svoj karton, i u FHIR formatu koji drugi sistemi mogu da čitaju.',
  Download: 'Preuzmi',
  'Correct my data': 'Ispravi moje podatke',
  'Ask for a mistake in your record to be corrected.':
    'Zatražite da se greška u vašem kartonu ispravi.',
  'Ask us to limit how your data is used while a question is resolved.':
    'Zatražite da ograničimo upotrebu vaših podataka dok se pitanje ne reši.',
  'Object to a use of your data, for example reminders or research.':
    'Prigovorite nekoj upotrebi vaših podataka, na primer podsetnicima ili istraživanju.',
  'Ask for data to be erased.': 'Zatražite brisanje podataka.',
  'Make a request': 'Podnesi zahtev',
  'Your requests': 'Vaši zahtevi',
  'Sent {date} · answer due by {due}': 'Poslato {date} · odgovor do {due}',
  'Data protection request': 'Zahtev za zaštitu podataka',
  'Health records must be kept for the period the law requires, so they cannot be erased during that time. We can erase other data, such as delivery logs, and you can add a statement to your record.':
    'Zdravstveni podaci moraju se čuvati onoliko koliko zakon nalaže, pa se tokom tog perioda ne mogu brisati. Možemo obrisati druge podatke, kao što su evidencije isporuke, a vi možete dodati izjavu u svoj karton.',
  'Describe your request': 'Opišite svoj zahtev',
  'Please do not include health details.': 'Molimo ne navodite zdravstvene detalje.',
  'Your request was sent. We will answer within 30 days.':
    'Vaš zahtev je poslat. Odgovorićemo u roku od 30 dana.',
  '{count} request is past its 30-day deadline.': '{count} zahtevu je istekao rok od 30 dana.',
  '{count} requests are past their 30-day deadline.':
    'Zahtevima ({count}) je istekao rok od 30 dana.',
  '{count} record was removed.': 'Uklonjen je {count} zapis.',
  '{count} records were removed.': 'Uklonjeno je zapisa: {count}.',
  'The next run would remove {count} record.': 'Sledeće pokretanje bi uklonilo {count} zapis.',
  'The next run would remove {count} records.': 'Sledeće pokretanje bi uklonilo zapisa: {count}.',
  '{count} day': '{count} dan',
  '{count} record': '{count} zapis',
  '{count} records': 'Zapisa: {count}',
  'Default: {count} day': 'Podrazumevano: {count} dan',
  'Default: {count} days': 'Podrazumevano: {count} dana',
  'Health records (diagnoses, results, medicines, notes)':
    'Zdravstveni podaci (dijagnoze, nalazi, lekovi, beleške)',
  'Provision of health care; public interest in public health':
    'Pružanje zdravstvene zaštite; javni interes u oblasti javnog zdravlja',
  'Kept for the period set by health legislation; never deleted by the retention job':
    'Čuvaju se u roku propisanom zdravstvenim zakonodavstvom; nikada se ne brišu postupkom čuvanja',
  'Identity and contact details': 'Podaci o identitetu i kontaktu',
  'Provision of health care; legal obligation to identify patients':
    'Pružanje zdravstvene zaštite; zakonska obaveza identifikacije pacijenata',
  'As long as the health record': 'Koliko i zdravstveni karton',
  'Consent decisions': 'Odluke o saglasnosti',
  'Consent (research, sharing between facilities)':
    'Saglasnost (istraživanje, deljenje između ustanova)',
  'Audit trail of access': 'Revizioni dnevnik pristupa',
  'Legal obligation (accountability and security)': 'Zakonska obaveza (odgovornost i bezbednost)',
  'Never deleted': 'Nikada se ne briše',
  'Notifications, email and SMS delivery logs': 'Obaveštenja, evidencije isporuke e-pošte i SMS-a',
  'Provision of the service; legitimate interest in reliable delivery':
    'Pružanje usluge; legitimni interes za pouzdanu isporuku',
  'See retention policies': 'Vidi pravila čuvanja',
  'Sign-in sessions, devices and verification codes':
    'Sesije prijave, uređaji i verifikacioni kodovi',
  'Security of processing': 'Bezbednost obrade',
  'Only the Ministry and facility directors handle data protection':
    'Zaštitom podataka bave se samo Ministarstvo i direktori ustanova',
  'Only the Ministry may change retention policies':
    'Samo Ministarstvo može menjati pravila čuvanja',
  'Unknown retention category': 'Nepoznata kategorija čuvanja',
  'Please describe your request': 'Molimo opišite svoj zahtev',
  'You already have five open requests': 'Već imate pet otvorenih zahteva',
  'Record the outcome before closing the request': 'Unesite ishod pre zatvaranja zahteva',
  'This request is already closed': 'Ovaj zahtev je već zatvoren',
  'This patient is already under a legal hold': 'Ovaj pacijent je već pod zakonskim zadržavanjem',
  'Legal hold not found': 'Zakonsko zadržavanje nije pronađeno',
  'This legal hold was already released': 'Ovo zakonsko zadržavanje je već ukinuto',
  'Delivered or failed email records (message bodies are already erased after sending)':
    'Evidencije isporučenih ili neuspelih e-poruka (sadržaj se briše već nakon slanja)',
  'Delivered or failed SMS records (message texts are already erased after sending)':
    'Evidencije isporučenih ili neuspelih SMS poruka (tekst se briše već nakon slanja)',
  'In-app notifications that were read': 'Pročitana obaveštenja u aplikaciji',
  'Expired sign-in sessions': 'Istekle sesije prijave',
  'Expired passkey challenges': 'Istekli izazovi pristupnih ključeva (passkey)',
  'Mobile number verification codes': 'Kodovi za verifikaciju broja mobilnog telefona',
  'Devices not used to sign in for a long time': 'Uređaji koji dugo nisu korišćeni za prijavu',
  'Technical records of ended video visits (the appointment and audit trail remain)':
    'Tehnički zapisi završenih video pregleda (termin i revizioni dnevnik ostaju)',
  'Raw laboratory messages (the filed results remain; messages held for review are kept)':
    'Neobrađene laboratorijske poruke (upisani nalazi ostaju; poruke na pregledu se čuvaju)',
  'Data minimisation (Law No. 06/L-082, art. 4): the original message is no longer needed once its results are filed and reviewed.':
    'Minimizacija podataka (Zakon br. 06/L-082, član 4): originalna poruka više nije potrebna kada su nalazi upisani i pregledani.',
  'Storage limitation (Law No. 06/L-082, art. 4): operational data is kept only as long as needed for the service.':
    'Ograničenje čuvanja (Zakon br. 06/L-082, član 4): operativni podaci se čuvaju samo onoliko koliko je potrebno za uslugu.',
};
