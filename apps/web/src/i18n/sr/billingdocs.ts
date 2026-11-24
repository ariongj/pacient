/**
 * Serbian Latin (sr) translations for billing details, invoice and credit note PDFs and their e-mailing, keyed by the English source text. Keep {placeholders}.
 * Round 2, builder B1.
 */
export const billingdocs: Record<string, string> = {
  // Billing readiness (platform overview, starting a subscription)
  'Billing is not ready': 'Fakturisanje nije spremno',
  'No invoice can be issued until these operator settings are filled in:':
    'Nijedna faktura ne može da se izda dok se ne popune ova podešavanja operatera:',
  'Until then no paid subscription can be started, and trials that end and renewals wait (their invoices are issued once the settings are complete). Clinical work, sign-in and accounts are never affected.':
    'Do tada ne može da se pokrene nijedna plaćena pretplata, a probni periodi koji ističu i obnove čekaju (njihove fakture se izdaju čim podešavanja budu potpuna). Klinički rad, prijava i nalozi nikada nisu pogođeni.',
  'Complete the operator settings': 'Dopunite podešavanja operatera',
  'Billing is not ready: invoices cannot be issued until {settings} are filled in.':
    'Fakturisanje nije spremno: fakture ne mogu da se izdaju dok se ne popuni sledeće: {settings}.',
  'Billing is not ready: fill in the missing operator settings first':
    'Fakturisanje nije spremno: prvo popunite podešavanja operatera koja nedostaju',
  'Enter the VAT number to charge VAT, or set the VAT rate to 0':
    'Unesite PDV broj da biste obračunavali PDV ili postavite stopu PDV-a na 0',

  // Billing details of a facility
  'Billing details': 'Podaci za fakturisanje',
  'Billing details (optional)': 'Podaci za fakturisanje (opciono)',
  'Billing details of {facility}': 'Podaci za fakturisanje: {facility}',
  'Billing details changed': 'Podaci za fakturisanje su izmenjeni',
  'Add billing details': 'Dodaj podatke za fakturisanje',
  'Edit billing details': 'Izmeni podatke za fakturisanje',
  'Save billing details': 'Sačuvaj podatke za fakturisanje',
  'No billing details yet': 'Još nema podataka za fakturisanje',
  'Legal name': 'Pravni naziv',
  'The legal entity that is invoiced, as registered':
    'Pravno lice kome se fakturiše, kako je registrovano',
  'Business number (NUI)': 'Poslovni broj (NUI)',
  'Fiscal number': 'Fiskalni broj',
  'Billing address': 'Adresa za fakturisanje',
  'Empty: the facility’s address': 'Prazno: adresa ustanove',
  'Billing e-mails': 'E-mail adrese za fakturisanje',
  'Up to three addresses, separated by commas. The facility’s active directors receive invoices as well.':
    'Najviše tri adrese, odvojene zarezima. Fakture dobijaju i aktivni direktori ustanove.',
  'Contact person': 'Kontakt osoba',
  'Customer reference': 'Referenca kupca',
  'Their purchase order or contract number, printed on invoices':
    'Njihov broj narudžbenice ili ugovora, štampa se na fakturama',
  'Your reference': 'Vaša referenca',
  'Enter the legal name for the billing details, or leave them all empty.':
    'Unesite pravni naziv za podatke za fakturisanje ili ostavite sva polja prazna.',
  'Enter at most three billing e-mail addresses':
    'Unesite najviše tri e-mail adrese za fakturisanje',
  'The next invoice uses these details; invoices already issued keep the details they were issued with.':
    'Sledeća faktura koristi ove podatke; već izdate fakture zadržavaju podatke sa kojima su izdate.',
  'Changed on {date} by {name}': 'Izmenjeno {date}, izmenio/la {name}',
  'Invoices name the facility as it is registered in Pacient until its billing details are entered.':
    'Fakture navode ustanovu kako je registrovana u Pacientu dok se ne unesu njeni podaci za fakturisanje.',
  'Invoices and credit notes are e-mailed to the billing e-mails and to the facility’s active directors.':
    'Fakture i knjižna odobrenja šalju se e-mailom na adrese za fakturisanje i aktivnim direktorima ustanove.',
  'Who is invoiced for this facility. Without them invoices name the facility as registered here; they can be added later on the facility’s page.':
    'Kome se fakturiše za ovu ustanovu. Bez njih fakture navode ustanovu kako je ovde registrovana; mogu da se dodaju kasnije na stranici ustanove.',
  'Invoices and credit notes are sent to these billing e-mails and to the facility’s directors. To change these details, contact the service operator.':
    'Fakture i knjižna odobrenja šalju se na ove adrese za fakturisanje i direktorima ustanove. Za izmenu ovih podataka obratite se operateru usluge.',
  'Invoices name {facility} as it is registered in Pacient. To have them name another legal entity or reach your accounts department, contact the service operator.':
    'Fakture navode {facility} kako je registrovana u Pacientu. Ako treba da navode drugo pravno lice ili da stižu vašem računovodstvu, obratite se operateru usluge.',

  // Invoices on paper and as PDF
  'Not registered for VAT': 'Nije u sistemu PDV-a',
  'Sent on': 'Poslato',
  'Not sent': 'Nije poslato',
  'Download PDF': 'Preuzmi PDF',
  'Download invoice {number} as PDF': 'Preuzmi fakturu {number} kao PDF',
  'Download credit note {number} as PDF': 'Preuzmi knjižno odobrenje {number} kao PDF',
  'Documents to download': 'Dokumenti za preuzimanje',
  'Invoices and credit notes as PDF': 'Fakture i knjižna odobrenja kao PDF',
  'For invoice {number}': 'Za fakturu {number}',

  // E-mailing them
  'Sent by e-mail': 'Poslato e-mailom',
  'Not e-mailed yet': 'Još nije poslato e-mailom',
  'Documents are e-mailed to the billing e-mails of the facility’s billing details and to its active directors.':
    'Dokumenti se šalju e-mailom na adrese za fakturisanje ustanove i njenim aktivnim direktorima.',
  'E-mails with {number}': 'E-mailovi sa {number}',
  Queued: 'U redu za slanje',
  Why: 'Zašto',
  'Attempts: {count}': 'Pokušaja: {count}',
  'On issue': 'Pri izdavanju',
  'Overdue reminder': 'Podsetnik o docnji',
  'Sent again': 'Ponovo poslato',
  'Waiting to be sent': 'Čeka slanje',
  'Being sent': 'Šalje se',
  'Sent|e-mail': 'Poslato',
  'Not delivered': 'Nije isporučeno',
  'Send again': 'Pošalji ponovo',
  'Send invoice {number} again': 'Ponovo pošalji fakturu {number}',
  'Send credit note {number} again': 'Ponovo pošalji knjižno odobrenje {number}',
  'It is e-mailed with its PDF to the billing e-mails of the facility’s billing details and to its active directors, each address once.':
    'Šalje se e-mailom sa PDF-om na adrese za fakturisanje ustanove i njenim aktivnim direktorima, na svaku adresu jednom.',
  'There is nobody to send it to: add a billing e-mail to the facility’s billing details, or a director.':
    'Nema kome da se pošalje: dodajte e-mail adresu za fakturisanje u podatke ustanove ili direktora.',
  'A voided invoice is not sent.': 'Poništena faktura se ne šalje.',
};
