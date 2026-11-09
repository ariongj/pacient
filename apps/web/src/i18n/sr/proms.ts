/**
 * Serbian Latin (sr) translations for patient-reported outcomes, keyed by the English source text. Keep {placeholders}.
 * Questionnaire items themselves are in the API (modules/proms/instruments.ts), as working translations.
 */
export const proms: Record<string, string> = {
  'PHQ-9 (depression)': 'PHQ-9 (depresija)',
  'GAD-7 (anxiety)': 'GAD-7 (anksioznost)',
  'WHO-5 (well-being)': 'WHO-5 (blagostanje)',
  'AUDIT-C (alcohol)': 'AUDIT-C (alkohol)',
  'Every week': 'Svake nedelje',
  'Every month': 'Svakog meseca',
  'Every three months': 'Svaka tri meseca',
  Minimal: 'Minimalno',
  'Moderately severe': 'Umereno teško',
  'Good well-being': 'Dobro blagostanje',
  'Low well-being': 'Nisko blagostanje',
  'Very low well-being': 'Veoma nisko blagostanje',
  'Lower risk': 'Niži rizik',
  'Increased risk': 'Povećan rizik',
  'Not due yet': 'Još nije na redu',
  'Questionnaires asked for': 'Zatraženi upitnici',
  'No questionnaires asked for': 'Nije zatražen nijedan upitnik',
  Questionnaire: 'Upitnik',
  'Next due': 'Sledeći rok',
  'Asked by': 'Zatražio/la',
  'Answers: {name}': 'Odgovori: {name}',
  'Result|questionnaire': 'Rezultat',
  'Safety flag': 'Bezbednosno upozorenje',
  Answers: 'Odgovori',
  'A change of {n} points or more is clinically meaningful.':
    'Promena od {n} poena ili više je klinički značajna.',
  'Earlier requests': 'Raniji zahtevi',
  '{from} to {to}': '{from} do {to}',
  'How often: {name}': 'Koliko često: {name}',
  'Stop asking': 'Prestani da tražiš',
  'Ask for a questionnaire': 'Zatraži upitnik',
  'First due (optional)': 'Prvi rok (opciono)',
  'Guardians never see this questionnaire or its answers; a young person answers it in their own portal account.':
    'Staratelji nikada ne vide ovaj upitnik niti odgovore; mlada osoba ga popunjava na svom nalogu na portalu.',
  'Ask the patient': 'Zatraži od pacijenta',
  'Stop asking for this questionnaire': 'Prestani da tražite ovaj upitnik',
  'Short questionnaires from your care team about how you are feeling.':
    'Kratki upitnici vašeg tima za negu o tome kako se osećate.',
  'Thank you – your answers have been sent': 'Hvala – vaši odgovori su poslati',
  '{name}: {score} – {severity}.': '{name}: {score} – {severity}.',
  'Some questionnaires are answered only by the young person in their own account, so you do not see them here.':
    'Neke upitnike popunjava samo mlada osoba na svom nalogu, pa ih ovde ne vidite.',
  'Questionnaires for you': 'Upitnici za vas',
  'No questionnaires at the moment': 'Trenutno nema upitnika',
  'When your care team asks you to fill in a questionnaire, it appears here.':
    'Kada vaš tim za negu zatraži da popunite upitnik, on se pojavljuje ovde.',
  'next: {date}': 'sledeći: {date}',
  'asked by {name}': 'zatražio/la {name}',
  'Answer now anyway': 'Ipak odgovorite sada',
  'Fill in the questionnaire': 'Popunite upitnik',
  'Your answers are read by your care team during working hours. If you feel unsafe or very unwell, call 112.':
    'Vaše odgovore čita vaš tim za negu tokom radnog vremena. Ako se ne osećate bezbedno ili vam je veoma loše, pozovite 112.',
  'My answers: {name}': 'Moji odgovori: {name}',
  'Albanian and Serbian wording is a working translation, to be replaced by validated translations before clinical use.':
    'Tekst na albanskom i srpskom je radni prevod koji pre kliničke upotrebe treba zameniti validiranim prevodima.',
  '{score} of {max}': '{score} od {max}',
  'First answer': 'Prvi odgovor',
  'no change': 'bez promene',
  'meaningful improvement': 'značajno poboljšanje',
  'meaningful worsening': 'značajno pogoršanje',
  'slightly better': 'malo bolje',
  'slightly worse': 'malo lošije',
  '{diff} since last time ({what})': '{diff} od prošlog puta ({what})',
  'You are not alone – please talk to someone now':
    'Niste sami – molimo vas, razgovarajte sa nekim sada',
  'Your answers say you have had thoughts of being better off dead or of hurting yourself. If you might act on these thoughts or are in danger, call 112 now.':
    'Vaši odgovori pokazuju da ste imali misli da bi vam bilo bolje da ste mrtvi ili da se povredite. Ako biste mogli da postupite po tim mislima ili ste u opasnosti, odmah pozovite 112.',
  'You can also call the mental health helpline: number to be confirmed by the Ministry of Health (placeholder in this demo).':
    'Možete pozvati i liniju za pomoć u oblasti mentalnog zdravlja: broj će potvrditi Ministarstvo zdravlja (privremeni podatak u ovoj demonstraciji).',
  'Your care team has been told and will contact you. Questionnaires are not watched around the clock, so do not wait for them if you need help now.':
    'Vaš tim za negu je obavešten i kontaktiraće vas. Upitnici se ne prate 24 sata dnevno, pa nemojte čekati ako vam je pomoć potrebna sada.',
  'Please talk to your doctor soon': 'Molimo vas, uskoro razgovarajte sa svojim lekarom',
  'Your answers suggest that you are having a hard time. Please contact your family doctor within the next few days. If you feel unsafe, call 112.':
    'Vaši odgovori ukazuju na to da vam je teško. Molimo vas, javite se svom izabranom lekaru u narednih nekoliko dana. Ako se ne osećate bezbedno, pozovite 112.',
  'Please choose an answer.': 'Molimo vas, izaberite odgovor.',
  'Please answer every question before sending.':
    'Molimo vas, odgovorite na svako pitanje pre slanja.',
  'Send my answers': 'Pošalji moje odgovore',
  '{name}: scores over time': '{name}: rezultati tokom vremena',
  'No answers yet.': 'Još nema odgovora.',
  'Safety question': 'Bezbednosno pitanje',
  'Review questionnaire answers': 'Pregledaj odgovore na upitnik',
  'Needs attention today': 'Zahteva pažnju danas',
  'Contact the patient today and follow the local protocol for suicide risk assessment before marking these answers as reviewed.':
    'Kontaktirajte pacijenta danas i sledite lokalni protokol za procenu rizika od samoubistva pre nego što ove odgovore označite kao pregledane.',
  'e.g. called the patient, appointment booked, safety plan agreed':
    'npr. pacijent je pozvan, zakazan je termin, dogovoren je bezbednosni plan',
  'How many patients answer the questionnaires their care team asks for.':
    'Koliko pacijenata odgovara na upitnike koje traži njihov tim za negu.',
  'Answers of patients in your care, those that need attention today first.':
    'Odgovori pacijenata o kojima brinete, prvo oni koji zahtevaju pažnju danas.',
  'Not reviewed yet': 'Još nepregledani',
  'Needing attention today': 'Koji zahtevaju pažnju danas',
  'All answers': 'Svi odgovori',
  'All questionnaires': 'Svi upitnici',
  'Answers with a safety flag (thoughts of self-harm or a severe depression score): contact the patient today and follow the local protocol for suicide risk assessment.':
    'Odgovori sa bezbednosnim upozorenjem (misli o samopovređivanju ili težak rezultat depresije): kontaktirajte pacijenta danas i sledite lokalni protokol za procenu rizika od samoubistva.',
  'Questionnaire answers of patients in your care appear here.':
    'Ovde se pojavljuju odgovori na upitnike pacijenata o kojima brinete.',
  'Questionnaire answers to review': 'Odgovori na upitnike za pregled',
  Answered: 'Odgovoreno',
  'Clinically meaningful': 'Klinički značajno',
  'Completion in the last 90 days': 'Popunjenost u poslednjih 90 dana',
  'Patients asked': 'Upitani pacijenti',
  'Answered at least once': 'Odgovorili bar jednom',
  Completion: 'Popunjenost',
  'Safety flags': 'Bezbednosna upozorenja',
  'Safety flags reviewed within 24 hours': 'Bezbednosna upozorenja pregledana u roku od 24 sata',
  'Patients asked: requests made at least 14 days ago and active in the period. Counts below {n} are hidden, as are counts from which a hidden one could be worked out. No names or scores are shown.':
    'Upitani pacijenti: zahtevi upućeni pre najmanje 14 dana i aktivni u periodu. Brojevi manji od {n} se skrivaju, kao i brojevi iz kojih bi se mogao izračunati skriveni broj. Imena i rezultati se ne prikazuju.',
  'This questionnaire is answered by the young person themselves':
    'Ovaj upitnik popunjava sama mlada osoba',
  'Your care team has not asked you to fill in this questionnaire':
    'Vaš tim za negu nije zatražio da popunite ovaj upitnik',
  'The answers are for a different questionnaire': 'Odgovori su za drugi upitnik',
  'This questionnaire is no longer requested': 'Ovaj upitnik se više ne traži',
  'This questionnaire is already requested for the patient':
    'Ovaj upitnik je već zatražen za pacijenta',
  'Questionnaire request not found': 'Zahtev za upitnik nije pronađen',
  'This questionnaire request has ended': 'Ovaj zahtev za upitnik je završen',
  'This questionnaire request has already ended': 'Ovaj zahtev za upitnik je već završen',
  'Questionnaire answers not found': 'Odgovori na upitnik nisu pronađeni',
  'These answers have already been reviewed': 'Ovi odgovori su već pregledani',
  'The first questionnaire must be due within a year':
    'Prvi upitnik mora biti na redu u roku od godinu dana',
  'Unknown questions in the answers': 'Nepoznata pitanja u odgovorima',
  'Please answer every question': 'Molimo vas, odgovorite na svako pitanje',
  'Some answers are not valid': 'Neki odgovori nisu važeći',
};
