/**
 * Albanian (sq) translations of messages people receive, keyed by the English source text.
 * Placeholders in braces – {name} – must be kept as they are. Never put health information in a
 * notification, email or SMS text.
 */
export const sq: Record<string, string> = {
  /* ---- notification titles */
  'A care task you created was completed': 'Një detyrë kujdesi që keni krijuar u përfundua',
  'You have been referred to another facility': 'Jeni referuar në një institucion tjetër',
  'Your referral was accepted': 'Referimi juaj u pranua',
  'A referred patient was assigned to you': 'Ju është caktuar një pacient i referuar',
  'Your referral was declined': 'Referimi juaj u refuzua',
  'A referral was declined': 'Një referim u refuzua',
  'A referral you made was completed': 'Një referim që keni bërë u përfundua',
  'You have been given access to a family member’s health record':
    'Ju është dhënë qasje në kartelën shëndetësore të një anëtari të familjes',
  'A guardian was given access to your record': 'Një kujdestari iu dha qasje në kartelën tuaj',
  'Your access to a family member’s record has ended':
    'Qasja juaj në kartelën e një anëtari të familjes ka përfunduar',
  'New prescription awaiting verification': 'Recetë e re në pritje të verifikimit',
  'A returned prescription was resubmitted': 'Një recetë e kthyer u ridërgua',
  'A new test result is available': 'Një rezultat i ri analize është i disponueshëm',
  'A patient requested a record correction': 'Një pacient kërkoi korrigjim të kartelës',
  'Your correction request was answered': 'Kërkesa juaj për korrigjim mori përgjigje',
  'Urgent message in #{channel}': 'Mesazh urgjent në #{channel}',
  'Your emergency access was reviewed': 'Qasja juaj emergjente u shqyrtua',
  'CRITICAL laboratory result – review now': 'Rezultat KRITIK laboratorik – shqyrtojeni tani',
  'A laboratory result was corrected – review again':
    'Një rezultat laboratorik u korrigjua – shqyrtojeni sërish',
  'New laboratory results to review': 'Rezultate të reja laboratorike për shqyrtim',
  '{title} (covering for {doctor})': '{title} (në zëvendësim të {doctor})',
  'New message from a patient': 'Mesazh i ri nga një pacient',
  'New message from your care team': 'Mesazh i ri nga ekipi juaj i kujdesit',
  'You are covering results for {doctor} from {from} to {to}':
    'Ju zëvendësoni {doctor} për rezultatet nga {from} deri më {to}',
  '{doctor} will cover your results from {from} to {to}':
    '{doctor} do t’ju zëvendësojë për rezultatet nga {from} deri më {to}',
  'A cover arrangement you were part of was cancelled':
    'Një zëvendësim në të cilin ishit pjesë u anulua',
  'Critical result still not reviewed (30 min)': 'Rezultat kritik ende i pashqyrtuar (30 min)',
  'Critical result still not reviewed (2 hours)': 'Rezultat kritik ende i pashqyrtuar (2 orë)',
  'A critical result has waited 30 min for review – contact {doctor}':
    'Një rezultat kritik ka pritur 30 min për shqyrtim – kontaktoni {doctor}',
  'A critical result has waited 2 hours for review – contact {doctor}':
    'Një rezultat kritik ka pritur 2 orë për shqyrtim – kontaktoni {doctor}',
  'A consent decision was recorded in your record':
    'Në kartelën tuaj u regjistrua një vendim për pëlqimin',
  'New appointment request': 'Kërkesë e re për termin',
  'An appointment was booked for you': 'Ju është rezervuar një termin',
  'Your patient has arrived': 'Pacienti juaj ka ardhur',
  'Your appointment was confirmed': 'Termini juaj u konfirmua',
  'Your appointment was cancelled': 'Termini juaj u anulua',
  'Your appointment was completed': 'Termini juaj përfundoi',
  'Your appointment was no-show': 'Termini juaj u shënua si mosparaqitje',
  'Your appointment was requested': 'Termini juaj u kërkua',
  'A patient cancelled an appointment': 'Një pacient anuloi një termin',
  'A patient requested an appointment': 'Një pacient kërkoi një termin',
  'A prescription was returned by the pharmacy': 'Një recetë u kthye nga farmacia',
  'Your medication is ready at the pharmacy': 'Barnat tuaja janë gati në farmaci',
  'A patient added a document to their record': 'Një pacient shtoi një dokument në kartelën e vet',
  'A new document is available in your record':
    'Një dokument i ri është i disponueshëm në kartelën tuaj',
  '{title} (family member)': '{title} (anëtar i familjes)',

  /* ---- SMS */
  'Pacient: {title}. Sign in to view.': 'Pacient: {title}. Kyçuni për ta parë.',
  'Pacient verification code: {code}. It expires in {minutes} minutes. Never share this code.':
    'Kodi i verifikimit Pacient: {code}. Skadon pas {minutes} minutash. Mos ia jepni askujt këtë kod.',

  /* ---- email */
  'Hello {name},': 'Përshëndetje {name},',
  'Activate your Pacient account': 'Aktivizoni llogarinë tuaj në Pacient',
  'Activate your account': 'Aktivizoni llogarinë',
  'Activate your account: {url}': 'Aktivizoni llogarinë: {url}',
  'An account has been created for you in Pacient. Choose your own password to activate it. The link works once and expires in 72 hours.':
    'Për ju është krijuar një llogari në Pacient. Zgjidhni fjalëkalimin tuaj për ta aktivizuar. Lidhja funksionon vetëm një herë dhe skadon pas 72 orësh.',
  'Choose a password': 'Zgjidhni fjalëkalimin',
  'Reset your Pacient password': 'Rivendosni fjalëkalimin tuaj në Pacient',
  'Reset your password': 'Rivendosni fjalëkalimin',
  'Reset your password: {url}': 'Rivendosni fjalëkalimin: {url}',
  'We received a request to reset your Pacient password. The link works once and expires in one hour. Resetting signs you out on all devices.':
    'Morëm një kërkesë për rivendosjen e fjalëkalimit tuaj në Pacient. Lidhja funksionon vetëm një herë dhe skadon pas një ore. Rivendosja ju çkyç nga të gjitha pajisjet.',
  'Reset password': 'Rivendos fjalëkalimin',
  'Pacient: {title}': 'Pacient: {title}',
  'Sign in to Pacient to see the details.': 'Kyçuni në Pacient për të parë hollësitë.',
  'Open Pacient': 'Hap Pacient',
  'Open Pacient: {url}': 'Hap Pacient: {url}',
  'If the button does not work, copy this address into your browser:':
    'Nëse butoni nuk funksionon, kopjoni këtë adresë në shfletues:',
  'You receive this because email notifications are on for your Pacient account. For your privacy we never include health information in emails. Change this under My details / Account. In an emergency call 112.':
    'E merrni këtë sepse njoftimet me email janë të aktivizuara për llogarinë tuaj në Pacient. Për privatësinë tuaj, nuk përfshijmë kurrë informacione shëndetësore në email. Këtë mund ta ndryshoni te Të dhënat e mia / Llogaria. Në rast emergjence telefononi 112.',
  'If you did not expect this email you can ignore it. Pacient staff will never ask you for your password.':
    'Nëse nuk e prisnit këtë email, mund ta injoroni. Stafi i Pacient nuk do t’ju kërkojë kurrë fjalëkalimin.',
  'Two patient records were merged': 'Dy kartela pacientësh u bashkuan',
  'A patient record merge was undone': 'Bashkimi i kartelave të pacientit u anulua',
};
