/**
 * Serbian Latin (sr) translations for requests to the operator, contacting the operator and the help page, keyed by the English source text. Keep {placeholders}.
 * Round 2, builder G.
 */
export const operatorrequests: Record<string, string> = {
  Requests: 'Zahtevi',
  'Contact the operator': 'Kontaktirajte operatera',
  'Facilities, their subscriptions and history, invoices and payments, plans and requests.':
    'Ustanove, njihove pretplate i istorija, fakture i uplate, planovi i zahtevi.',
  'Help and contact': 'Pomoć i kontakt',
  // Contacting the operator (footer, sign-in page, subscription notices, settings).
  'Support hours': 'Radno vreme podrške',
  'Support hours: {hours}': 'Radno vreme podrške: {hours}',
  'When support answers, e.g. Mon–Fri 08:00–16:00. Shown with the support e-mail and phone in the footer, on the sign-in page and on the help page.':
    'Kada podrška odgovara, npr. pon–pet 08:00–16:00. Prikazuje se uz e-poštu i telefon podrške u podnožju, na stranici za prijavu i na stranici pomoći.',
  'Trouble signing in? Staff ask their facility’s IT support first.':
    'Problemi sa prijavom? Osoblje se prvo obraća IT podršci svoje ustanove.',
  'The operator of the service': 'Operater usluge',
  'Write a request': 'Napišite zahtev',
  // The help page.
  'In an emergency call 112': 'U hitnom slučaju pozovite 112',
  'Pacient is not an emergency service, and neither its support nor messages to your care team are answered around the clock.':
    'Pacient nije hitna služba, a ni njegova podrška ni poruke vašem timu za negu ne dobijaju odgovor neprekidno.',
  'The operator has not published its contact details yet. Ask your facility.':
    'Operater još nije objavio kontakt podatke. Obratite se svojoj ustanovi.',
  'Write a request to the operator': 'Napišite zahtev operateru',
  'Who helps with what': 'Ko pomaže oko čega',
  'Patients: questions about your health record, appointments or results go to your health facility or your care team. The operator cannot answer them.':
    'Pacijenti: pitanja o vašem zdravstvenom kartonu, terminima ili rezultatima uputite svojoj zdravstvenoj ustanovi ili timu za negu. Operater ne može da odgovori na njih.',
  'Staff: your facility’s IT support helps with your account, sign-in and devices.':
    'Osoblje: IT podrška vaše ustanove pomaže oko naloga, prijave i uređaja.',
  'Directors and IT support of a facility write to the operator in Pacient under “Contact the operator”: billing, accounts, technical problems, data protection and security incidents.':
    'Direktori i IT podrška ustanove pišu operateru u sistemu Pacient pod „Kontaktirajte operatera“: naplata, nalozi, tehnički problemi, zaštita podataka i bezbednosni incidenti.',
  'Never send patient information to the operator: no names, personal numbers or health details.':
    'Nikada ne šaljite operateru podatke o pacijentima: ni imena, ni lične brojeve, ni zdravstvene podatke.',
  'What the operator can and cannot see': 'Šta operater može, a šta ne može da vidi',
  'The operator’s administrators can see:': 'Administratori operatera mogu da vide:',
  'accounts: name, e-mail, role, facility, and whether sign-in works':
    'naloge: ime, e-poštu, ulogu, ustanovu i da li prijava radi',
  'the facilities that are customers, their subscriptions and invoices':
    'ustanove koje su korisnici, njihove pretplate i fakture',
  'the requests facilities send them': 'zahteve koje im ustanove šalju',
  'how the service is running, without health data': 'kako usluga radi, bez zdravstvenih podataka',
  'They cannot see:': 'Ne mogu da vide:',
  'health records: diagnoses, results, medicines, notes, documents or messages with care teams':
    'zdravstvene kartone: dijagnoze, rezultate, lekove, beleške, dokumente ili poruke sa timovima za negu',
  'lists of patients, or who is a patient of which facility':
    'spiskove pacijenata, niti ko je pacijent koje ustanove',
  'Every access to a health record is logged, and patients can see who opened theirs.':
    'Svaki pristup zdravstvenom kartonu se beleži, a pacijenti vide ko je otvorio njihov.',
  // Requests: categories, statuses and shared parts.
  'Billing and invoices|request category': 'Naplata i fakture',
  'Accounts and access|request category': 'Nalozi i pristup',
  'Technical problem|request category': 'Tehnički problem',
  'Data protection|request category': 'Zaštita podataka',
  'Security incident|request category': 'Bezbednosni incident',
  'Something else|request category': 'Nešto drugo',
  'Open|request status': 'Otvoren',
  'Waiting for your answer|request status': 'Čeka vaš odgovor',
  'Waiting for the facility|request status': 'Čeka ustanovu',
  'Resolved|request status': 'Rešen',
  'High priority': 'Visok prioritet',
  'Do not include patient information: no names, personal numbers or health details.':
    'Ne navodite podatke o pacijentima: ni imena, ni lične brojeve, ni zdravstvene podatke.',
  'This text contains a 10-digit number that looks like a personal number. Remove it: requests are never about a patient.':
    'Ovaj tekst sadrži broj od 10 cifara koji liči na lični broj. Uklonite ga: zahtevi se nikada ne odnose na pacijenta.',
  Conversation: 'Prepiska',
  '{name} (operator)': '{name} (operater)',
  'The operator': 'Operater',
  'Reference|request': 'Broj zahteva',
  'Opened|request': 'Otvoren',
  'Resolved on': 'Rešen',
  'Last change': 'Poslednja izmena',
  // The facility's pages.
  'Questions and problems for the operator of the service: billing, accounts, technical problems, data protection and security incidents. The operator never sees patient records.':
    'Pitanja i problemi za operatera usluge: naplata, nalozi, tehnički problemi, zaštita podataka i bezbednosni incidenti. Operater nikada ne vidi kartone pacijenata.',
  'New request': 'Novi zahtev',
  'New request to the operator': 'Novi zahtev operateru',
  'Also by e-mail or phone': 'Takođe e-poštom ili telefonom',
  'Requests of your facility': 'Zahtevi vaše ustanove',
  'Write to the operator with “New request”.': 'Pišite operateru preko „Novi zahtev“.',
  'Do not include patient information': 'Ne navodite podatke o pacijentima',
  'Requests reach the operator, who never sees patient records. Write about the service – no names, personal numbers or health details of patients.':
    'Zahtevi stižu operateru, koji nikada ne vidi kartone pacijenata. Pišite o usluzi – bez imena, ličnih brojeva ili zdravstvenih podataka pacijenata.',
  'A security incident reaches every administrator at once':
    'Bezbednosni incident odmah stiže svim administratorima',
  'It is of high priority and e-mailed to all the operator’s administrators. Also follow your facility’s own incident procedure, and in an emergency call 112.':
    'Ima visok prioritet i šalje se e-poštom svim administratorima operatera. Pratite i postupak za incidente svoje ustanove, a u hitnom slučaju pozovite 112.',
  'All requests of your facility': 'Svi zahtevi vaše ustanove',
  'Your message': 'Vaša poruka',
  'Writing again opens the request again.': 'Ako ponovo pišete, zahtev se ponovo otvara.',
  'The operator is waiting for your answer.': 'Operater čeka vaš odgovor.',
  // The administrator's inbox.
  'What facilities ask the operator: answer them and keep their status up to date. Requests are never about a patient.':
    'Šta ustanove traže od operatera: odgovorite im i održavajte njihov status ažurnim. Zahtevi se nikada ne odnose na pacijenta.',
  'High priority, unresolved': 'Visok prioritet, nerešeni',
  'Not resolved': 'Nerešeni',
  'Not answered yet': 'Još bez odgovora',
  'All requests': 'Svi zahtevi',
  Answer: 'Odgovor',
  'The person who asked is notified; the facility sees the answer as from the operator, without your name. Never ask for patient information.':
    'Osoba koja je pitala dobija obaveštenje; ustanova vidi odgovor kao odgovor operatera, bez vašeg imena. Nikada ne tražite podatke o pacijentima.',
  'Status after the answer': 'Status posle odgovora',
  'Leave the status as it is': 'Ostavi status kakav jeste',
  'Mark as resolved': 'Označi kao rešen',
  'Mark as open': 'Označi kao otvoren',
  'Open again': 'Ponovo otvori',
  'Wait for the facility': 'Čekaj ustanovu',
  'Requests from facilities': 'Zahtevi ustanova',
  'Open the requests': 'Otvori zahteve',
  // Messages from the server.
  'Do not include patient information. This text contains a 10-digit number that looks like a personal number: remove it and send again.':
    'Ne navodite podatke o pacijentima. Ovaj tekst sadrži broj od 10 cifara koji liči na lični broj: uklonite ga i pošaljite ponovo.',
};
