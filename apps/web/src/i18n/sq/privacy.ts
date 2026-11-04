/**
 * Albanian (sq) translations for data protection, keyed by the English source text. Keep {placeholders}.
 */
export const privacy: Record<string, string> = {
  'National register of data protection requests, retention of operational data and legal holds.':
    'Regjistri kombëtar i kërkesave për mbrojtjen e të dhënave, ruajtja e të dhënave operative dhe ruajtjet ligjore.',
  'Data protection requests, legal holds and retention for patients of your facility.':
    'Kërkesat për mbrojtjen e të dhënave, ruajtjet ligjore dhe afatet e ruajtjes për pacientët e institucionit tuaj.',
  Retention: 'Ruajtja e të dhënave',
  'Data subject requests': 'Kërkesat e subjekteve të të dhënave',
  'Record a request': 'Regjistro një kërkesë',
  'Patients can ask for a copy, correction, restriction, erasure or a portable export of their data, or object to a use. The law requires an answer within 30 days.':
    'Pacientët mund të kërkojnë një kopje, korrigjim, kufizim, fshirje ose eksport të bartshëm të të dhënave të tyre, ose të kundërshtojnë një përdorim. Ligji kërkon përgjigje brenda 30 ditëve.',
  'Type of request': 'Lloji i kërkesës',
  'Only overdue': 'Vetëm me afat të kaluar',
  'No requests': 'Nuk ka kërkesa',
  Handle: 'Trajto',
  'For requests made in person, by post or by email. The patient must be identified first.':
    'Për kërkesat e bëra personalisht, me postë ose me email. Pacienti duhet të identifikohet më parë.',
  'National ID number': 'Numri personal',
  'What the patient asks for': 'Çfarë kërkon pacienti',
  'No clinical details are needed.': 'Nuk nevojiten detaje klinike.',
  'Record request': 'Regjistro kërkesën',
  Request: 'Kërkesa',
  'Health records cannot be erased while the legal retention period runs. Explain this to the patient; operational data can be removed and a note of disagreement can be added to the record.':
    'Të dhënat shëndetësore nuk mund të fshihen gjatë afatit ligjor të ruajtjes. Shpjegojani këtë pacientit; të dhënat operative mund të hiqen dhe në kartelë mund të shtohet një shënim mospajtimi.',
  'Corrections to clinical entries are made by the treating doctor through a correction request in the chart.':
    'Korrigjimet e shënimeve klinike i bën mjeku që trajton pacientin, përmes një kërkese për korrigjim në kartelë.',
  'New status': 'Statusi i ri',
  'Required when completing or rejecting. The patient is told the request was answered.':
    'I detyrueshëm kur përfundoni ose refuzoni. Pacienti njoftohet se kërkesa mori përgjigje.',
  'Only operational data is removed: delivery logs, expired sessions and similar. Health records and the audit trail are never deleted by this job, and patients under a legal hold are skipped.':
    'Hiqen vetëm të dhënat operative: regjistrat e dërgesave, seancat e skaduara e të ngjashme. Të dhënat shëndetësore dhe regjistri i auditimit nuk fshihen kurrë nga ky proces, dhe pacientët nën ruajtje ligjore anashkalohen.',
  'Retention policies': 'Politikat e ruajtjes',
  'Preview next run': 'Parashiko ekzekutimin e radhës',
  'Run now': 'Ekzekuto tani',
  'The job runs every night at 02:00.': 'Procesi ekzekutohet çdo natë në orën 02:00.',
  'Retention periods are set by the Ministry.': 'Afatet e ruajtjes i cakton Ministria.',
  'Kept for': 'Ruhen për',
  Action: 'Veprimi',
  'Last run': 'Ekzekutimi i fundit',
  'Next run': 'Ekzekutimi i radhës',
  Paused: 'Pezulluar',
  Anonymise: 'Anonimizo',
  'Expired operational data will be removed now. This cannot be undone. The run is recorded in the audit trail.':
    'Të dhënat operative me afat të kaluar do të hiqen tani. Kjo nuk mund të zhbëhet. Ekzekutimi regjistrohet në regjistrin e auditimit.',
  'Keep for (days)': 'Ruaj për (ditë)',
  'Legal basis': 'Baza ligjore',
  'A legal hold preserves everything about a patient – for a court case, complaint or investigation. Retention skips held patients until the hold is released.':
    'Ruajtja ligjore ruan gjithçka për një pacient – për një çështje gjyqësore, ankesë ose hetim. Procesi i ruajtjes i anashkalon këta pacientë derisa ruajtja të hiqet.',
  'Show released holds': 'Shfaq ruajtjet e hequra',
  'No active legal holds': 'Nuk ka ruajtje ligjore aktive',
  'No released legal holds': 'Nuk ka ruajtje ligjore të hequra',
  Placed: 'Vendosur',
  Released: 'Hequr',
  'For example the court case or complaint number.':
    'Për shembull numri i lëndës gjyqësore ose i ankesës.',
  'Place hold': 'Vendos ruajtjen',
  'Release legal hold': 'Hiq ruajtjen ligjore',
  'Release the hold on {name}? Normal retention applies again afterwards.':
    'Të hiqet ruajtja për {name}? Pas kësaj zbatohen sërish afatet e zakonshme të ruajtjes.',
  'Reason for release': 'Arsyeja e heqjes',
  'Deadline to answer a request': 'Afati për t’iu përgjigjur kërkesës',
  '30 days': '30 ditë',
  'Breach notification to the Agency': 'Njoftimi i cenimit te Agjencia',
  '72 hours': '72 orë',
  'Transfers outside Kosovo': 'Transferime jashtë Kosovës',
  'Records of processing': 'Regjistri i veprimtarive të përpunimit',
  'Lawful basis': 'Baza ligjore',
  'Data protection impact assessment – key controls':
    'Vlerësimi i ndikimit në mbrojtjen e të dhënave – masat kryesore',
  'Access only for the patient’s care team; emergency access is justified and reviewed.':
    'Qasje vetëm për ekipin që kujdeset për pacientin; qasja emergjente arsyetohet dhe rishikohet.',
  'Every view and change is written to an append-only audit trail patients can see.':
    'Çdo shikim dhe ndryshim shënohet në një regjistër auditimi që nuk mund të ndryshohet dhe që pacientët e shohin.',
  'Encryption in transit and of sensitive fields at rest; no health details in email or SMS.':
    'Enkriptim gjatë transmetimit dhe i fushave të ndjeshme në ruajtje; asnjë detaj shëndetësor në email ose SMS.',
  'Two-step sign-in for staff; sessions expire and devices are tracked.':
    'Hyrje me dy hapa për stafin; seancat skadojnë dhe pajisjet ndiqen.',
  'Operational data is removed on schedule; legal holds preserve records when needed.':
    'Të dhënat operative hiqen sipas orarit; ruajtjet ligjore i ruajnë të dhënat kur nevojitet.',
  'Personal data breach': 'Cenimi i të dhënave personale',
  'Report a suspected breach to the data protection officer at once. The controller notifies the Information and Privacy Agency within 72 hours, and the patients affected without undue delay when the risk to them is high.':
    'Raportojeni menjëherë çdo cenim të dyshuar te zyrtari për mbrojtjen e të dhënave. Kontrolluesi njofton Agjencinë për Informim dhe Privatësi brenda 72 orëve, dhe pacientët e prekur pa vonesë të panevojshme kur rreziku për ta është i lartë.',
  'The full documentation is kept in PRIVACY.md in the system documentation.':
    'Dokumentacioni i plotë mbahet në PRIVACY.md në dokumentacionin e sistemit.',
  'Copy of my data (access)': 'Kopje e të dhënave të mia (qasje)',
  'Correction (rectification)': 'Korrigjim',
  'Restrict processing': 'Kufizo përpunimin',
  Erasure: 'Fshirje',
  'Objection to processing': 'Kundërshtim i përpunimit',
  'Data portability': 'Bartshmëria e të dhënave',
  'By post': 'Me postë',
  'By email': 'Me email',
  'Your child’s data rights': 'Të drejtat e fëmijës suaj për të dhënat',
  'Your data rights': 'Të drejtat tuaja për të dhënat',
  'Under the Law on Protection of Personal Data you can get a copy of your data, have it corrected, restrict or object to its use, and ask for erasure. We answer within 30 days.':
    'Sipas Ligjit për Mbrojtjen e të Dhënave Personale mund të merrni një kopje të të dhënave tuaja, t’i korrigjoni, të kufizoni ose kundërshtoni përdorimin e tyre dhe të kërkoni fshirjen. Përgjigjemi brenda 30 ditëve.',
  'Get a copy of my data': 'Merr një kopje të të dhënave të mia',
  'Download your record, also in the FHIR format other systems can read.':
    'Shkarkoni kartelën tuaj, edhe në formatin FHIR që e lexojnë sisteme të tjera.',
  Download: 'Shkarko',
  'Correct my data': 'Korrigjo të dhënat e mia',
  'Ask for a mistake in your record to be corrected.':
    'Kërkoni që një gabim në kartelën tuaj të korrigjohet.',
  'Ask us to limit how your data is used while a question is resolved.':
    'Kërkoni që të kufizojmë përdorimin e të dhënave tuaja derisa të zgjidhet një çështje.',
  'Object to a use of your data, for example reminders or research.':
    'Kundërshtoni një përdorim të të dhënave tuaja, për shembull kujtesat ose kërkimin shkencor.',
  'Ask for data to be erased.': 'Kërkoni fshirjen e të dhënave.',
  'Make a request': 'Bëj një kërkesë',
  'Your requests': 'Kërkesat tuaja',
  'Sent {date} · answer due by {due}': 'Dërguar më {date} · përgjigja deri më {due}',
  'Data protection request': 'Kërkesë për mbrojtjen e të dhënave',
  'Health records must be kept for the period the law requires, so they cannot be erased during that time. We can erase other data, such as delivery logs, and you can add a statement to your record.':
    'Të dhënat shëndetësore duhet të ruhen për afatin që kërkon ligji, prandaj nuk mund të fshihen gjatë kësaj kohe. Mund të fshijmë të dhëna të tjera, si regjistrat e dërgesave, dhe ju mund të shtoni një deklaratë në kartelën tuaj.',
  'Describe your request': 'Përshkruani kërkesën tuaj',
  'Please do not include health details.': 'Ju lutemi mos përfshini detaje shëndetësore.',
  'Your request was sent. We will answer within 30 days.':
    'Kërkesa juaj u dërgua. Do t’ju përgjigjemi brenda 30 ditëve.',
  '{count} request is past its 30-day deadline.': '{count} kërkesë e ka kaluar afatin 30-ditor.',
  '{count} requests are past their 30-day deadline.':
    '{count} kërkesa e kanë kaluar afatin 30-ditor.',
  '{count} record was removed.': 'U hoq {count} regjistrim.',
  '{count} records were removed.': 'U hoqën {count} regjistrime.',
  'The next run would remove {count} record.':
    'Ekzekutimi i radhës do të hiqte {count} regjistrim.',
  'The next run would remove {count} records.':
    'Ekzekutimi i radhës do të hiqte {count} regjistrime.',
  '{count} day': '{count} ditë',
  '{count} record': '{count} regjistrim',
  '{count} records': '{count} regjistrime',
  'Default: {count} day': 'Parazgjedhur: {count} ditë',
  'Default: {count} days': 'Parazgjedhur: {count} ditë',
  'Health records (diagnoses, results, medicines, notes)':
    'Të dhënat shëndetësore (diagnozat, rezultatet, barnat, shënimet)',
  'Provision of health care; public interest in public health':
    'Ofrimi i kujdesit shëndetësor; interesi publik në shëndetin publik',
  'Kept for the period set by health legislation; never deleted by the retention job':
    'Ruhen për afatin e caktuar nga legjislacioni shëndetësor; nuk fshihen kurrë nga procesi i ruajtjes',
  'Identity and contact details': 'Të dhënat e identitetit dhe kontaktit',
  'Provision of health care; legal obligation to identify patients':
    'Ofrimi i kujdesit shëndetësor; detyrim ligjor për identifikimin e pacientëve',
  'As long as the health record': 'Për aq kohë sa kartela shëndetësore',
  'Consent decisions': 'Vendimet për pëlqim',
  'Consent (research, sharing between facilities)':
    'Pëlqimi (kërkimi shkencor, ndarja mes institucioneve)',
  'Audit trail of access': 'Regjistri i auditimit të qasjeve',
  'Legal obligation (accountability and security)': 'Detyrim ligjor (llogaridhënia dhe siguria)',
  'Never deleted': 'Nuk fshihet kurrë',
  'Notifications, email and SMS delivery logs':
    'Njoftimet, regjistrat e dërgesave me email dhe SMS',
  'Provision of the service; legitimate interest in reliable delivery':
    'Ofrimi i shërbimit; interes legjitim për dërgesë të besueshme',
  'See retention policies': 'Shih politikat e ruajtjes',
  'Sign-in sessions, devices and verification codes':
    'Seancat e hyrjes, pajisjet dhe kodet e verifikimit',
  'Security of processing': 'Siguria e përpunimit',
  'Only the Ministry and facility directors handle data protection':
    'Mbrojtjen e të dhënave e trajtojnë vetëm Ministria dhe drejtorët e institucioneve',
  'Only the Ministry may change retention policies':
    'Vetëm Ministria mund t’i ndryshojë politikat e ruajtjes',
  'Unknown retention category': 'Kategori e panjohur e ruajtjes',
  'Please describe your request': 'Ju lutemi përshkruani kërkesën tuaj',
  'You already have five open requests': 'Keni tashmë pesë kërkesa të hapura',
  'Record the outcome before closing the request': 'Shënoni rezultatin para se ta mbyllni kërkesën',
  'This request is already closed': 'Kjo kërkesë është mbyllur tashmë',
  'This patient is already under a legal hold': 'Ky pacient është tashmë nën ruajtje ligjore',
  'Legal hold not found': 'Ruajtja ligjore nuk u gjet',
  'This legal hold was already released': 'Kjo ruajtje ligjore është hequr tashmë',
  'Delivered or failed email records (message bodies are already erased after sending)':
    'Regjistrat e email-eve të dërguara ose të dështuara (përmbajtja fshihet tashmë pas dërgimit)',
  'Delivered or failed SMS records (message texts are already erased after sending)':
    'Regjistrat e SMS-ve të dërguara ose të dështuara (teksti fshihet tashmë pas dërgimit)',
  'In-app notifications that were read': 'Njoftimet në aplikacion që janë lexuar',
  'Expired sign-in sessions': 'Seancat e hyrjes të skaduara',
  'Expired passkey challenges': 'Sfidat e skaduara të çelësave të hyrjes (passkey)',
  'Mobile number verification codes': 'Kodet e verifikimit të numrit celular',
  'Devices not used to sign in for a long time':
    'Pajisjet që nuk janë përdorur për hyrje prej kohësh',
  'Technical records of ended video visits (the appointment and audit trail remain)':
    'Regjistrat teknikë të vizitave video të përfunduara (termini dhe regjistri i auditimit mbeten)',
  'Raw laboratory messages (the filed results remain; messages held for review are kept)':
    'Mesazhet e papërpunuara laboratorike (rezultatet e regjistruara mbeten; mesazhet në shqyrtim ruhen)',
  'Data minimisation (Law No. 06/L-082, art. 4): the original message is no longer needed once its results are filed and reviewed.':
    'Minimizimi i të dhënave (Ligji nr. 06/L-082, neni 4): mesazhi origjinal nuk nevojitet më pasi rezultatet të jenë regjistruar dhe shqyrtuar.',
  'Storage limitation (Law No. 06/L-082, art. 4): operational data is kept only as long as needed for the service.':
    'Kufizimi i ruajtjes (Ligji nr. 06/L-082, neni 4): të dhënat operative ruhen vetëm për aq kohë sa nevojiten për shërbimin.',
};
