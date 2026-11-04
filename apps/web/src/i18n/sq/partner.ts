/**
 * Albanian (sq) translations, keyed by the English source text. Keep {placeholders}.
 * Partner systems page, API documentation and the OpenAPI reference (tags and summaries).
 */
export const partner: Record<string, string> = {
  Public: 'Publike',
  'User session': 'Sesion përdoruesi',
  'Partner key': 'Çelës partneri',
  'Laboratory key': 'Çelës laboratori',
  'Every part of Pacient works on one shared database through one API. External systems use that API with a scoped key – never direct database access.':
    'Çdo pjesë e Pacient punon mbi një bazë të dhënash të përbashkët përmes një API-je. Sistemet e jashtme përdorin këtë API me një çelës me të drejta të kufizuara – kurrë qasje të drejtpërdrejtë në bazën e të dhënave.',
  'Quick start for partner systems': 'Fillimi i shpejtë për sistemet partnere',
  'The Ministry registers your system under Partner systems and gives you a key with the scopes you need.':
    'Ministria e regjistron sistemin tuaj te Sistemet partnere dhe ju jep një çelës vetëm me të drejtat që ju nevojiten.',
  'Send the key with every request: “Authorization: Bearer pk_…”.':
    'Dërgoni çelësin me çdo kërkesë: “Authorization: Bearer pk_…”.',
  'For patient data, state why you need it in X-Purpose-Of-Use: TREATMENT (with X-Requesting-Practitioner), PAYMENT or PUBLIC_HEALTH. You receive only what that purpose needs.':
    'Për të dhënat e pacientit, tregoni pse ju nevojiten në X-Purpose-Of-Use: TREATMENT (me X-Requesting-Practitioner), PAYMENT ose PUBLIC_HEALTH. Merrni vetëm atë që i duhet atij qëllimi.',
  'Patients who withdrew consent to sharing are never returned, and every call appears in the patient’s “Who viewed my record”.':
    'Pacientët që e kanë tërhequr pëlqimin për ndarjen e të dhënave nuk kthehen kurrë, dhe çdo thirrje shfaqet te “Kush e ka parë kartelën time” e pacientit.',
  'Machine-readable description (OpenAPI 3.1):': 'Përshkrimi i lexueshëm nga makina (OpenAPI 3.1):',
  'Filter endpoints': 'Filtro pikat fundore',
  'e.g. fhir, births, admissions': 'p.sh. fhir, births, admissions',
  'No endpoints match': 'Asnjë pikë fundore nuk përputhet',
  Parameters: 'Parametrat',
  required: 'i detyrueshëm',
  'Request body': 'Trupi i kërkesës',
  Responses: 'Përgjigjet',
  'External systems never get database access. They call the Pacient API with their own key, only for what their scopes allow; every call is recorded and patients see it in “Who viewed my record”.':
    'Sistemet e jashtme nuk marrin kurrë qasje në bazën e të dhënave. Ata thërrasin API-në e Pacient me çelësin e tyre, vetëm për atë që lejojnë të drejtat e tyre; çdo thirrje regjistrohet dhe pacientët e shohin te “Kush e ka parë kartelën time”.',
  'Connect a system': 'Lidh një sistem',
  'No partner systems yet': 'Ende nuk ka sisteme partnere',
  Scopes: 'Të drejtat',
  'Last call': 'Thirrja e fundit',
  'Only from: {ips}': 'Vetëm nga: {ips}',
  'Revoked {date}': 'Revokuar më {date}',
  Usage: 'Përdorimi',
  'Revoke the key of {name}? The system stops working immediately.':
    'Të revokohet çelësi i {name}? Sistemi ndalon së punuari menjëherë.',
  'Connect a partner system': 'Lidh një sistem partner',
  'Give it to the partner over a secure channel. Only its fingerprint is stored.':
    'Jepjani partnerit përmes një kanali të sigurt. Ruhet vetëm gjurma e tij.',
  'The partner calls {url} with the header “Authorization: Bearer <key>”.':
    'Partneri thërret {url} me kokën “Authorization: Bearer <çelësi>”.',
  Organisation: 'Organizata',
  'What may this system do?': 'Çfarë mund të bëjë ky sistem?',
  'Allowed IP addresses (optional)': 'Adresat IP të lejuara (opsionale)',
  'Separate with commas. Leave empty to allow calls from any address.':
    'Ndajini me presje. Lëreni bosh për të lejuar thirrje nga çdo adresë.',
  'Create key': 'Krijo çelësin',
  'Usage – {name}': 'Përdorimi – {name}',
  'Calls (30 days)': 'Thirrjet (30 ditë)',
  'Patients accessed': 'Pacientë të qasur',
  'No calls in the last 30 days': 'Asnjë thirrje në 30 ditët e fundit',
  'Calls per day': 'Thirrjet në ditë',
  Calls: 'Thirrjet',
  'Grouped by day, scope and outcome ({count} row).':
    'Të grupuara sipas ditës, të drejtës dhe rezultatit ({count} rresht).',
  'Grouped by day, scope and outcome ({count} rows).':
    'Të grupuara sipas ditës, të drejtës dhe rezultatit ({count} rreshta).',
  'Patient records (FHIR)': 'Kartelat e pacientëve (FHIR)',
  'Find a patient by national ID and read their record for a stated purpose (treatment, payment or public health). Never returned when the patient has withdrawn consent to sharing.':
    'Gjen një pacient sipas numrit personal dhe lexon kartelën e tij për një qëllim të deklaruar (trajtim, pagesë ose shëndet publik). Nuk kthehet kurrë kur pacienti e ka tërhequr pëlqimin për ndarjen e të dhënave.',
  'National statistics': 'Statistikat kombëtare',
  'Aggregate figures only, with small numbers suppressed. No patient data.':
    'Vetëm shifra të përmbledhura, me numrat e vegjël të fshehur. Asnjë e dhënë pacienti.',
  'Directory of facilities and practitioners': 'Regjistri i institucioneve dhe i profesionistëve',
  'Names, specialties and facilities. No staff contact details.':
    'Emrat, specialitetet dhe institucionet. Pa të dhëna kontakti të stafit.',
  'Births for civil registration': 'Lindjet për regjistrim civil',
  'List newborns waiting for a national number and report the number once it is issued.':
    'Liston të porsalindurit që presin numrin personal dhe raporton numrin sapo të lëshohet.',
  Authentication: 'Identifikimi',
  'Sign-in, sessions, two-step verification, preferences.':
    'Kyçja, sesionet, verifikimi me dy hapa, preferencat.',
  'Registration, demographics, care teams.': 'Regjistrimi, të dhënat personale, ekipet e kujdesit.',
  'Clinical record': 'Kartela klinike',
  'Visits, diagnoses, prescriptions, results, vitals…':
    'Vizitat, diagnozat, recetat, rezultatet, shenjat vitale…',
  Laboratory: 'Laboratori',
  'Lab orders and the HL7 v2 laboratory interface.':
    'Kërkesat për analiza dhe ndërfaqja HL7 v2 me laboratorin.',
  'Wards, beds, admissions, transfers and discharge.':
    'Repartet, shtretërit, shtrimet, transferimet dhe lëshimi nga spitali.',
  'Arrivals, triage and the emergency board.': 'Ardhjet, triazhi dhe tabela e emergjencës.',
  'Radiology orders, worklist and reports.': 'Kërkesat radiologjike, lista e punës dhe raportet.',
  'Temporary identities, newborn registration, merges.':
    'Identitetet e përkohshme, regjistrimi i të porsalindurve, bashkimet.',
  'Patient portal: access log, contact details, dependants.':
    'Portali i pacientit: regjistri i qasjeve, të dhënat e kontaktit, anëtarët e familjes.',
  Collaboration: 'Bashkëpunimi',
  'Messages, referrals, care tasks, channels, notifications.':
    'Mesazhet, referimet, detyrat e kujdesit, kanalet, njoftimet.',
  'Reports, statistics, audit, emergency-access review.':
    'Raportet, statistikat, auditimi, shqyrtimi i qasjes emergjente.',
  'Facilities, staff, lab connections, partner systems.':
    'Institucionet, stafi, lidhjet me laboratorët, sistemet partnere.',
  FHIR: 'FHIR',
  'HL7 FHIR R4 export for authorised staff and patients.':
    'Eksporti HL7 FHIR R4 për stafin e autorizuar dhe pacientët.',
  'Partner API': 'API për partnerët',
  'For external systems (insurance fund, civil registry, other hospitals, public health) with a scoped API key. Every call is audited and visible to the patient.':
    'Për sistemet e jashtme (fondi i sigurimit, regjistri civil, spitale të tjera, shëndeti publik) me një çelës API me të drejta të kufizuara. Çdo thirrje auditohet dhe është e dukshme për pacientin.',
  'Sign in with email and password': 'Kyçu me email dhe fjalëkalim',
  'Second step of sign-in': 'Hapi i dytë i kyçjes',
  'New access token from the refresh cookie': 'Token i ri qasjeje nga cookie e rifreskimit',
  'Current user': 'Përdoruesi aktual',
  'Notification and language preferences': 'Preferencat për njoftimet dhe gjuhën',
  'Send a verification code to a mobile number': 'Dërgo një kod verifikimi në një numër celulari',
  'Email a password-reset link': 'Dërgo me email një lidhje për rivendosjen e fjalëkalimit',
  'Search patients you may see': 'Kërko pacientët që mund t’i shihni',
  'Register a patient': 'Regjistro një pacient',
  Demographics: 'Të dhënat personale',
  'Break-glass access (audited, reviewed)': 'Qasje emergjente (e audituar, e shqyrtuar)',
  'Start a visit (draft note)': 'Fillo një vizitë (shënim draft)',
  'Full record export (JSON)': 'Eksporti i plotë i kartelës (JSON)',
  'Sign a note (immutable afterwards; corrections as addenda)':
    'Nënshkruaj një shënim (i pandryshueshëm më pas; korrigjimet si shtojca)',
  'Acknowledge a result': 'Konfirmo leximin e një rezultati',
  'Documents (metadata)': 'Dokumentet (metadata)',
  'Upload a PDF/JPEG/PNG (≤ 10 MiB)': 'Ngarko një PDF/JPEG/PNG (≤ 10 MiB)',
  'Consent decisions and history': 'Vendimet për pëlqimin dhe historiku',
  "Doctor's worklist": 'Lista e punës e mjekut',
  'Orderable tests (LOINC)': 'Analizat që mund të porositen (LOINC)',
  'Order a laboratory test': 'Porosit një analizë laboratorike',
  'New orders for the laboratory (JSON or ?format=hl7 ORM^O01)':
    'Kërkesat e reja për laboratorin (JSON ose ?format=hl7 ORM^O01)',
  'Confirm receipt of an order': 'Konfirmo marrjen e një kërkese',
  'Post HL7 v2 ORU^R01 results; answered with an HL7 ACK':
    'Dërgo rezultate HL7 v2 ORU^R01; përgjigja është një HL7 ACK',
  'Wards and units with beds': 'Repartet dhe njësitë me shtretër',
  'Admit a patient to a ward/bed': 'Shtro një pacient në repart/shtrat',
  'Transfer to another bed or unit': 'Transfero në një shtrat ose njësi tjetër',
  'Discharge with a signed summary': 'Lësho nga spitali me epikrizë të nënshkruar',
  'Emergency board': 'Tabela e emergjencës',
  'Register an arrival': 'Regjistro një ardhje',
  'Triage (levels 1–5)': 'Triazhi (nivelet 1–5)',
  'Order an imaging study': 'Porosit një ekzaminim imazherik',
  'Sign a radiology report': 'Nënshkruaj një raport radiologjik',
  'Register an unidentified patient (temporary number)':
    'Regjistro një pacient të paidentifikuar (numër i përkohshëm)',
  'Confirm the real identity of a temporary record':
    'Konfirmo identitetin e vërtetë të një kartele të përkohshme',
  'Register a birth (creates the newborn)':
    'Regjistro një lindje (krijon kartelën e të porsalindurit)',
  'Likely duplicate records': 'Kartela të mundshme të dyfishta',
  'Merge a duplicate record': 'Bashko një kartelë të dyfishtë',
  'Children I am guardian of': 'Fëmijët për të cilët jam kujdestar',
  'Update my contact details': 'Përditëso të dhënat e mia të kontaktit',
  'My notifications': 'Njoftimet e mia',
  'Patient–clinician message threads': 'Bisedat pacient–klinicist',
  'Ticket for the live event stream (SSE)': 'Biletë për rrjedhën e ngjarjeve live (SSE)',
  'Aggregate report (small cells suppressed)': 'Raport i përmbledhur (numrat e vegjël të fshehur)',
  'Audit trail': 'Gjurma e auditimit',
  'Emergency accesses to review': 'Qasjet emergjente për shqyrtim',
  'Staff accounts': 'Llogaritë e stafit',
  'Invite a staff member': 'Fto një anëtar të stafit',
  'Partner systems': 'Sistemet partnere',
  'Register a partner system (the key is shown once)':
    'Regjistro një sistem partner (çelësi shfaqet vetëm një herë)',
  'Revoke a partner key': 'Revoko një çelës partneri',
  'Calls per day and scope (30 days)': 'Thirrjet sipas ditës dhe të drejtës (30 ditë)',
  CapabilityStatement: 'CapabilityStatement',
  'Patient resource': 'Burimi Patient',
  'The whole record as a FHIR Bundle': 'E gjithë kartela si FHIR Bundle',
  'This document': 'Ky dokument',
  'Check the key and see its scopes': 'Kontrollo çelësin dhe shiko të drejtat e tij',
  'FHIR CapabilityStatement': 'FHIR CapabilityStatement',
  'Find a patient by national ID': 'Gjej një pacient sipas numrit personal',
  'Record for the stated purpose of use': 'Kartela për qëllimin e deklaruar të përdorimit',
  'National aggregates (small cells suppressed)':
    'Përmbledhje kombëtare (numrat e vegjël të fshehur)',
  'Public directory of facilities': 'Regjistri publik i institucioneve',
  'Public directory of practitioners (no contact details)':
    'Regjistri publik i profesionistëve (pa të dhëna kontakti)',
  'Births awaiting civil registration': 'Lindjet që presin regjistrimin civil',
  'Report the national ID issued for a newborn':
    'Raporto numrin personal të lëshuar për një të porsalindur',
  'Partner system not found': 'Sistemi partner nuk u gjet',
  'Enter IP addresses such as 192.0.2.10': 'Shkruani adresa IP si 192.0.2.10',
  'Insurance claims': 'Kërkesat për rimbursim',
  'Read submitted claims of facilities (services, amounts, insurance numbers) and record payment decisions.':
    'Lexon kërkesat e dorëzuara të institucioneve (shërbimet, shumat, numrat e sigurimit) dhe regjistron vendimet për pagesë.',
  'Notifiable disease reports': 'Raportet e sëmundjeve ngjitëse të detyrueshme',
  'Receive case reports of notifiable infectious diseases for public health follow-up.':
    'Merr raportet e rasteve të sëmundjeve ngjitëse që duhen lajmëruar, për ndjekje nga shëndetësia publike.',
};
