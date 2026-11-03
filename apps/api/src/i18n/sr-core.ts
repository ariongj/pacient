/** Serbian (Latin) translations of server messages (English source text → Serbian). */
export const srCore: Record<string, string> = {
  'A care task you created was completed': 'Zadatak nege koji ste kreirali je završen',
  'You have been referred to another facility': 'Upućeni ste u drugu ustanovu',
  'Your referral was accepted': 'Vaš uput je prihvaćen',
  'A referred patient was assigned to you': 'Dodeljen Vam je upućeni pacijent',
  'Your referral was declined': 'Vaš uput je odbijen',
  'A referral was declined': 'Uput je odbijen',
  'A referral you made was completed': 'Uput koji ste izdali je završen',
  'You have been given access to a family member’s health record':
    'Dobili ste pristup zdravstvenom kartonu člana porodice',
  'A guardian was given access to your record': 'Staratelj je dobio pristup Vašem kartonu',
  'Your access to a family member’s record has ended':
    'Vaš pristup kartonu člana porodice je prestao',
  'New prescription awaiting verification': 'Novi recept čeka proveru',
  'A returned prescription was resubmitted': 'Vraćeni recept je ponovo poslat',
  'A new test result is available': 'Dostupan je novi rezultat analize',
  'A patient requested a record correction': 'Pacijent je zatražio ispravku kartona',
  'Your correction request was answered': 'Na Vaš zahtev za ispravku je odgovoreno',
  'Urgent message in #{channel}': 'Hitna poruka u #{channel}',
  'Your emergency access was reviewed': 'Vaš hitni pristup je pregledan',
  'CRITICAL laboratory result – review now': 'KRITIČAN laboratorijski rezultat – pregledajte odmah',
  'A laboratory result was corrected – review again':
    'Laboratorijski rezultat je ispravljen – pregledajte ponovo',
  'New laboratory results to review': 'Novi laboratorijski rezultati za pregled',
  '{title} (covering for {doctor})': '{title} (zamena za {doctor})',
  'New message from a patient': 'Nova poruka od pacijenta',
  'New message from your care team': 'Nova poruka od Vašeg tima za negu',
  'You are covering results for {doctor} from {from} to {to}':
    'Preuzimate rezultate za {doctor} od {from} do {to}',
  '{doctor} will cover your results from {from} to {to}':
    '{doctor} će preuzeti Vaše rezultate od {from} do {to}',
  'A cover arrangement you were part of was cancelled':
    'Zamena u kojoj ste učestvovali je otkazana',
  'Critical result still not reviewed (30 min)': 'Kritičan rezultat još nije pregledan (30 min)',
  'Critical result still not reviewed (2 hours)': 'Kritičan rezultat još nije pregledan (2 sata)',
  'A critical result has waited 30 min for review – contact {doctor}':
    'Kritičan rezultat čeka pregled 30 min – kontaktirajte {doctor}',
  'A critical result has waited 2 hours for review – contact {doctor}':
    'Kritičan rezultat čeka pregled 2 sata – kontaktirajte {doctor}',
  'A consent decision was recorded in your record': 'U Vaš karton je upisana odluka o saglasnosti',
  'New appointment request': 'Novi zahtev za termin',
  'An appointment was booked for you': 'Zakazan Vam je termin',
  'Your patient has arrived': 'Vaš pacijent je stigao',
  'Your appointment was confirmed': 'Vaš termin je potvrđen',
  'Your appointment was cancelled': 'Vaš termin je otkazan',
  'Your appointment was completed': 'Vaš termin je obavljen',
  'Your appointment was no-show': 'Niste se pojavili na terminu',
  'Your appointment was requested': 'Vaš termin je zatražen',
  'A patient cancelled an appointment': 'Pacijent je otkazao termin',
  'A patient requested an appointment': 'Pacijent je zatražio termin',
  'A prescription was returned by the pharmacy': 'Apoteka je vratila recept',
  'Your medication is ready at the pharmacy': 'Vaš lek je spreman u apoteci',
  'A patient added a document to their record': 'Pacijent je dodao dokument u svoj karton',
  'A new document is available in your record': 'U Vašem kartonu je dostupan novi dokument',
  '{title} (family member)': '{title} (član porodice)',
  'Pacient: {title}. Sign in to view.': 'Pacient: {title}. Prijavite se da vidite.',
  'Pacient verification code: {code}. It expires in {minutes} minutes. Never share this code.':
    'Pacient kod za potvrdu: {code}. Ističe za {minutes} minuta. Nikada ne delite ovaj kod.',
  'Hello {name},': 'Poštovani/a {name},',
  'Activate your Pacient account': 'Aktivirajte svoj Pacient nalog',
  'Activate your account': 'Aktivirajte nalog',
  'Activate your account: {url}': 'Aktivirajte nalog: {url}',
  'An account has been created for you in Pacient. Choose your own password to activate it. The link works once and expires in 72 hours.':
    'Za Vas je kreiran nalog u sistemu Pacient. Izaberite sopstvenu lozinku da biste ga aktivirali. Link važi jednom i ističe za 72 sata.',
  'Choose a password': 'Izaberite lozinku',
  'Reset your Pacient password': 'Resetujte lozinku za Pacient',
  'Reset your password': 'Resetujte lozinku',
  'Reset your password: {url}': 'Resetujte lozinku: {url}',
  'We received a request to reset your Pacient password. The link works once and expires in one hour. Resetting signs you out on all devices.':
    'Primili smo zahtev za resetovanje Vaše lozinke za Pacient. Link važi jednom i ističe za jedan sat. Resetovanjem se odjavljujete sa svih uređaja.',
  'Reset password': 'Resetuj lozinku',
  'Pacient: {title}': 'Pacient: {title}',
  'Sign in to Pacient to see the details.': 'Prijavite se u Pacient da vidite detalje.',
  'Open Pacient': 'Otvori Pacient',
  'Open Pacient: {url}': 'Otvori Pacient: {url}',
  'If the button does not work, copy this address into your browser:':
    'Ako dugme ne radi, kopirajte ovu adresu u pregledač:',
  'You receive this because email notifications are on for your Pacient account. For your privacy we never include health information in emails. Change this under My details / Account. In an emergency call 112.':
    'Ovu poruku dobijate jer su obaveštenja e-poštom uključena za Vaš Pacient nalog. Radi Vaše privatnosti, u e-poruke nikada ne stavljamo zdravstvene podatke. Ovo možete promeniti u delu Moji podaci / Nalog. U hitnom slučaju pozovite 112.',
  'If you did not expect this email you can ignore it. Pacient staff will never ask you for your password.':
    'Ako niste očekivali ovu poruku, možete je zanemariti. Osoblje sistema Pacient nikada neće tražiti Vašu lozinku.',
  'Two patient records were merged': 'Dva kartona pacijenata su spojena',
  'A patient record merge was undone': 'Spajanje kartona pacijenta je poništeno',
};
