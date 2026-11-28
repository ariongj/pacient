/**
 * Serbian Latin (sr) translations for background jobs, backups, e-mail deliverability and operator alerts, keyed by the English source text. Keep {placeholders}.
 * Round 2, builder S2.
 */
export const operations: Record<string, string> = {
  // Background jobs (System health).
  'Background jobs': 'Pozadinski poslovi',
  'Reminders, escalations, e-mail and the other jobs that run in the background. A job is stalled after three of its intervals without a successful run, and never sooner than 5 minutes.':
    'Podsetnici, eskalacije, e-pošta i drugi poslovi koji se izvršavaju u pozadini. Posao je zastao posle tri svoja intervala bez uspešnog izvršavanja, a nikada pre isteka 5 minuta.',
  '{count} background job has stopped': '{count} pozadinski posao je stao',
  '{count} background jobs have stopped': 'Broj pozadinskih poslova koji su stali: {count}',
  'No successful run for three of its intervals, and for at least 5 minutes. The administrators are alerted; check the API log and restart the API if it does not recover.':
    'Nema uspešnog izvršavanja tokom tri njegova intervala i najmanje 5 minuta. Administratori su obavešteni; proverite dnevnik API-ja i ponovo pokrenite API ako se ne oporavi.',
  'Not started by this instance: switched off on the API instance that answered, or run by another one. Its last run and error are shown, but only an instance that runs a job judges whether it has stalled.':
    'Nije pokrenut na ovoj instanci: isključen je na instanci API-ja koja je odgovorila ili ga izvršava druga instanca. Prikazani su poslednje izvršavanje i greška, ali samo instanca koja izvršava posao procenjuje da li je zastao.',
  'No background job has run yet': 'Nijedan pozadinski posao se još nije izvršio',
  Job: 'Posao',
  'Last success': 'Poslednji uspeh',
  'Last error': 'Poslednja greška',
  'None in 7 days': 'Nijedna u 7 dana',
  'Not started by this instance': 'Nije pokrenut na ovoj instanci',
  Stalled: 'Zastao',
  'Last run failed': 'Poslednje izvršavanje nije uspelo',
  'every {n} s': 'svakih {n} s',
  'every {n} min': 'svakih {n} min',
  'every {n} h': 'svakih {n} h',
  'every {n} days': 'svakih {n} dana',
  'E-mail delivery': 'Slanje e-pošte',
  'SMS delivery': 'Slanje SMS poruka',
  'Escalation of unanswered results': 'Eskalacija neodgovorenih rezultata',
  'Appointment reminders': 'Podsetnici za termine',
  'Vaccination reminders': 'Podsetnici za vakcinaciju',
  'Data retention': 'Čuvanje podataka',
  'Waiting list warnings': 'Upozorenja lista čekanja',
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
  'Charge capture': 'Evidentiranje naplate',
  Watchdog: 'Nadzornik',

  // Backups (System health).
  Backups: 'Rezervne kopije',
  'Backups are not reported to Pacient': 'Rezervne kopije se ne prijavljuju Pacientu',
  'Set OPS_HEARTBEAT_TOKEN on the server: the nightly backup then reports each success, and the administrators are alerted when none arrived for {hours} hours (GO-LIVE.md, Backups).':
    'Podesite OPS_HEARTBEAT_TOKEN na serveru: noćna rezervna kopija tada prijavljuje svaki uspeh, a administratori se obaveštavaju kada nijedna ne stigne {hours} sati (GO-LIVE.md, Backups).',
  'No backup for more than {hours} hours': 'Nema rezervne kopije duže od {hours} sati',
  'Check the backup timer on the server (systemctl status pacienti-backup.timer). Until a backup succeeds, data entered since the last one cannot be restored.':
    'Proverite tajmer rezervnih kopija na serveru (systemctl status pacienti-backup.timer). Dok rezervna kopija ne uspe, podaci uneti od poslednje ne mogu se vratiti.',
  'Too old': 'Previše stara',
  'Up to date|backup': 'Ažurna',
  'Waiting for the first backup': 'Čeka se prva rezervna kopija',
  'Last successful backup': 'Poslednja uspešna rezervna kopija',
  Size: 'Veličina',
  '{n} GB': '{n} GB',
  'A backup that was never restored is not a backup: check a restore every month (deploy/restore-verify.sh).':
    'Rezervna kopija koja nikada nije vraćena nije rezervna kopija: proverite vraćanje svakog meseca (deploy/restore-verify.sh).',

  // E-mail delivery (System health, administrators).
  'E-mail delivery is not configured': 'Slanje e-pošte nije podešeno',
  'Send a test e-mail': 'Pošalji probnu e-poruku',
  'Sends one message to your own address, through the same queue and mail server as every e-mail of Pacient. Check that it arrives and that it is not in the spam folder.':
    'Šalje jednu poruku na vašu adresu, kroz isti red i isti server pošte kao svaka e-poruka Pacienta. Proverite da je stigla i da nije u fascikli neželjene pošte.',
  'Test e-mail queued for {email}': 'Probna e-poruka je stavljena u red za {email}',
  'It should arrive within a minute. If it does not, look below for the error, and check the SPF, DKIM and DMARC records of the sending domain.':
    'Trebalo bi da stigne u roku od minuta. Ako ne stigne, pogledajte grešku ispod i proverite SPF, DKIM i DMARC zapise domena pošiljaoca.',
  'The server has no mail server (SMTP_URL), so the message waits in the queue with every other e-mail. Set it up as described in GO-LIVE.md, E-mail.':
    'Server nema server pošte (SMTP_URL), pa poruka čeka u redu sa svim ostalim e-porukama. Podesite ga kako je opisano u GO-LIVE.md, E-mail.',
  'One test e-mail per minute. Wait a moment and try again.':
    'Jedna probna e-poruka u minutu. Sačekajte trenutak i pokušajte ponovo.',
  'Recent failures': 'Nedavni neuspesi',
  'Messages the mail server refused, newest first. Addresses are shortened and the contents are never shown.':
    'Poruke koje je server pošte odbio, najnovije prve. Adrese su skraćene, a sadržaj se nikada ne prikazuje.',
  '{count} e-mail given up in the last 24 hours':
    'U poslednja 24 sata odustalo se od {count} e-poruke',
  '{count} e-mails given up in the last 24 hours':
    'Broj e-poruka od kojih se odustalo u poslednja 24 sata: {count}',
  '{count} being retried': 'Ponovo se pokušava: {count}',
  'No failed e-mails': 'Nema neuspelih e-poruka',
  'Recent e-mail failures': 'Nedavni neuspesi e-pošte',
  'Error from the mail server': 'Greška servera pošte',
  Queued: 'U redu za slanje',
  Notification: 'Obaveštenje',
  'Test e-mail': 'Probna e-poruka',
  'Invoice or credit note': 'Faktura ili knjižno odobrenje',
  'Given up': 'Odustalo se',
  'Retrying ({attempts} of {max})': 'Ponovni pokušaj ({attempts} od {max})',
  'Next attempt {time}': 'Sledeći pokušaj {time}',

  // Operator alerts (platform overview).
  '{count} alert': '{count} upozorenje',
  '{count} alerts': 'Broj upozorenja: {count}',
  '{count} critical alert': '{count} kritično upozorenje',
  '{count} critical alerts': 'Broj kritičnih upozorenja: {count}',
  'Since {time}': 'Od {time}',
  'last checked {time}': 'poslednja provera {time}',
  'Open System health': 'Otvori Stanje sistema',
  'Open the operator settings': 'Otvori podešavanja operatera',
  'The background job {worker} has stopped': 'Pozadinski posao {worker} je stao',
  'E-mails could not be delivered': 'E-poruke nisu mogle biti isporučene',
  'E-mails are waiting to be sent': 'E-poruke čekaju na slanje',
  'Text messages could not be delivered': 'SMS poruke nisu mogle biti isporučene',
  'Text messages are waiting to be sent': 'SMS poruke čekaju na slanje',
  'No recent database backup': 'Nema nedavne rezervne kopije baze podataka',
  'Invoices cannot be issued: operator settings are incomplete':
    'Fakture se ne mogu izdati: podešavanja operatera nisu potpuna',
  'The HTTPS certificate expires soon': 'HTTPS sertifikat uskoro ističe',
  'Pacient needs the operator’s attention': 'Pacient traži pažnju operatera',
};
