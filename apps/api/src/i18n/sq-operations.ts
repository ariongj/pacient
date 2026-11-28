/**
 * Albanian translations of server messages for operations (operator alerts, the test e-mail). English source texts are the keys.
 * Round 2, builder S2.
 */
export const sqOperations: Record<string, string> = {
  // Operator alerts (notification titles; the details stay in the alert's English message).
  'Critical: {title}': 'Kritik: {title}',
  'Warning: {title}': 'Paralajmërim: {title}',
  'The background job “{title}” has stopped': 'Puna në sfond „{title}” është ndalur',
  // The background jobs, as on System health (the web app's dictionary).
  'E-mail delivery': 'Dërgimi i e-mailit',
  'SMS delivery': 'Dërgimi i SMS-ve',
  'Escalation of unanswered results': 'Përshkallëzimi i rezultateve pa përgjigje',
  'Appointment reminders': 'Kujtesat për takimet',
  'Vaccination reminders': 'Kujtesat për vaksinimin',
  'Early warning scores': 'Pikët e paralajmërimit të hershëm',
  'Data retention': 'Ruajtja e të dhënave',
  'Downtime packs': 'Paketat për ndërprerje',
  'Waiting list warnings': 'Paralajmërimet e listave të pritjes',
  'Disease registers': 'Regjistrat e sëmundjeve',
  'Complaint deadlines': 'Afatet e ankesave',
  'Licence expiry': 'Skadimi i licencave',
  'Subscriptions and invoices': 'Abonimet dhe faturat',
  'Antenatal reminders': 'Kujtesat antenatale',
  'Screening invitations': 'Ftesat për depistim',
  'Sepsis escalation': 'Përshkallëzimi i sepsës',
  'Equipment maintenance': 'Mirëmbajtja e pajisjeve',
  'Infection control': 'Kontrolli i infeksioneve',
  'Remote monitoring digests': 'Përmbledhjet e monitorimit në distancë',
  'Dialysis sessions': 'Seancat e dializës',
  'Mental health deadlines': 'Afatet e shëndetit mendor',
  'Questionnaire reminders': 'Kujtesat për pyetësorët',
  'Access reviews': 'Rishikimi i qasjeve',
  'Charge capture': 'Regjistrimi i tarifave',
  'Disease surveillance': 'Mbikëqyrja e sëmundjeve',
  'E-mails could not be delivered': 'E-mailet nuk u dërguan dot',
  'E-mails are waiting to be sent': 'E-mailet presin të dërgohen',
  'Text messages could not be delivered': 'Mesazhet SMS nuk u dërguan dot',
  'Text messages are waiting to be sent': 'Mesazhet SMS presin të dërgohen',
  'No recent database backup': 'Nuk ka kopje rezervë të fundit të bazës së të dhënave',
  'Invoices cannot be issued: operator settings are incomplete':
    'Faturat nuk mund të lëshohen: cilësimet e operatorit janë të paplota',
  'The HTTPS certificate expires soon': 'Certifikata HTTPS skadon së shpejti',
  'Pacient needs the operator’s attention': 'Pacient kërkon vëmendjen e operatorit',
  // Test e-mail.
  'Pacient: test e-mail': 'Pacient: e-mail provë',
  'E-mail delivery works': 'Dërgimi i e-mailit funksionon',
  'This is a test e-mail from Pacient, sent at your request from System health. If you can read it, e-mail delivery works.':
    'Ky është një e-mail provë nga Pacient, i dërguar me kërkesën tuaj nga Gjendja e sistemit. Nëse mund ta lexoni, dërgimi i e-mailit funksionon.',
  'If it arrived in the spam folder, check the SPF, DKIM and DMARC records of the sending domain.':
    'Nëse arriti në dosjen e postës së padëshiruar (spam), kontrolloni regjistrat SPF, DKIM dhe DMARC të domenit dërgues.',
};
