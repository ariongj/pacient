/**
 * Serbian (Latin, sr-Latn) translations, keyed by the English source text. Keep {placeholders}.
 */
export const partner: Record<string, string> = {
  Public: 'Javno',
  'User session': 'Korisnička sesija',
  'Partner key': 'Partnerski ključ',
  'Laboratory key': 'Laboratorijski ključ',
  'Every part of Pacient works on one shared database through one API. External systems use that API with a scoped key – never direct database access.':
    'Svi delovi sistema Pacient rade nad jednom zajedničkom bazom podataka preko jednog API-ja. Spoljni sistemi koriste taj API sa ključem ograničenih ovlašćenja – nikada direktan pristup bazi podataka.',
  'Quick start for partner systems': 'Brzi početak za partnerske sisteme',
  'The Ministry registers your system under Partner systems and gives you a key with the scopes you need.':
    'Ministarstvo registruje Vaš sistem u delu Partnerski sistemi i dodeljuje Vam ključ sa ovlašćenjima koja su Vam potrebna.',
  'Send the key with every request: “Authorization: Bearer pk_…”.':
    'Šaljite ključ uz svaki zahtev: „Authorization: Bearer pk_…”.',
  'For patient data, state why you need it in X-Purpose-Of-Use: TREATMENT (with X-Requesting-Practitioner), PAYMENT or PUBLIC_HEALTH. You receive only what that purpose needs.':
    'Za podatke o pacijentima navedite zašto su Vam potrebni u X-Purpose-Of-Use: TREATMENT (uz X-Requesting-Practitioner), PAYMENT ili PUBLIC_HEALTH. Dobijate samo ono što je potrebno za tu svrhu.',
  'Patients who withdrew consent to sharing are never returned, and every call appears in the patient’s “Who viewed my record”.':
    'Pacijenti koji su povukli saglasnost za deljenje nikada se ne vraćaju, a svaki poziv se pojavljuje u pacijentovom delu „Ko je pregledao moj karton”.',
  'Machine-readable description (OpenAPI 3.1):': 'Mašinski čitljiv opis (OpenAPI 3.1):',
  'Filter endpoints': 'Filtriraj krajnje tačke',
  'e.g. fhir, births, admissions': 'npr. fhir, births, admissions',
  'No endpoints match': 'Nijedna krajnja tačka ne odgovara',
  Parameters: 'Parametri',
  required: 'obavezno',
  'Request body': 'Telo zahteva',
  Responses: 'Odgovori',
  'External systems never get database access. They call the Pacient API with their own key, only for what their scopes allow; every call is recorded and patients see it in “Who viewed my record”.':
    'Spoljni sistemi nikada ne dobijaju pristup bazi podataka. Oni pozivaju Pacient API sopstvenim ključem, samo za ono što njihova ovlašćenja dozvoljavaju; svaki poziv se beleži i pacijenti ga vide u delu „Ko je pregledao moj karton”.',
  'Connect a system': 'Poveži sistem',
  'No partner systems yet': 'Još nema partnerskih sistema',
  Scopes: 'Ovlašćenja',
  'Last call': 'Poslednji poziv',
  'Only from: {ips}': 'Samo sa: {ips}',
  'Revoked {date}': 'Opozvan {date}',
  Usage: 'Korišćenje',
  'Revoke the key of {name}? The system stops working immediately.':
    'Opozvati ključ sistema {name}? Sistem odmah prestaje da radi.',
  'Connect a partner system': 'Poveži partnerski sistem',
  'Give it to the partner over a secure channel. Only its fingerprint is stored.':
    'Predajte ga partneru bezbednim kanalom. Čuva se samo njegov otisak.',
  'The partner calls {url} with the header “Authorization: Bearer <key>”.':
    'Partner poziva {url} sa zaglavljem „Authorization: Bearer <key>”.',
  Organisation: 'Organizacija',
  'What may this system do?': 'Šta ovaj sistem sme da radi?',
  'Allowed IP addresses (optional)': 'Dozvoljene IP adrese (opciono)',
  'Separate with commas. Leave empty to allow calls from any address.':
    'Razdvojite zarezima. Ostavite prazno da biste dozvolili pozive sa bilo koje adrese.',
  'Create key': 'Kreiraj ključ',
  'Usage – {name}': 'Korišćenje – {name}',
  'Calls (30 days)': 'Pozivi (30 dana)',
  'Patients accessed': 'Pristupljeni pacijenti',
  'No calls in the last 30 days': 'Nema poziva u poslednjih 30 dana',
  'Calls per day': 'Pozivi po danu',
  Calls: 'Pozivi',
  'Grouped by day, scope and outcome ({count} row).':
    'Grupisano po danu, ovlašćenju i ishodu ({count} red).',
  'Grouped by day, scope and outcome ({count} rows).':
    'Grupisano po danu, ovlašćenju i ishodu (redova: {count}).',
  'Patient records (FHIR)': 'Kartoni pacijenata (FHIR)',
  'Find a patient by national ID and read their record for a stated purpose (treatment, payment or public health). Never returned when the patient has withdrawn consent to sharing.':
    'Pronađite pacijenta po ličnom broju i pročitajte njegov karton za navedenu svrhu (lečenje, plaćanje ili javno zdravlje). Nikada se ne vraća ako je pacijent povukao saglasnost za deljenje.',
  'National statistics': 'Nacionalna statistika',
  'Aggregate figures only, with small numbers suppressed. No patient data.':
    'Samo zbirni podaci, mali brojevi su prikriveni. Bez podataka o pacijentima.',
  'Directory of facilities and practitioners': 'Imenik ustanova i zdravstvenih radnika',
  'Names, specialties and facilities. No staff contact details.':
    'Imena, specijalnosti i ustanove. Bez kontakt podataka osoblja.',
  'Births for civil registration': 'Rođenja za upis u matičnu knjigu',
  'List newborns waiting for a national number and report the number once it is issued.':
    'Lista novorođenčadi koja čekaju lični broj i prijava broja kada bude izdat.',
  Authentication: 'Autentifikacija',
  'Sign-in, sessions, two-step verification, preferences.':
    'Prijava, sesije, prijava u dva koraka, podešavanja.',
  'Registration, demographics, care teams.': 'Registracija, lični podaci, timovi za negu.',
  'Clinical record': 'Klinički karton',
  'Visits, diagnoses, prescriptions, results, vitals…':
    'Posete, dijagnoze, recepti, rezultati, vitalni znaci…',
  Laboratory: 'Laboratorija',
  'Lab orders and the HL7 v2 laboratory interface.':
    'Laboratorijski nalozi i HL7 v2 laboratorijski interfejs.',
  'Wards, beds, admissions, transfers and discharge.':
    'Odeljenja, kreveti, prijemi, premeštaji i otpust.',
  'Arrivals, triage and the emergency board.': 'Dolasci, trijaža i tabla hitne pomoći.',
  'Radiology orders, worklist and reports.': 'Radiološki nalozi, radna lista i nalazi.',
  'Temporary identities, newborn registration, merges.':
    'Privremeni identiteti, registracija novorođenčadi, spajanja.',
  'Patient portal: access log, contact details, dependants.':
    'Portal za pacijente: dnevnik pristupa, kontakt podaci, izdržavana lica.',
  Collaboration: 'Saradnja',
  'Messages, referrals, care tasks, channels, notifications.':
    'Poruke, uputi, zadaci nege, kanali, obaveštenja.',
  'Reports, statistics, audit, emergency-access review.':
    'Izveštaji, statistika, revizija, pregled hitnog pristupa.',
  'Facilities, staff, lab connections, partner systems.':
    'Ustanove, osoblje, laboratorijske veze, partnerski sistemi.',
  FHIR: 'FHIR',
  'HL7 FHIR R4 export for authorised staff and patients.':
    'HL7 FHIR R4 izvoz za ovlašćeno osoblje i pacijente.',
  'Partner API': 'Partnerski API',
  'For external systems (insurance fund, civil registry, other hospitals, public health) with a scoped API key. Every call is audited and visible to the patient.':
    'Za spoljne sisteme (fond zdravstvenog osiguranja, matična služba, druge bolnice, javno zdravlje) sa ključem ograničenih ovlašćenja. Svaki poziv se revidira i vidljiv je pacijentu.',
  'Sign in with email and password': 'Prijava e-adresom i lozinkom',
  'Second step of sign-in': 'Drugi korak prijave',
  'New access token from the refresh cookie': 'Novi pristupni token iz kolačića za osvežavanje',
  'Current user': 'Trenutni korisnik',
  'Notification and language preferences': 'Podešavanja obaveštenja i jezika',
  'Send a verification code to a mobile number': 'Pošalji kod za potvrdu na broj mobilnog telefona',
  'Email a password-reset link': 'Pošalji e-poštom link za resetovanje lozinke',
  'Search patients you may see': 'Pretraga pacijenata koje smete da vidite',
  'Register a patient': 'Registruj pacijenta',
  Demographics: 'Lični podaci',
  'Break-glass access (audited, reviewed)': 'Hitni pristup (revidira se i pregleda)',
  'Start a visit (draft note)': 'Započni posetu (nacrt beleške)',
  'Full record export (JSON)': 'Izvoz celog kartona (JSON)',
  'Sign a note (immutable afterwards; corrections as addenda)':
    'Potpiši belešku (posle toga nepromenljiva; ispravke kao dopune)',
  'Acknowledge a result': 'Potvrdi pregled rezultata',
  'Documents (metadata)': 'Dokumenti (metapodaci)',
  'Upload a PDF/JPEG/PNG (≤ 10 MiB)': 'Otpremi PDF/JPEG/PNG (≤ 10 MiB)',
  'Consent decisions and history': 'Odluke o saglasnosti i istorija',
  "Doctor's worklist": 'Radna lista lekara',
  'Orderable tests (LOINC)': 'Analize koje se mogu naručiti (LOINC)',
  'Order a laboratory test': 'Naruči laboratorijsku analizu',
  'New orders for the laboratory (JSON or ?format=hl7 ORM^O01)':
    'Novi nalozi za laboratoriju (JSON ili ?format=hl7 ORM^O01)',
  'Confirm receipt of an order': 'Potvrdi prijem naloga',
  'Post HL7 v2 ORU^R01 results; answered with an HL7 ACK':
    'Pošalji HL7 v2 ORU^R01 rezultate; odgovor je HL7 ACK',
  'Wards and units with beds': 'Odeljenja i jedinice sa krevetima',
  'Admit a patient to a ward/bed': 'Primi pacijenta na odeljenje/krevet',
  'Transfer to another bed or unit': 'Premesti na drugi krevet ili jedinicu',
  'Discharge with a signed summary': 'Otpust sa potpisanom otpusnom listom',
  'Emergency board': 'Tabla hitne pomoći',
  'Register an arrival': 'Registruj dolazak',
  'Triage (levels 1–5)': 'Trijaža (nivoi 1–5)',
  'Order an imaging study': 'Naruči snimanje',
  'Sign a radiology report': 'Potpiši radiološki nalaz',
  'Register an unidentified patient (temporary number)':
    'Registruj neidentifikovanog pacijenta (privremeni broj)',
  'Confirm the real identity of a temporary record': 'Potvrdi pravi identitet privremenog kartona',
  'Register a birth (creates the newborn)': 'Registruj porođaj (kreira novorođenče)',
  'Likely duplicate records': 'Verovatni duplikati kartona',
  'Merge a duplicate record': 'Spoji duplikat kartona',
  'Children I am guardian of': 'Deca kojima sam staratelj',
  'Update my contact details': 'Ažuriraj moje kontakt podatke',
  'My notifications': 'Moja obaveštenja',
  'Patient–clinician message threads': 'Razgovori pacijent–zdravstveni radnik',
  'Ticket for the live event stream (SSE)': 'Tiket za tok događaja uživo (SSE)',
  'Aggregate report (small cells suppressed)': 'Zbirni izveštaj (male ćelije prikrivene)',
  'Audit trail': 'Revizioni dnevnik',
  'Emergency accesses to review': 'Hitni pristupi za pregled',
  'Staff accounts': 'Nalozi osoblja',
  'Invite a staff member': 'Pozovi člana osoblja',
  'Partner systems': 'Partnerski sistemi',
  'Register a partner system (the key is shown once)':
    'Registruj partnerski sistem (ključ se prikazuje jednom)',
  'Revoke a partner key': 'Opozovi partnerski ključ',
  'Calls per day and scope (30 days)': 'Pozivi po danu i ovlašćenju (30 dana)',
  CapabilityStatement: 'CapabilityStatement',
  'Patient resource': 'Resurs Patient',
  'The whole record as a FHIR Bundle': 'Ceo karton kao FHIR Bundle',
  'This document': 'Ovaj dokument',
  'Check the key and see its scopes': 'Proveri ključ i pogledaj njegova ovlašćenja',
  'FHIR CapabilityStatement': 'FHIR CapabilityStatement',
  'Find a patient by national ID': 'Pronađi pacijenta po ličnom broju',
  'Record for the stated purpose of use': 'Karton za navedenu svrhu korišćenja',
  'National aggregates (small cells suppressed)':
    'Nacionalni zbirni podaci (male ćelije prikrivene)',
  'Public directory of facilities': 'Javni imenik ustanova',
  'Public directory of practitioners (no contact details)':
    'Javni imenik zdravstvenih radnika (bez kontakt podataka)',
  'Births awaiting civil registration': 'Rođenja koja čekaju upis u matičnu knjigu',
  'Report the national ID issued for a newborn': 'Prijavi lični broj izdat za novorođenče',
  'Partner system not found': 'Partnerski sistem nije pronađen',
  'Enter IP addresses such as 192.0.2.10': 'Unesite IP adrese kao što je 192.0.2.10',
  'Insurance claims': 'Zahtevi za refundaciju',
  'Read submitted claims of facilities (services, amounts, insurance numbers) and record payment decisions.':
    'Čita podnete zahteve ustanova (usluge, iznosi, brojevi osiguranja) i beleži odluke o plaćanju.',
  'Notifiable disease reports': 'Prijave zaraznih bolesti',
  'Receive case reports of notifiable infectious diseases for public health follow-up.':
    'Prima prijave slučajeva zaraznih bolesti koje se obavezno prijavljuju, radi praćenja javnog zdravlja.',
};
