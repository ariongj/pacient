/**
 * Albanian (sq) translations for background jobs, backups, e-mail deliverability and operator alerts, keyed by the English source text. Keep {placeholders}.
 * Round 2, builder S2.
 */
export const operations: Record<string, string> = {
  // Background jobs (System health).
  'Background jobs': 'Punët në sfond',
  'Reminders, escalations, e-mail and the other jobs that run in the background. A job is stalled after three of its intervals without a successful run.':
    'Kujtesat, përshkallëzimet, e-maili dhe punët e tjera që kryhen në sfond. Një punë konsiderohet e ngecur pas tri intervaleve të saj pa asnjë ekzekutim të suksesshëm.',
  '{count} background job has stopped': '{count} punë në sfond është ndalur',
  '{count} background jobs have stopped': '{count} punë në sfond janë ndalur',
  'No successful run for three of its intervals. The administrators are alerted; check the API log and restart the API if it does not recover.':
    'Asnjë ekzekutim i suksesshëm për tri intervale të saj. Administratorët janë njoftuar; kontrolloni regjistrin e API-së dhe rinisni API-në nëse nuk rikuperohet.',
  'No background job has run yet': 'Asnjë punë në sfond nuk është ekzekutuar ende',
  Job: 'Puna',
  'Last success': 'Suksesi i fundit',
  'Last error': 'Gabimi i fundit',
  'None in 7 days': 'Asnjë në 7 ditë',
  'Not started here': 'Nuk është nisur këtu',
  Stalled: 'E ngecur',
  'Last run failed': 'Ekzekutimi i fundit dështoi',
  'every {n} s': 'çdo {n} s',
  'every {n} min': 'çdo {n} min',
  'every {n} h': 'çdo {n} orë',
  'every {n} days': 'çdo {n} ditë',
  'E-mail delivery': 'Dërgimi i e-mailit',
  'SMS delivery': 'Dërgimi i SMS-ve',
  'Escalation of unanswered results': 'Përshkallëzimi i rezultateve pa përgjigje',
  'Appointment reminders': 'Kujtesat për takimet',
  'Vaccination reminders': 'Kujtesat për vaksinimin',
  'Data retention': 'Ruajtja e të dhënave',
  'Waiting list warnings': 'Paralajmërimet e listave të pritjes',
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
  'Charge capture': 'Regjistrimi i tarifave',
  Watchdog: 'Mbikëqyrësi',

  // Backups (System health).
  Backups: 'Kopjet rezervë',
  'Backups are not reported to Pacient': 'Kopjet rezervë nuk raportohen në Pacient',
  'Set OPS_HEARTBEAT_TOKEN on the server: the nightly backup then reports each success, and the administrators are alerted when none arrived for {hours} hours (GO-LIVE.md, Backups).':
    'Vendosni OPS_HEARTBEAT_TOKEN në server: kopja rezervë e natës atëherë raporton çdo sukses dhe administratorët njoftohen kur nuk ka mbërritur asnjë për {hours} orë (GO-LIVE.md, Backups).',
  'No backup for more than {hours} hours': 'Asnjë kopje rezervë për më shumë se {hours} orë',
  'Check the backup timer on the server (systemctl status pacienti-backup.timer). Until a backup succeeds, data entered since the last one cannot be restored.':
    'Kontrolloni kohëmatësin e kopjeve rezervë në server (systemctl status pacienti-backup.timer). Derisa një kopje të ketë sukses, të dhënat e futura që nga e fundit nuk mund të rikthehen.',
  'Too old': 'Shumë e vjetër',
  'Up to date|backup': 'E përditësuar',
  'Waiting for the first backup': 'Në pritje të kopjes së parë',
  'Last successful backup': 'Kopja e fundit e suksesshme',
  Size: 'Madhësia',
  '{n} GB': '{n} GB',
  'A backup that was never restored is not a backup: check a restore every month (deploy/restore-verify.sh).':
    'Një kopje rezervë që nuk është rikthyer kurrë nuk është kopje rezervë: provoni një rikthim çdo muaj (deploy/restore-verify.sh).',

  // E-mail delivery (System health, administrators).
  'E-mail delivery is not configured': 'Dërgimi i e-mailit nuk është konfiguruar',
  'Send a test e-mail': 'Dërgo një e-mail provë',
  'Sends one message to your own address, through the same queue and mail server as every e-mail of Pacient. Check that it arrives and that it is not in the spam folder.':
    'Dërgon një mesazh në adresën tuaj, përmes të njëjtës radhë dhe të njëjtit server poste si çdo e-mail i Pacient. Kontrolloni që të mbërrijë dhe që të mos jetë në dosjen spam.',
  'Test e-mail queued for {email}': 'E-maili provë u vendos në radhë për {email}',
  'It should arrive within a minute. If it does not, look below for the error, and check the SPF, DKIM and DMARC records of the sending domain.':
    'Duhet të mbërrijë brenda një minute. Nëse nuk mbërrin, shikoni gabimin më poshtë dhe kontrolloni regjistrat SPF, DKIM dhe DMARC të domenit dërgues.',
  'The server has no mail server (SMTP_URL), so the message waits in the queue with every other e-mail. Set it up as described in GO-LIVE.md, E-mail.':
    'Serveri nuk ka server poste (SMTP_URL), ndaj mesazhi pret në radhë bashkë me çdo e-mail tjetër. Konfigurojeni siç përshkruhet në GO-LIVE.md, E-mail.',
  'One test e-mail per minute. Wait a moment and try again.':
    'Një e-mail provë në minutë. Prisni pak dhe provoni përsëri.',
  'Recent failures': 'Dështimet e fundit',
  'Messages the mail server refused, newest first. Addresses are shortened and the contents are never shown.':
    'Mesazhet që serveri i postës refuzoi, më të rejat së pari. Adresat shkurtohen dhe përmbajtja nuk shfaqet kurrë.',
  '{count} e-mail given up in the last 24 hours': '{count} e-mail u braktis në 24 orët e fundit',
  '{count} e-mails given up in the last 24 hours':
    '{count} e-maile u braktisën në 24 orët e fundit',
  '{count} being retried': '{count} po riprovohen',
  'No failed e-mails': 'Asnjë e-mail i dështuar',
  'Recent e-mail failures': 'Dështimet e fundit të e-mailit',
  'Error from the mail server': 'Gabimi nga serveri i postës',
  Queued: 'Vendosur në radhë',
  Notification: 'Njoftim',
  'Test e-mail': 'E-mail provë',
  'Invoice or credit note': 'Faturë ose notë krediti',
  'Given up': 'U braktis',
  'Retrying ({attempts} of {max})': 'Po riprovohet ({attempts} nga {max})',
  'Next attempt {time}': 'Përpjekja e radhës {time}',

  // Operator alerts (platform overview).
  '{count} alert': '{count} sinjalizim',
  '{count} alerts': '{count} sinjalizime',
  '{count} critical alert': '{count} sinjalizim kritik',
  '{count} critical alerts': '{count} sinjalizime kritike',
  'Since {time}': 'Që nga {time}',
  'last checked {time}': 'kontrolluar së fundi {time}',
  'Open System health': 'Hap Gjendjen e sistemit',
  'Open the operator settings': 'Hap cilësimet e operatorit',
  'The background job {worker} has stopped': 'Puna në sfond {worker} është ndalur',
  'E-mails could not be delivered': 'E-mailet nuk u dërguan dot',
  'E-mails are waiting to be sent': 'E-mailet presin të dërgohen',
  'Text messages could not be delivered': 'Mesazhet SMS nuk u dërguan dot',
  'Text messages are waiting to be sent': 'Mesazhet SMS presin të dërgohen',
  'No recent database backup': 'Nuk ka kopje rezervë të fundit të bazës së të dhënave',
  'Invoices cannot be issued: operator settings are incomplete':
    'Faturat nuk mund të lëshohen: cilësimet e operatorit janë të paplota',
  'The HTTPS certificate expires soon': 'Certifikata HTTPS skadon së shpejti',
  'Pacient needs the operator’s attention': 'Pacient kërkon vëmendjen e operatorit',
};
