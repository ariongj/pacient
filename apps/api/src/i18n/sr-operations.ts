/**
 * Serbian translations of server messages for operations (operator alerts, the test e-mail). English source texts are the keys.
 * Round 2, builder S2.
 */
export const srOperations: Record<string, string> = {
  // Operator alerts (notification titles; the details stay in the alert's English message).
  'Critical: {title}': 'Kritično: {title}',
  'Warning: {title}': 'Upozorenje: {title}',
  'The background job “{title}” has stopped': 'Pozadinski posao „{title}” je stao',
  // The background jobs, as on System health (the web app's dictionary).
  'E-mail delivery': 'Slanje e-pošte',
  'SMS delivery': 'Slanje SMS poruka',
  'Escalation of unanswered results': 'Eskalacija neodgovorenih rezultata',
  'Appointment reminders': 'Podsetnici za termine',
  'Vaccination reminders': 'Podsetnici za vakcinaciju',
  'Early warning scores': 'Skorovi ranog upozorenja',
  'Data retention': 'Čuvanje podataka',
  'Downtime packs': 'Paketi za prekid rada',
  'Waiting list warnings': 'Upozorenja lista čekanja',
  'Disease registers': 'Registri bolesti',
  'Complaint deadlines': 'Rokovi za pritužbe',
  'Licence expiry': 'Istek licenci',
  'Subscriptions and invoices': 'Pretplate i fakture',
  'Antenatal reminders': 'Prenatalni podsetnici',
  'Screening invitations': 'Pozivi na skrining',
  'Sepsis escalation': 'Eskalacija sepse',
  'Equipment maintenance': 'Održavanje opreme',
  'Infection control': 'Kontrola infekcija',
  'Remote monitoring digests': 'Pregledi praćenja na daljinu',
  'Dialysis sessions': 'Dijalizne sesije',
  'Mental health deadlines': 'Rokovi mentalnog zdravlja',
  'Questionnaire reminders': 'Podsetnici za upitnike',
  'Access reviews': 'Pregled pristupa',
  'Charge capture': 'Evidentiranje naplate',
  'Disease surveillance': 'Nadzor nad bolestima',
  'E-mails could not be delivered': 'E-poruke nisu mogle biti isporučene',
  'E-mails are waiting to be sent': 'E-poruke čekaju na slanje',
  'Text messages could not be delivered': 'SMS poruke nisu mogle biti isporučene',
  'Text messages are waiting to be sent': 'SMS poruke čekaju na slanje',
  'No recent database backup': 'Nema nedavne rezervne kopije baze podataka',
  'Invoices cannot be issued: operator settings are incomplete':
    'Fakture se ne mogu izdati: podešavanja operatera nisu potpuna',
  'The HTTPS certificate expires soon': 'HTTPS sertifikat uskoro ističe',
  'Pacient needs the operator’s attention': 'Pacient traži pažnju operatera',
  // Test e-mail.
  'Pacient: test e-mail': 'Pacient: probna e-poruka',
  'E-mail delivery works': 'Slanje e-pošte radi',
  'This is a test e-mail from Pacient, sent at your request from System health. If you can read it, e-mail delivery works.':
    'Ovo je probna e-poruka iz Pacienta, poslata na vaš zahtev sa stranice Stanje sistema. Ako možete da je pročitate, slanje e-pošte radi.',
  'If it arrived in the spam folder, check the SPF, DKIM and DMARC records of the sending domain.':
    'Ako je stigla u fasciklu neželjene pošte (spam), proverite SPF, DKIM i DMARC zapise domena pošiljaoca.',
};
