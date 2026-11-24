/**
 * Albanian (sq) translations for requests to the operator, contacting the operator and the help page, keyed by the English source text. Keep {placeholders}.
 * Round 2, builder G.
 */
export const operatorrequests: Record<string, string> = {
  Requests: 'Kërkesat',
  'Contact the operator': 'Kontaktoni operatorin',
  'Facilities, their subscriptions and history, invoices and payments, plans and requests.':
    'Institucionet, abonimet dhe historiku i tyre, faturat dhe pagesat, planet dhe kërkesat.',
  'Help and contact': 'Ndihmë dhe kontakt',
  // Contacting the operator (footer, sign-in page, subscription notices, settings).
  'Support hours': 'Orari i ndihmës',
  'Support hours: {hours}': 'Orari i ndihmës: {hours}',
  'When support answers, e.g. Mon–Fri 08:00–16:00. Shown with the support e-mail and phone in the footer, on the sign-in page and on the help page.':
    'Kur përgjigjet ndihma, p.sh. Hën–Pre 08:00–16:00. Shfaqet bashkë me e-mailin dhe telefonin e ndihmës në fund të faqes, në faqen e kyçjes dhe në faqen e ndihmës.',
  'Trouble signing in? Staff ask their facility’s IT support first.':
    'Probleme me kyçjen? Stafi pyet fillimisht mbështetjen IT të institucionit të vet.',
  'The operator of the service': 'Operatori i shërbimit',
  'Write a request': 'Shkruani një kërkesë',
  // The help page.
  'In an emergency call 112': 'Në rast emergjence telefononi 112',
  'Pacient is not an emergency service, and neither its support nor messages to your care team are answered around the clock.':
    'Pacient nuk është shërbim emergjence, dhe as ndihma e tij, as mesazhet për ekipin tuaj të kujdesit nuk marrin përgjigje gjatë gjithë kohës.',
  'The operator has not published its contact details yet. Ask your facility.':
    'Operatori ende nuk i ka publikuar të dhënat e kontaktit. Pyetni institucionin tuaj.',
  'Write a request to the operator': 'Shkruani një kërkesë për operatorin',
  'Who helps with what': 'Kush ndihmon me çfarë',
  'Patients: questions about your health record, appointments or results go to your health facility or your care team. The operator cannot answer them.':
    'Pacientët: pyetjet për kartelën tuaj shëndetësore, terminet ose rezultatet drejtojini institucionit tuaj shëndetësor ose ekipit tuaj të kujdesit. Operatori nuk mund t’u përgjigjet.',
  'Staff: your facility’s IT support helps with your account, sign-in and devices.':
    'Stafi: mbështetja IT e institucionit tuaj ju ndihmon me llogarinë, kyçjen dhe pajisjet.',
  'Directors and IT support of a facility write to the operator in Pacient under “Contact the operator”: billing, accounts, technical problems, data protection and security incidents.':
    'Drejtorët dhe mbështetja IT e një institucioni i shkruajnë operatorit në Pacient te “Kontaktoni operatorin”: faturimi, llogaritë, problemet teknike, mbrojtja e të dhënave dhe incidentet e sigurisë.',
  'Never send patient information to the operator: no names, personal numbers or health details.':
    'Mos i dërgoni kurrë operatorit të dhëna të pacientëve: as emra, as numra personalë, as të dhëna shëndetësore.',
  'What the operator can and cannot see': 'Çfarë mund dhe çfarë nuk mund të shohë operatori',
  'The operator’s administrators can see:': 'Administratorët e operatorit mund të shohin:',
  'accounts: name, e-mail, role, facility, and whether sign-in works':
    'llogaritë: emrin, e-mailin, rolin, institucionin dhe nëse kyçja funksionon',
  'the facilities that are customers, their subscriptions and invoices':
    'institucionet që janë klientë, abonimet dhe faturat e tyre',
  'the requests facilities send them': 'kërkesat që u dërgojnë institucionet',
  'how the service is running, without health data':
    'si funksionon shërbimi, pa të dhëna shëndetësore',
  'They cannot see:': 'Ata nuk mund të shohin:',
  'health records: diagnoses, results, medicines, notes, documents or messages with care teams':
    'kartelat shëndetësore: diagnozat, rezultatet, barnat, shënimet, dokumentet ose mesazhet me ekipet e kujdesit',
  'lists of patients, or who is a patient of which facility':
    'listat e pacientëve, ose kush është pacient i cilit institucion',
  'Every access to a health record is logged, and patients can see who opened theirs.':
    'Çdo qasje në një kartelë shëndetësore regjistrohet, dhe pacientët shohin kush e ka hapur kartelën e tyre.',
  // Requests: categories, statuses and shared parts.
  'Billing and invoices|request category': 'Faturimi dhe faturat',
  'Accounts and access|request category': 'Llogaritë dhe qasja',
  'Technical problem|request category': 'Problem teknik',
  'Data protection|request category': 'Mbrojtja e të dhënave',
  'Security incident|request category': 'Incident sigurie',
  'Something else|request category': 'Diçka tjetër',
  'Open|request status': 'E hapur',
  'Waiting for your answer|request status': 'Në pritje të përgjigjes suaj',
  'Waiting for the facility|request status': 'Në pritje të institucionit',
  'Resolved|request status': 'E zgjidhur',
  'High priority': 'Prioritet i lartë',
  'Do not include patient information: no names, personal numbers or health details.':
    'Mos përfshini të dhëna të pacientëve: as emra, as numra personalë, as të dhëna shëndetësore.',
  'This text contains a 10-digit number that looks like a personal number. Remove it: requests are never about a patient.':
    'Ky tekst përmban një numër me 10 shifra që duket si numër personal. Hiqeni: kërkesat nuk kanë të bëjnë kurrë me një pacient.',
  Conversation: 'Biseda',
  '{name} (operator)': '{name} (operatori)',
  'The operator': 'Operatori',
  'Reference|request': 'Referenca',
  'Opened|request': 'Hapur më',
  'Resolved on': 'Zgjidhur më',
  'Last change': 'Ndryshimi i fundit',
  // The facility's pages.
  'Questions and problems for the operator of the service: billing, accounts, technical problems, data protection and security incidents. The operator never sees patient records.':
    'Pyetje dhe probleme për operatorin e shërbimit: faturimi, llogaritë, problemet teknike, mbrojtja e të dhënave dhe incidentet e sigurisë. Operatori nuk i sheh kurrë kartelat e pacientëve.',
  'New request': 'Kërkesë e re',
  'New request to the operator': 'Kërkesë e re për operatorin',
  'Also by e-mail or phone': 'Edhe me e-mail ose telefon',
  'Requests of your facility': 'Kërkesat e institucionit tuaj',
  'Write to the operator with “New request”.': 'Shkruajini operatorit me “Kërkesë e re”.',
  'Do not include patient information': 'Mos përfshini të dhëna të pacientëve',
  'Requests reach the operator, who never sees patient records. Write about the service – no names, personal numbers or health details of patients.':
    'Kërkesat i shkojnë operatorit, i cili nuk i sheh kurrë kartelat e pacientëve. Shkruani për shërbimin – pa emra, numra personalë ose të dhëna shëndetësore të pacientëve.',
  'A security incident reaches every administrator at once':
    'Një incident sigurie u shkon menjëherë të gjithë administratorëve',
  'It is of high priority and e-mailed to all the operator’s administrators. Also follow your facility’s own incident procedure, and in an emergency call 112.':
    'Ka prioritet të lartë dhe u dërgohet me e-mail të gjithë administratorëve të operatorit. Ndiqni edhe procedurën e institucionit tuaj për incidentet, dhe në rast emergjence telefononi 112.',
  'All requests of your facility': 'Të gjitha kërkesat e institucionit tuaj',
  'Your message': 'Mesazhi juaj',
  'Writing again opens the request again.': 'Nëse shkruani përsëri, kërkesa hapet përsëri.',
  'The operator is waiting for your answer.': 'Operatori pret përgjigjen tuaj.',
  // The administrator's inbox.
  'What facilities ask the operator: answer them and keep their status up to date. Requests are never about a patient.':
    'Çfarë i kërkojnë institucionet operatorit: përgjigjuni dhe mbani statusin e tyre të përditësuar. Kërkesat nuk kanë të bëjnë kurrë me një pacient.',
  'High priority, unresolved': 'Prioritet i lartë, të pazgjidhura',
  'Not resolved': 'Të pazgjidhura',
  'Not answered yet': 'Ende pa përgjigje',
  'All requests': 'Të gjitha kërkesat',
  Answer: 'Përgjigja',
  'The person who asked is notified; the facility sees the answer as from the operator, without your name. Never ask for patient information.':
    'Personi që pyeti njoftohet; institucioni e sheh përgjigjen si nga operatori, pa emrin tuaj. Mos kërkoni kurrë të dhëna të pacientëve.',
  'Status after the answer': 'Statusi pas përgjigjes',
  'Leave the status as it is': 'Lëre statusin siç është',
  'Mark as resolved': 'Shëno si të zgjidhur',
  'Mark as open': 'Shëno si të hapur',
  'Open again': 'Hape përsëri',
  'Wait for the facility': 'Prit institucionin',
  'Requests from facilities': 'Kërkesat nga institucionet',
  'Open the requests': 'Hap kërkesat',
  // Messages from the server.
  'Do not include patient information. This text contains a 10-digit number that looks like a personal number: remove it and send again.':
    'Mos përfshini të dhëna të pacientëve. Ky tekst përmban një numër me 10 shifra që duket si numër personal: hiqeni dhe dërgojeni përsëri.',
};
