/**
 * Albanian (sq) translations for billing details, invoice and credit note PDFs and their e-mailing, keyed by the English source text. Keep {placeholders}.
 * Round 2, builder B1.
 */
export const billingdocs: Record<string, string> = {
  // Billing readiness (platform overview, starting a subscription)
  'Billing is not ready': 'Faturimi nuk është gati',
  'No invoice can be issued until these operator settings are filled in:':
    'Asnjë faturë nuk mund të lëshohet derisa të plotësohen këto cilësime të operatorit:',
  'Until then no paid subscription can be started, and trials that end and renewals wait (their invoices are issued once the settings are complete). Clinical work, sign-in and accounts are never affected.':
    'Deri atëherë nuk mund të nisë asnjë abonim me pagesë, ndërsa periudhat provuese që përfundojnë dhe rinovimet presin (faturat e tyre lëshohen sapo cilësimet të jenë të plota). Puna klinike, hyrja dhe llogaritë nuk preken kurrë.',
  'Complete the operator settings': 'Plotësoni cilësimet e operatorit',
  'Billing is not ready: invoices cannot be issued until {settings} are filled in.':
    'Faturimi nuk është gati: faturat nuk mund të lëshohen derisa të plotësohen {settings}.',
  'Billing is not ready: fill in the missing operator settings first':
    'Faturimi nuk është gati: fillimisht plotësoni cilësimet që mungojnë të operatorit',
  'Enter the VAT number to charge VAT, or set the VAT rate to 0':
    'Shkruani numrin e TVSH-së për të llogaritur TVSH, ose vendosni normën e TVSH-së 0',

  // Billing details of a facility
  'Billing details': 'Të dhënat e faturimit',
  'Billing details (optional)': 'Të dhënat e faturimit (opsionale)',
  'Billing details of {facility}': 'Të dhënat e faturimit të {facility}',
  'Billing details changed': 'Të dhënat e faturimit u ndryshuan',
  'Add billing details': 'Shto të dhënat e faturimit',
  'Edit billing details': 'Ndrysho të dhënat e faturimit',
  'Save billing details': 'Ruaj të dhënat e faturimit',
  'No billing details yet': 'Ende pa të dhëna faturimi',
  'Legal name': 'Emri juridik',
  'The legal entity that is invoiced, as registered':
    'Subjekti juridik që faturohet, siç është i regjistruar',
  'Business number (NUI)': 'Numri i biznesit (NUI)',
  'Fiscal number': 'Numri fiskal',
  'Billing address': 'Adresa e faturimit',
  'Empty: the facility’s address': 'Bosh: adresa e institucionit',
  'Billing e-mails': 'E-mailet e faturimit',
  'Up to three addresses, separated by commas. The facility’s active directors receive invoices as well.':
    'Deri në tri adresa, të ndara me presje. Edhe drejtorët aktivë të institucionit i marrin faturat.',
  'Contact person': 'Personi kontaktues',
  'Customer reference': 'Referenca e klientit',
  'Their purchase order or contract number, printed on invoices':
    'Numri i porosisë ose i kontratës së tyre, i shtypur në fatura',
  'Your reference': 'Referenca juaj',
  'Enter the legal name for the billing details, or leave them all empty.':
    'Shkruani emrin juridik për të dhënat e faturimit, ose lërini të gjitha bosh.',
  'Enter at most three billing e-mail addresses':
    'Shkruani më së shumti tri adresa e-maili për faturim',
  'The next invoice uses these details; invoices already issued keep the details they were issued with.':
    'Fatura e ardhshme përdor këto të dhëna; faturat e lëshuara i ruajnë të dhënat me të cilat u lëshuan.',
  'Changed on {date} by {name}': 'Ndryshuar më {date} nga {name}',
  'Invoices name the facility as it is registered in Pacient until its billing details are entered.':
    'Faturat e emërtojnë institucionin siç është i regjistruar në Pacient derisa të shënohen të dhënat e tij të faturimit.',
  'Invoices and credit notes are e-mailed to the billing e-mails and to the facility’s active directors.':
    'Faturat dhe notat e kreditit u dërgohen me e-mail adresave të faturimit dhe drejtorëve aktivë të institucionit.',
  'Who is invoiced for this facility. Without them invoices name the facility as registered here; they can be added later on the facility’s page.':
    'Kush faturohet për këtë institucion. Pa to faturat e emërtojnë institucionin siç regjistrohet këtu; mund të shtohen më vonë në faqen e institucionit.',
  'Invoices and credit notes are sent to these billing e-mails and to the facility’s directors. To change these details, contact the service operator.':
    'Faturat dhe notat e kreditit u dërgohen këtyre adresave të faturimit dhe drejtorëve të institucionit. Për t’i ndryshuar këto të dhëna, kontaktoni operatorin e shërbimit.',
  'Invoices name {facility} as it is registered in Pacient. To have them name another legal entity or reach your accounts department, contact the service operator.':
    'Faturat e emërtojnë {facility} siç është i regjistruar në Pacient. Që ato të emërtojnë një subjekt tjetër juridik ose të arrijnë te kontabiliteti juaj, kontaktoni operatorin e shërbimit.',

  // Invoices on paper and as PDF
  'Not registered for VAT': 'Jo i regjistruar për TVSH',
  'Sent on': 'Dërguar më',
  'Not sent': 'Pa u dërguar',
  'Download PDF': 'Shkarko PDF',
  // The visible "Download PDF" comes first, so the accessible name contains it.
  'Download PDF of invoice {number}': 'Shkarko PDF të faturës {number}',
  'Download PDF of credit note {number}': 'Shkarko PDF të notës së kreditit {number}',
  'Documents to download': 'Dokumentet për shkarkim',
  'Invoices and credit notes as PDF': 'Faturat dhe notat e kreditit si PDF',
  'For invoice {number}': 'Për faturën {number}',

  // E-mailing them
  'Sent by e-mail': 'Dërguar me e-mail',
  'Not e-mailed yet': 'Ende pa u dërguar me e-mail',
  'Documents are e-mailed to the billing e-mails of the facility’s billing details and to its active directors.':
    'Dokumentet u dërgohen me e-mail adresave të faturimit të institucionit dhe drejtorëve të tij aktivë.',
  'E-mails with {number}': 'E-mailet me {number}',
  Queued: 'Në radhë',
  Why: 'Pse',
  'Attempts: {count}': 'Përpjekje: {count}',
  'On issue': 'Në lëshim',
  'Overdue reminder': 'Kujtesë për vonesë',
  'Sent again': 'Dërguar sërish',
  'Waiting to be sent': 'Në pritje të dërgimit',
  'Being sent': 'Po dërgohet',
  'Sent|e-mail': 'Dërguar',
  'Not delivered': 'Nuk u dorëzua',
  'Send again': 'Dërgo sërish',
  'Send invoice {number} again': 'Dërgo sërish faturën {number}',
  'Send credit note {number} again': 'Dërgo sërish notën e kreditit {number}',
  'It is e-mailed with its PDF to the billing e-mails of the facility’s billing details and to its active directors, each address once.':
    'Dërgohet me e-mail bashkë me PDF-në te adresat e faturimit të institucionit dhe te drejtorët e tij aktivë, një herë për çdo adresë.',
  'There is nobody to send it to: add a billing e-mail to the facility’s billing details, or a director.':
    'Nuk ka kujt t’i dërgohet: shtoni një e-mail faturimi te të dhënat e faturimit të institucionit, ose një drejtor.',
  'A voided invoice is not sent.': 'Një faturë e anuluar nuk dërgohet.',
};
