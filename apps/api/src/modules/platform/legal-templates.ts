/**
 * Starting texts for the terms of use, the privacy notice, the service agreement and the data
 * processing agreement, in Albanian, Serbian (Latin) and English. They describe how Pacient
 * actually works, but they are DRAFTS: the operator's lawyer must review them before they are
 * published. Placeholders such as {operatorName} are filled from the operator settings when the
 * text is published.
 *
 * Format: plain text; "# " starts a heading, "- " a list item, a blank line separates paragraphs.
 */
export type LegalKind = 'TERMS' | 'PRIVACY' | 'SERVICE_AGREEMENT' | 'DPA';
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

/*
 * The service agreement and the data processing agreement, accepted once per facility by one of
 * its directors. A contract a facility signs must not go out unreviewed, so each starts with a
 * note asking for the lawyer's review: publishing refuses a text that still contains it.
 * Sub-processors are listed in the text for the operator to fill in (there is no setting for
 * them).
 */

/** The note at the top of the agreement templates, deleted once a lawyer has reviewed the text. */
export const REVIEW_NOTES: Record<LegalLocale, string> = {
  en: 'DRAFT – have a lawyer review this text before you publish it, then delete this paragraph.',
  sq: 'DRAFT – kërkojini një juristi ta rishikojë këtë tekst para se ta publikoni, pastaj fshijeni këtë paragraf.',
  sr: 'NACRT – neka pravnik pregleda ovaj tekst pre nego što ga objavite, a zatim obrišite ovaj pasus.',
};

/** Whether a text still carries the review note of an agreement template, in any language. */
export const hasReviewNote = (text: string) =>
  Object.values(REVIEW_NOTES).some((note) => text.includes(note));

const SERVICE_AGREEMENT_EN = `${REVIEW_NOTES.en}

This agreement is between {operatorName}, {operatorAddress} (the operator), and the health facility that accepts it through one of its directors (the facility). The director who accepts it confirms that they may sign for the facility.

# The service
The operator provides Pacient, the electronic health record, to the facility as a service over the internet: the software, its hosting, updates, backups and support. The facility's subscription (plan, number of staff accounts, price and billing cycle) is shown to its directors under Subscription and invoices.

# Payment
- The facility pays the invoices of its subscription by bank transfer within the payment terms printed on them.
- When an invoice is overdue, the facility's directors are told. After the grace period the subscription may be suspended: then no new staff accounts can be added.
- Clinical access is never withheld for non-payment. Whatever the state of the subscription, staff keep signing in and working with patient records, and patients keep their access.

# What the facility does
- It creates accounts only for its own staff, with the role they need, and closes them when they leave.
- It makes sure its staff open a patient's record only when they take part in the patient's care, and it carries out the access reviews.
- It keeps its devices and networks secure and has procedures for working while the service is not available.
- It answers its patients' requests about their data, with the operator's help where needed.

# What the operator does
- It runs the service with care, keeps it secure and up to date, and makes encrypted backups.
- It announces planned maintenance in the service in advance.
- It answers the requests of the facility's directors and IT support: {supportEmail}, {supportPhone}.
- It processes the personal data of patients and staff only as set out in the data processing agreement, which is part of this agreement.

# Data
The facility remains responsible for its patients' records (the controller). The operator processes them only on the facility's behalf. The operator's staff do not open health records.

# Duration and end
This agreement applies for as long as the facility has a subscription. When the subscription ends, the operator returns the facility's data and then deletes it as set out in the data processing agreement.

# Changes
The operator may publish a new version of this agreement. The facility's directors are asked to accept it; until then the version accepted last applies.

# Applicable law
This agreement is governed by the law of Kosovo.

# Contact
Questions about this agreement: {supportEmail}. Personal data: {privacyEmail}.`;

const DPA_EN = `${REVIEW_NOTES.en}

This data processing agreement is part of the service agreement between {operatorName}, {operatorAddress} (the operator, as processor), and the health facility that accepts it through one of its directors (the facility, as controller). It sets out how the operator processes personal data for the facility in Pacient, under the law of Kosovo on the protection of personal data.

# Subject and duration
The operator hosts and runs Pacient for the facility for as long as the service agreement applies. Processing means storing, organising, showing and sending the data (e-mail and SMS notifications), backing it up, and finally returning and deleting it.

# Data subjects and categories of data
- Patients of the facility and their guardians: identity and contact details (name, personal number, date of birth, sex, address, phone, e-mail) and the health data recorded during care (visits, diagnoses, allergies, medicines, results, documents and certificates).
- Staff of the facility: name, role, contact details, licence number, sign-ins and two-step sign-in settings.
- Everyone: a log of every access to a record and of every change.

Health data is a special category of personal data and is processed only for health care.

# Instructions
The operator processes the data only on the documented instructions of the facility: this agreement, the service agreement and the way the facility configures and uses Pacient. The operator tells the facility at once if it believes that an instruction breaks the law. It does not use the data for its own purposes.

# Confidentiality
Everyone at the operator who may come into contact with the data is bound to confidentiality. The operator's staff manage accounts and the service; they do not open health records.

# Technical and organisational measures
The operator takes the measures described in the security documentation of Pacient (SECURITY.md), among them: encrypted connections, two-step sign-in for staff, access that follows the care relationship, a log of every access that patients can see, encrypted backups whose restore is tested, and the separation of the operator's administration from clinical data.

# Sub-processors
The operator uses the following sub-processors; the facility agrees to them by accepting this agreement:
- Hosting: [name, country of the data centre]
- E-mail delivery: [name, country]
- SMS delivery: [name, country]

The operator tells the facility in advance about a new or replaced sub-processor, and the facility may object for good reason. Every sub-processor is bound by the same obligations as the operator. Data is not transferred outside Kosovo without appropriate safeguards.

# Assistance
The operator helps the facility to answer patients' requests (access, a copy, correction, restriction), and with data protection impact assessments and consultations of the supervisory authority.

# Personal data breaches
The operator tells the facility without undue delay, and at the latest within 72 hours of becoming aware of it, about a breach that affects the facility's data: what happened, which data and how many people are concerned, the likely consequences and what was done. It helps the facility to notify the authority and the people concerned.

# Audits
The operator gives the facility the information needed to show that this agreement is complied with, and allows audits by the facility or by an auditor it appoints, with reasonable notice and without access to other customers' data.

# End of the agreement
- When the service agreement ends, the operator gives the facility its data in a common, machine-readable format.
- Afterwards it deletes the data, also from backups as they expire, unless the law requires it to keep them, and confirms the deletion in writing.

# Access to clinical data
Clinical access is never withheld for non-payment or because of a dispute: the facility's staff keep access to its patients' records for as long as the data is with the operator.

# Contact
Data protection questions and notices: {privacyEmail}. Support: {supportEmail}.`;

const SERVICE_AGREEMENT_SQ = `${REVIEW_NOTES.sq}

Kjo marrëveshje lidhet ndërmjet {operatorName}, {operatorAddress} (operatori), dhe institucionit shëndetësor që e pranon përmes njërit prej drejtorëve të tij (institucioni). Drejtori që e pranon konfirmon se ka të drejtë të nënshkruajë në emër të institucionit.

# Shërbimi
Operatori i ofron institucionit Pacient, kartelën elektronike shëndetësore, si shërbim përmes internetit: softuerin, hostimin, përditësimet, kopjet rezervë dhe ndihmën. Abonimi i institucionit (plani, numri i llogarive të stafit, çmimi dhe cikli i faturimit) u shfaqet drejtorëve të tij te Abonimi dhe faturat.

# Pagesa
- Institucioni i paguan faturat e abonimit me transfer bankar brenda afatit të pagesës të shënuar në to.
- Kur një faturë është me vonesë, drejtorët e institucionit njoftohen. Pas afatit shtesë abonimi mund të pezullohet: atëherë nuk mund të shtohen llogari të reja të stafit.
- Qasja klinike nuk ndalohet kurrë për shkak të mospagesës. Cilado qoftë gjendja e abonimit, stafi vazhdon të kyçet dhe të punojë me kartelat e pacientëve, dhe pacientët e ruajnë qasjen e tyre.

# Çfarë bën institucioni
- Krijon llogari vetëm për stafin e vet, me rolin që i nevojitet secilit, dhe i mbyll kur ata largohen.
- Kujdeset që stafi i tij ta hapë kartelën e një pacienti vetëm kur merr pjesë në kujdesin e tij, dhe i kryen rishikimet e qasjeve.
- I mban të sigurta pajisjet dhe rrjetet e veta dhe ka procedura për punën gjatë kohës kur shërbimi nuk është i disponueshëm.
- U përgjigjet kërkesave të pacientëve të vet për të dhënat e tyre, me ndihmën e operatorit kur nevojitet.

# Çfarë bën operatori
- E drejton shërbimin me kujdes, e mban të sigurt dhe të përditësuar, dhe bën kopje rezervë të enkriptuara.
- E njofton paraprakisht në shërbim mirëmbajtjen e planifikuar.
- U përgjigjet kërkesave të drejtorëve dhe të mbështetjes IT të institucionit: {supportEmail}, {supportPhone}.
- I përpunon të dhënat personale të pacientëve dhe të stafit vetëm siç përcaktohet në marrëveshjen për përpunimin e të dhënave, e cila është pjesë e kësaj marrëveshjeje.

# Të dhënat
Institucioni mbetet përgjegjës për kartelat e pacientëve të vet (kontrollues). Operatori i përpunon ato vetëm në emër të institucionit. Stafi i operatorit nuk hap kartela shëndetësore.

# Kohëzgjatja dhe përfundimi
Kjo marrëveshje vlen për aq kohë sa institucioni ka abonim. Kur abonimi përfundon, operatori ia kthen institucionit të dhënat e tij dhe pastaj i fshin ato siç përcaktohet në marrëveshjen për përpunimin e të dhënave.

# Ndryshimet
Operatori mund të publikojë një version të ri të kësaj marrëveshjeje. Drejtorëve të institucionit u kërkohet ta pranojnë; deri atëherë vlen versioni i pranuar së fundi.

# Ligji në fuqi
Për këtë marrëveshje zbatohet ligji i Kosovës.

# Kontakti
Pyetje për këtë marrëveshje: {supportEmail}. Të dhënat personale: {privacyEmail}.`;

const DPA_SQ = `${REVIEW_NOTES.sq}

Kjo marrëveshje për përpunimin e të dhënave është pjesë e marrëveshjes së shërbimit ndërmjet {operatorName}, {operatorAddress} (operatori, si përpunues), dhe institucionit shëndetësor që e pranon përmes njërit prej drejtorëve të tij (institucioni, si kontrollues). Ajo përcakton si i përpunon operatori të dhënat personale për institucionin në Pacient, sipas ligjit të Kosovës për mbrojtjen e të dhënave personale.

# Objekti dhe kohëzgjatja
Operatori e hoston dhe e drejton Pacient për institucionin për aq kohë sa vlen marrëveshja e shërbimit. Përpunimi do të thotë ruajtja, organizimi, shfaqja dhe dërgimi i të dhënave (njoftimet me e-mail dhe SMS), kopjimi rezervë i tyre dhe, në fund, kthimi dhe fshirja e tyre.

# Subjektet e të dhënave dhe kategoritë e të dhënave
- Pacientët e institucionit dhe kujdestarët e tyre: të dhënat e identitetit dhe të kontaktit (emri, numri personal, data e lindjes, gjinia, adresa, telefoni, e-maili) dhe të dhënat shëndetësore të regjistruara gjatë kujdesit (vizitat, diagnozat, alergjitë, barnat, rezultatet, dokumentet dhe vërtetimet).
- Stafi i institucionit: emri, roli, të dhënat e kontaktit, numri i licencës, hyrjet dhe cilësimet e verifikimit me dy hapa.
- Të gjithë: regjistri i çdo qasjeje në kartelë dhe i çdo ndryshimi.

Të dhënat shëndetësore janë kategori e veçantë e të dhënave personale dhe përpunohen vetëm për kujdes shëndetësor.

# Udhëzimet
Operatori i përpunon të dhënat vetëm sipas udhëzimeve të dokumentuara të institucionit: kësaj marrëveshjeje, marrëveshjes së shërbimit dhe mënyrës si institucioni e konfiguron dhe e përdor Pacient. Operatori e njofton menjëherë institucionin nëse mendon se një udhëzim e shkel ligjin. Ai nuk i përdor të dhënat për qëllimet e veta.

# Konfidencialiteti
Të gjithë te operatori që mund të vijnë në kontakt me të dhënat janë të detyruar të ruajnë konfidencialitetin. Stafi i operatorit menaxhon llogaritë dhe shërbimin; ai nuk hap kartela shëndetësore.

# Masat teknike dhe organizative
Operatori merr masat e përshkruara në dokumentacionin e sigurisë së Pacient (SECURITY.md), ndër to: lidhje të enkriptuara, verifikim me dy hapa për stafin, qasje që i ndjek marrëdhënies së kujdesit, regjistër të çdo qasjeje që pacientët mund ta shohin, kopje rezervë të enkriptuara, rikthimi i të cilave testohet, dhe ndarjen e administrimit të operatorit nga të dhënat klinike.

# Nënpërpunuesit
Operatori përdor nënpërpunuesit e mëposhtëm; institucioni pajtohet me ta duke e pranuar këtë marrëveshje:
- Hostimi: [emri, shteti i qendrës së të dhënave]
- Dërgimi i e-mailave: [emri, shteti]
- Dërgimi i SMS-ve: [emri, shteti]

Operatori e njofton paraprakisht institucionin për një nënpërpunues të ri ose të zëvendësuar, dhe institucioni mund të kundërshtojë me arsye të bazuar. Çdo nënpërpunues ka të njëjtat detyrime si operatori. Të dhënat nuk transferohen jashtë Kosovës pa masa të përshtatshme mbrojtëse.

# Ndihma
Operatori e ndihmon institucionin t'u përgjigjet kërkesave të pacientëve (qasje, kopje, korrigjim, kufizim), si dhe në vlerësimet e ndikimit në mbrojtjen e të dhënave dhe në konsultimet me autoritetin mbikëqyrës.

# Cenimi i të dhënave personale
Operatori e njofton institucionin pa vonesë të panevojshme, e më së voni brenda 72 orëve pasi të ketë marrë dijeni, për një cenim që prek të dhënat e institucionit: çfarë ndodhi, cilat të dhëna dhe sa persona preken, pasojat e mundshme dhe çfarë u bë. Ai e ndihmon institucionin të njoftojë autoritetin dhe personat e prekur.

# Auditimet
Operatori i jep institucionit informacionin e nevojshëm për të treguar se kjo marrëveshje respektohet, dhe lejon auditime nga institucioni ose nga një auditor që ai cakton, me njoftim të arsyeshëm paraprak dhe pa qasje në të dhënat e klientëve të tjerë.

# Përfundimi i marrëveshjes
- Kur përfundon marrëveshja e shërbimit, operatori ia jep institucionit të dhënat e tij në një format të zakonshëm, të lexueshëm nga makina.
- Pastaj i fshin të dhënat, edhe nga kopjet rezervë kur atyre u skadon afati, përveç kur ligji kërkon që të ruhen, dhe e konfirmon fshirjen me shkrim.

# Qasja në të dhënat klinike
Qasja klinike nuk ndalohet kurrë për shkak të mospagesës ose të një mosmarrëveshjeje: stafi i institucionit e ruan qasjen në kartelat e pacientëve të tij për aq kohë sa të dhënat janë te operatori.

# Kontakti
Pyetje dhe njoftime për mbrojtjen e të dhënave: {privacyEmail}. Ndihma: {supportEmail}.`;

const SERVICE_AGREEMENT_SR = `${REVIEW_NOTES.sr}

Ovaj ugovor zaključuju {operatorName}, {operatorAddress} (operater), i zdravstvena ustanova koja ga prihvata preko jednog od svojih direktora (ustanova). Direktor koji ga prihvata potvrđuje da je ovlašćen da potpiše u ime ustanove.

# Usluga
Operater ustanovi pruža Pacient, elektronski zdravstveni karton, kao uslugu preko interneta: softver, hosting, ažuriranja, rezervne kopije i podršku. Pretplata ustanove (plan, broj naloga osoblja, cena i ciklus naplate) prikazana je njenim direktorima pod Pretplata i fakture.

# Plaćanje
- Ustanova plaća fakture svoje pretplate bankovnim prenosom u roku plaćanja navedenom na njima.
- Kada faktura kasni, direktori ustanove se obaveštavaju. Posle dodatnog roka pretplata može biti suspendovana: tada se ne mogu dodavati novi nalozi osoblja.
- Klinički pristup se nikada ne uskraćuje zbog neplaćanja. Bez obzira na stanje pretplate, osoblje se i dalje prijavljuje i radi sa kartonima pacijenata, a pacijenti zadržavaju svoj pristup.

# Šta čini ustanova
- Otvara naloge samo za svoje osoblje, sa ulogom koja je svakome potrebna, i zatvara ih kada odu.
- Stara se da njeno osoblje otvara karton pacijenta samo kada učestvuje u njegovoj nezi i sprovodi preglede pristupa.
- Održava bezbednost svojih uređaja i mreža i ima postupke za rad dok usluga nije dostupna.
- Odgovara na zahteve svojih pacijenata u vezi sa njihovim podacima, uz pomoć operatera kada je potrebno.

# Šta čini operater
- Pažljivo vodi uslugu, održava je bezbednom i ažurnom i pravi šifrovane rezervne kopije.
- Planirano održavanje unapred najavljuje u usluzi.
- Odgovara na zahteve direktora i IT podrške ustanove: {supportEmail}, {supportPhone}.
- Lične podatke pacijenata i osoblja obrađuje samo kako je utvrđeno ugovorom o obradi podataka, koji je deo ovog ugovora.

# Podaci
Ustanova ostaje odgovorna za kartone svojih pacijenata (rukovalac). Operater ih obrađuje samo u ime ustanove. Osoblje operatera ne otvara zdravstvene kartone.

# Trajanje i prestanak
Ovaj ugovor važi dok ustanova ima pretplatu. Kada pretplata prestane, operater ustanovi vraća njene podatke, a zatim ih briše kako je utvrđeno ugovorom o obradi podataka.

# Izmene
Operater može da objavi novu verziju ovog ugovora. Od direktora ustanove se traži da je prihvate; do tada važi poslednja prihvaćena verzija.

# Merodavno pravo
Na ovaj ugovor primenjuje se pravo Kosova.

# Kontakt
Pitanja o ovom ugovoru: {supportEmail}. Lični podaci: {privacyEmail}.`;

const DPA_SR = `${REVIEW_NOTES.sr}

Ovaj ugovor o obradi podataka deo je ugovora o usluzi između {operatorName}, {operatorAddress} (operater, kao obrađivač), i zdravstvene ustanove koja ga prihvata preko jednog od svojih direktora (ustanova, kao rukovalac). On utvrđuje kako operater obrađuje lične podatke za ustanovu u sistemu Pacient, u skladu sa zakonom Kosova o zaštiti ličnih podataka.

# Predmet i trajanje
Operater hostuje i vodi Pacient za ustanovu dok važi ugovor o usluzi. Obrada podrazumeva čuvanje, organizovanje, prikazivanje i slanje podataka (obaveštenja e-poštom i SMS-om), izradu rezervnih kopija i, na kraju, vraćanje i brisanje podataka.

# Lica na koja se podaci odnose i vrste podataka
- Pacijenti ustanove i njihovi staratelji: podaci o identitetu i kontaktu (ime, lični broj, datum rođenja, pol, adresa, telefon, e-pošta) i zdravstveni podaci zabeleženi tokom nege (posete, dijagnoze, alergije, lekovi, rezultati, dokumenti i potvrde).
- Osoblje ustanove: ime, uloga, kontakt podaci, broj licence, prijave i podešavanja prijave u dva koraka.
- Svi: evidencija svakog pristupa kartonu i svake izmene.

Zdravstveni podaci su posebna vrsta ličnih podataka i obrađuju se samo radi zdravstvene zaštite.

# Uputstva
Operater obrađuje podatke samo po dokumentovanim uputstvima ustanove: ovom ugovoru, ugovoru o usluzi i načinu na koji ustanova podešava i koristi Pacient. Operater odmah obaveštava ustanovu ako smatra da je neko uputstvo protivno zakonu. Podatke ne koristi u sopstvene svrhe.

# Poverljivost
Svi kod operatera koji mogu doći u dodir sa podacima obavezni su na poverljivost. Osoblje operatera upravlja nalozima i uslugom; ono ne otvara zdravstvene kartone.

# Tehničke i organizacione mere
Operater preduzima mere opisane u bezbednosnoj dokumentaciji sistema Pacient (SECURITY.md), među njima: šifrovane veze, prijavu u dva koraka za osoblje, pristup koji prati odnos nege, evidenciju svakog pristupa koju pacijenti mogu da vide, šifrovane rezervne kopije čije se vraćanje proverava i odvajanje administracije operatera od kliničkih podataka.

# Podobrađivači
Operater koristi sledeće podobrađivače; ustanova se sa njima saglašava prihvatanjem ovog ugovora:
- Hosting: [naziv, država centra podataka]
- Slanje e-pošte: [naziv, država]
- Slanje SMS poruka: [naziv, država]

Operater unapred obaveštava ustanovu o novom ili zamenjenom podobrađivaču, a ustanova može da uloži prigovor iz opravdanog razloga. Svaki podobrađivač ima iste obaveze kao operater. Podaci se ne prenose van Kosova bez odgovarajućih zaštitnih mera.

# Pomoć
Operater pomaže ustanovi da odgovori na zahteve pacijenata (pristup, kopija, ispravka, ograničenje), kao i u procenama uticaja na zaštitu podataka i konsultacijama sa nadzornim organom.

# Povrede ličnih podataka
Operater obaveštava ustanovu bez nepotrebnog odlaganja, a najkasnije u roku od 72 sata od saznanja, o povredi koja pogađa podatke ustanove: šta se dogodilo, koji podaci i koliko osoba su pogođeni, verovatne posledice i šta je preduzeto. Pomaže ustanovi da obavesti nadležni organ i pogođena lica.

# Revizije
Operater ustanovi daje informacije potrebne da se pokaže da se ovaj ugovor poštuje i dozvoljava revizije koje sprovodi ustanova ili revizor koga ona odredi, uz razumnu prethodnu najavu i bez pristupa podacima drugih korisnika.

# Prestanak ugovora
- Kada ugovor o usluzi prestane, operater ustanovi predaje njene podatke u uobičajenom, mašinski čitljivom formatu.
- Zatim briše podatke, i iz rezervnih kopija kako one ističu, osim ako zakon zahteva da se čuvaju, i brisanje potvrđuje pisanim putem.

# Pristup kliničkim podacima
Klinički pristup se nikada ne uskraćuje zbog neplaćanja ili spora: osoblje ustanove zadržava pristup kartonima svojih pacijenata dok su podaci kod operatera.

# Kontakt
Pitanja i obaveštenja o zaštiti podataka: {privacyEmail}. Podrška: {supportEmail}.`;

export const LEGAL_TEMPLATES: Record<LegalKind, Record<LegalLocale, LegalTemplate>> = {
  SERVICE_AGREEMENT: {
    sq: { title: 'Marrëveshja e shërbimit', body: SERVICE_AGREEMENT_SQ },
    sr: { title: 'Ugovor o usluzi', body: SERVICE_AGREEMENT_SR },
    en: { title: 'Service agreement', body: SERVICE_AGREEMENT_EN },
  },
  DPA: {
    sq: { title: 'Marrëveshja për përpunimin e të dhënave', body: DPA_SQ },
    sr: { title: 'Ugovor o obradi podataka', body: DPA_SR },
    en: { title: 'Data processing agreement', body: DPA_EN },
  },
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
