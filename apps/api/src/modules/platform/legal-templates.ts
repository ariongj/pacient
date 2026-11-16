/**
 * Starting texts for the terms of use and the privacy notice, in Albanian, Serbian (Latin) and
 * English. They describe how Pacient actually works, but they are DRAFTS: the operator's lawyer
 * must review them before they are published. Placeholders such as {operatorName} are filled from
 * the operator settings when the text is shown.
 *
 * Format: plain text; "# " starts a heading, "- " a list item, a blank line separates paragraphs.
 */
export type LegalKind = 'TERMS' | 'PRIVACY';
export type LegalLocale = 'sq' | 'sr' | 'en';

export interface LegalTemplate {
  title: string;
  body: string;
}

const TERMS_EN = `These terms apply to everyone who uses Pacient – patients, their guardians and the staff of health facilities. Pacient is run by {operatorName}, {operatorAddress}.

# What Pacient is
Pacient is the electronic health record of the health facilities that use it. Patients see their own record, appointments, results and documents, and write to their care team. Staff use it to treat and look after patients.

Pacient is not an emergency service. In an emergency, call 112. Messages are not read around the clock.

# Your account
- Keep your password and your second sign-in factor to yourself. Never share your account.
- Tell us at once if you think someone else has used your account: {supportEmail}.
- Staff must use two-step sign-in. Accounts that are no longer needed are closed.
- A guardian may act for a child or another person only within the access the facility has granted. Everything a guardian opens is recorded in that person's access log.

# For staff
- Open a patient's record only when you take part in their care – as a member of the care team, in the unit where the patient is, or through emergency access when urgent care needs it. Emergency access must be justified and is reviewed by the facility director.
- Every view and every change is recorded. Patients can see who opened their record.
- What you learn about patients stays confidential, also after you leave.
- Clinical entries are signed with your name and cannot be deleted; corrections are added, never overwritten.

# For patients
- Information you enter yourself (for example readings or questionnaires) is shared with your care team, but it is not watched in real time.
- If something in your record is wrong, ask for a correction in the portal.

# Availability and changes
We work to keep Pacient available and secure, but maintenance and faults can interrupt it; facilities have downtime procedures for this. These terms may change. When a change matters to you, you are asked to accept the new version the next time you sign in.

# Contact
Questions about these terms: {supportEmail}. For personal data, see the privacy notice ({privacyEmail}).`;

const PRIVACY_EN = `This notice explains how personal data is processed in Pacient. The service is run by {operatorName}, {operatorAddress}. Contact for personal data: {privacyEmail}.

# What data
- Identity and contact details: name, personal number, date of birth, sex, address, phone, e-mail.
- Health data recorded during care: visits, diagnoses, allergies, medicines, test and imaging results, hospital stays, vaccinations, documents and certificates.
- Account and security data: sign-ins, devices, two-step sign-in settings, and a log of every access to a record.

# Why
- To provide health care and to keep patients safe, including in emergencies.
- To meet the legal duties of health facilities, such as keeping health records and reporting notifiable diseases.
- To run the service securely: preventing misuse, detecting unauthorised access, giving support.
- For statistics and planning, only in anonymous, aggregated form; small numbers are suppressed so that nobody can be recognised.

Health data is processed for health care under the applicable law of Kosovo on the protection of personal data and the rules for health records.

# Who sees it
- Your care team: the doctors and nurses who treat you, the unit where you are treated and – in an emergency – a doctor using emergency access, which is recorded.
- Other facilities only when you are referred to them or with your consent.
- The Ministry of Health receives only aggregated statistics, not your record.
- The operator's technical staff do not open health records; they manage accounts and the service.
- Partners (for example the health insurance fund) only where the law allows it and for the stated purpose.

# How it is protected
Connections are encrypted; staff use two-step sign-in; access follows your care; every view of your record is logged and you can see who opened it; backups are encrypted.

# How long
Health records are kept for the periods set by the national rules for health records. Account data and logs are kept as long as needed for security and accountability.

# Your rights
- See your record and download a copy in the portal.
- See who viewed your record (the access log).
- Ask for wrong data to be corrected.
- Manage your consents in the portal, for example sharing with other facilities, and object to or restrict some uses where the law allows it.
- Complain to the national authority for the protection of personal data.

To exercise your rights or ask a question, write to {privacyEmail}. For help with your account: {supportEmail}.`;

const TERMS_SQ = `Këto kushte vlejnë për të gjithë ata që përdorin Pacient – pacientët, kujdestarët e tyre dhe stafin e institucioneve shëndetësore. Pacient ofrohet nga {operatorName}, {operatorAddress}.

# Çfarë është Pacient
Pacient është kartela elektronike shëndetësore e institucioneve shëndetësore që e përdorin. Pacientët shohin kartelën e tyre, terminet, rezultatet dhe dokumentet, dhe i shkruajnë ekipit të tyre të kujdesit. Stafi e përdor për t'i trajtuar pacientët dhe për t'u kujdesur për ta.

Pacient nuk është shërbim emergjence. Në rast emergjence telefononi 112. Mesazhet nuk lexohen gjatë gjithë kohës.

# Llogaria juaj
- Fjalëkalimin dhe faktorin e dytë të hyrjes mbajini vetëm për vete. Mos e ndani llogarinë me askënd.
- Na lajmëroni menjëherë nëse mendoni se dikush tjetër e ka përdorur llogarinë tuaj: {supportEmail}.
- Stafi duhet të përdorë hyrjen me dy hapa. Llogaritë që nuk nevojiten më mbyllen.
- Kujdestari mund të veprojë për një fëmijë ose për një person tjetër vetëm brenda qasjes që ia ka dhënë institucioni. Çdo gjë që hap kujdestari regjistrohet në regjistrin e qasjeve të atij personi.

# Për stafin
- Hapeni kartelën e një pacienti vetëm kur merrni pjesë në kujdesin e tij – si anëtar i ekipit të kujdesit, në njësinë ku ndodhet pacienti, ose me qasje emergjente kur kujdesi urgjent e kërkon. Qasja emergjente duhet arsyetuar dhe rishikohet nga drejtori i institucionit.
- Çdo shikim dhe çdo ndryshim regjistrohet. Pacientët shohin kush e ka hapur kartelën e tyre.
- Ajo që mësoni për pacientët mbetet konfidenciale, edhe pasi të largoheni.
- Shënimet klinike nënshkruhen me emrin tuaj dhe nuk mund të fshihen; korrigjimet shtohen, nuk mbishkruhen kurrë.

# Për pacientët
- Të dhënat që i shënoni vetë (p.sh. matjet ose pyetësorët) ndahen me ekipin tuaj të kujdesit, por nuk ndiqen në kohë reale.
- Nëse diçka në kartelën tuaj është e gabuar, kërkoni korrigjim në portal.

# Disponueshmëria dhe ndryshimet
Punojmë që Pacient të jetë i disponueshëm dhe i sigurt, por mirëmbajtja dhe defektet mund ta ndërpresin; për këtë institucionet kanë procedura për ndërprerje. Këto kushte mund të ndryshojnë. Kur ndryshimi ka rëndësi për ju, do t'ju kërkohet ta pranoni versionin e ri herën e ardhshme që hyni.

# Kontakti
Pyetje për këto kushte: {supportEmail}. Për të dhënat personale shihni njoftimin e privatësisë ({privacyEmail}).`;

const PRIVACY_SQ = `Ky njoftim shpjegon si përpunohen të dhënat personale në Pacient. Shërbimi ofrohet nga {operatorName}, {operatorAddress}. Kontakti për të dhënat personale: {privacyEmail}.

# Cilat të dhëna
- Të dhënat e identitetit dhe të kontaktit: emri, numri personal, data e lindjes, gjinia, adresa, telefoni, e-maili.
- Të dhënat shëndetësore të regjistruara gjatë kujdesit: vizitat, diagnozat, alergjitë, barnat, rezultatet e analizave dhe të imazherisë, shtrimet në spital, vaksinat, dokumentet dhe vërtetimet.
- Të dhënat e llogarisë dhe të sigurisë: hyrjet, pajisjet, cilësimet e hyrjes me dy hapa dhe regjistri i çdo qasjeje në kartelë.

# Pse
- Për të ofruar kujdes shëndetësor dhe për sigurinë e pacientëve, përfshirë emergjencat.
- Për të përmbushur detyrimet ligjore të institucioneve shëndetësore, si mbajtja e kartelave dhe raportimi i sëmundjeve ngjitëse.
- Për ta mbajtur shërbimin të sigurt: parandalimi i keqpërdorimit, zbulimi i qasjeve të paautorizuara, ndihma teknike.
- Për statistika dhe planifikim, vetëm në formë anonime dhe të përmbledhur; numrat e vegjël fshihen që askush të mos njihet.

Të dhënat shëndetësore përpunohen për kujdes shëndetësor sipas ligjit në fuqi të Kosovës për mbrojtjen e të dhënave personale dhe rregullave për kartelat shëndetësore.

# Kush i sheh
- Ekipi juaj i kujdesit: mjekët dhe infermierët që ju trajtojnë, njësia ku trajtoheni dhe – në emergjencë – një mjek me qasje emergjente, e cila regjistrohet.
- Institucionet e tjera vetëm kur referoheni tek ato ose me pëlqimin tuaj.
- Ministria e Shëndetësisë merr vetëm statistika të përmbledhura, jo kartelën tuaj.
- Stafi teknik i operatorit nuk hap kartela shëndetësore; ai menaxhon llogaritë dhe shërbimin.
- Partnerët (p.sh. fondi i sigurimeve shëndetësore) vetëm kur e lejon ligji dhe për qëllimin e deklaruar.

# Si mbrohen
Lidhjet janë të enkriptuara; stafi përdor hyrjen me dy hapa; qasja i ndjek kujdesit tuaj; çdo shikim i kartelës regjistrohet dhe ju shihni kush e ka hapur; kopjet rezervë janë të enkriptuara.

# Sa kohë ruhen
Kartelat shëndetësore ruhen për afatet e përcaktuara nga rregullat kombëtare për kartelat shëndetësore. Të dhënat e llogarisë dhe regjistrat ruhen aq sa nevojitet për sigurinë dhe llogaridhënien.

# Të drejtat tuaja
- Të shihni kartelën tuaj dhe të shkarkoni një kopje në portal.
- Të shihni kush e ka parë kartelën tuaj (regjistri i qasjeve).
- Të kërkoni korrigjimin e të dhënave të gabuara.
- Të menaxhoni pëlqimet në portal, p.sh. ndarjen me institucione të tjera, dhe të kundërshtoni ose të kufizoni disa përdorime aty ku e lejon ligji.
- Të ankoheni te autoriteti kombëtar për mbrojtjen e të dhënave personale.

Për t'i ushtruar të drejtat tuaja ose për pyetje, shkruani në {privacyEmail}. Për ndihmë me llogarinë: {supportEmail}.`;

const TERMS_SR = `Ovi uslovi važe za sve koji koriste Pacient – pacijente, njihove staratelje i osoblje zdravstvenih ustanova. Pacient pruža {operatorName}, {operatorAddress}.

# Šta je Pacient
Pacient je elektronski zdravstveni karton zdravstvenih ustanova koje ga koriste. Pacijenti vide svoj karton, termine, rezultate i dokumente i pišu svom timu za negu. Osoblje ga koristi za lečenje i negu pacijenata.

Pacient nije hitna služba. U hitnom slučaju pozovite 112. Poruke se ne čitaju neprekidno.

# Vaš nalog
- Lozinku i drugi faktor prijave čuvajte samo za sebe. Nalog ne delite ni sa kim.
- Odmah nam javite ako mislite da je neko drugi koristio vaš nalog: {supportEmail}.
- Osoblje mora da koristi prijavu u dva koraka. Nalozi koji više nisu potrebni se zatvaraju.
- Staratelj može da postupa za dete ili drugu osobu samo u okviru pristupa koji je odobrila ustanova. Sve što staratelj otvori beleži se u evidenciji pristupa te osobe.

# Za osoblje
- Karton pacijenta otvarajte samo kada učestvujete u njegovoj nezi – kao član tima za negu, u jedinici u kojoj se pacijent nalazi ili hitnim pristupom kada hitna nega to zahteva. Hitan pristup mora biti obrazložen i pregleda ga direktor ustanove.
- Svaki pregled i svaka izmena se beleže. Pacijenti vide ko je otvorio njihov karton.
- Ono što saznate o pacijentima ostaje poverljivo, i nakon što odete.
- Klinički unosi se potpisuju vašim imenom i ne mogu se brisati; ispravke se dodaju, nikada se ne prepisuju.

# Za pacijente
- Podaci koje sami unesete (npr. merenja ili upitnici) dele se sa vašim timom za negu, ali se ne prate u realnom vremenu.
- Ako je nešto u vašem kartonu pogrešno, zatražite ispravku u portalu.

# Dostupnost i izmene
Trudimo se da Pacient bude dostupan i bezbedan, ali održavanje i kvarovi mogu da ga prekinu; ustanove za to imaju postupke za rad u prekidu. Ovi uslovi se mogu menjati. Kada je izmena važna za vas, prilikom sledeće prijave biće zatraženo da prihvatite novu verziju.

# Kontakt
Pitanja o ovim uslovima: {supportEmail}. O ličnim podacima pogledajte obaveštenje o privatnosti ({privacyEmail}).`;

const PRIVACY_SR = `Ovo obaveštenje objašnjava kako se lični podaci obrađuju u sistemu Pacient. Uslugu pruža {operatorName}, {operatorAddress}. Kontakt za lične podatke: {privacyEmail}.

# Koji podaci
- Podaci o identitetu i kontaktu: ime, lični broj, datum rođenja, pol, adresa, telefon, e-pošta.
- Zdravstveni podaci zabeleženi tokom nege: posete, dijagnoze, alergije, lekovi, rezultati analiza i snimanja, bolnička lečenja, vakcinacije, dokumenti i potvrde.
- Podaci o nalogu i bezbednosti: prijave, uređaji, podešavanja prijave u dva koraka i evidencija svakog pristupa kartonu.

# Zašto
- Radi pružanja zdravstvene zaštite i bezbednosti pacijenata, uključujući hitne slučajeve.
- Radi ispunjavanja zakonskih obaveza zdravstvenih ustanova, kao što su vođenje kartona i prijavljivanje zaraznih bolesti.
- Radi bezbednog rada usluge: sprečavanje zloupotrebe, otkrivanje neovlašćenog pristupa, tehnička podrška.
- Za statistiku i planiranje, samo u anonimnom i zbirnom obliku; mali brojevi se skrivaju da niko ne bi mogao da bude prepoznat.

Zdravstveni podaci se obrađuju u svrhu zdravstvene zaštite u skladu sa važećim zakonom Kosova o zaštiti ličnih podataka i pravilima o zdravstvenoj dokumentaciji.

# Ko ih vidi
- Vaš tim za negu: lekari i medicinske sestre koji vas leče, jedinica u kojoj se lečite i – u hitnom slučaju – lekar sa hitnim pristupom, koji se beleži.
- Druge ustanove samo kada ste upućeni k njima ili uz vašu saglasnost.
- Ministarstvo zdravlja dobija samo zbirnu statistiku, ne vaš karton.
- Tehničko osoblje operatera ne otvara zdravstvene kartone; ono upravlja nalozima i uslugom.
- Partneri (npr. fond zdravstvenog osiguranja) samo kada zakon to dozvoljava i u navedenu svrhu.

# Kako su zaštićeni
Veze su šifrovane; osoblje koristi prijavu u dva koraka; pristup prati vašu negu; svaki pregled kartona se beleži i vi vidite ko ga je otvorio; rezervne kopije su šifrovane.

# Koliko dugo
Zdravstveni kartoni se čuvaju u rokovima utvrđenim nacionalnim pravilima o zdravstvenoj dokumentaciji. Podaci o nalogu i evidencije čuvaju se onoliko koliko je potrebno radi bezbednosti i odgovornosti.

# Vaša prava
- Da vidite svoj karton i preuzmete kopiju u portalu.
- Da vidite ko je pregledao vaš karton (evidencija pristupa).
- Da zatražite ispravku netačnih podataka.
- Da upravljate saglasnostima u portalu, npr. deljenjem sa drugim ustanovama, i da se usprotivite ili ograničite neke upotrebe tamo gde zakon to dozvoljava.
- Da podnesete pritužbu nacionalnom organu za zaštitu ličnih podataka.

Za ostvarivanje prava ili pitanja pišite na {privacyEmail}. Za pomoć sa nalogom: {supportEmail}.`;

export const LEGAL_TEMPLATES: Record<LegalKind, Record<LegalLocale, LegalTemplate>> = {
  TERMS: {
    sq: { title: 'Kushtet e përdorimit', body: TERMS_SQ },
    sr: { title: 'Uslovi korišćenja', body: TERMS_SR },
    en: { title: 'Terms of use', body: TERMS_EN },
  },
  PRIVACY: {
    sq: { title: 'Njoftimi i privatësisë', body: PRIVACY_SQ },
    sr: { title: 'Obaveštenje o privatnosti', body: PRIVACY_SR },
    en: { title: 'Privacy notice', body: PRIVACY_EN },
  },
};
