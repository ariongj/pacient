/**
 * Serbian Latin (sr) translations for disease registers, keyed by the English source text. Keep {placeholders}.
 */
export const registers: Record<string, string> = {
  // Registers
  Diabetes: 'Dijabetes',
  Hypertension: 'Hipertenzija',
  Asthma: 'Astma',
  COPD: 'HOBP (hronična opstruktivna bolest pluća)',
  'Chronic kidney disease': 'Hronična bolest bubrega',
  'Heart failure': 'Srčana insuficijencija',
  Register: 'Registar',
  'All registers': 'Svi registri',
  // Review items
  HbA1c: 'HbA1c',
  'Kidney function (creatinine / eGFR)': 'Funkcija bubrega (kreatinin / eGFR)',
  'Urine albumin–creatinine ratio': 'Odnos albumin–kreatinin u urinu',
  Cholesterol: 'Holesterol',
  'Weight / BMI': 'Telesna masa / ITM',
  'Foot examination': 'Pregled stopala',
  'Eye (retinal) screening': 'Pregled očiju (mrežnjače)',
  'Smoking status': 'Pušački status',
  'Influenza vaccination': 'Vakcinacija protiv gripa',
  'Inhaler technique checked': 'Provera tehnike korišćenja inhalatora',
  'Written asthma action plan': 'Pisani plan postupanja kod astme',
  Spirometry: 'Spirometrija',
  Potassium: 'Kalijum',
  // Results
  Abnormal: 'Patološki',
  'Declined by the patient': 'Pacijent je odbio',
  'Never smoked': 'Nikad nije pušio/la',
  'Ex-smoker': 'Bivši pušač',
  Smoker: 'Pušač',
  Obstruction: 'Opstrukcija',
  // States and targets
  'Up to date|review': 'Ažurno',
  'Due soon': 'Rok se bliži',
  'Due|review': 'Treba uraditi',
  'HbA1c at target': 'HbA1c u ciljnom opsegu',
  'Blood pressure at target': 'Krvni pritisak u ciljnom opsegu',
  'Cholesterol at target': 'Holesterol u ciljnom opsegu',
  'HbA1c ≤ 7.5 % (58 mmol/mol)': 'HbA1c ≤ 7,5 % (58 mmol/mol)',
  'Below 140/90 mmHg (below 150/90 mmHg from age 80)':
    'Ispod 140/90 mmHg (ispod 150/90 mmHg od 80. godine)',
  'Total cholesterol < 5.0 mmol/L': 'Ukupni holesterol < 5,0 mmol/L',
  'eGFR ≈ {value} mL/min/1.73 m²': 'eGFR ≈ {value} mL/min/1,73 m²',
  'BMI {value}': 'ITM {value}',
  'No recent value': 'Nema skorašnje vrednosti',
  'At target': 'U ciljnom opsegu',
  'Above target': 'Iznad cilja',
  'Not at target: {target}': 'Van cilja: {target}',
  // Recall list
  'Overdue reviews': 'Kontrole koje kasne',
  'Overdue, due and due soon': 'Kasne, treba uraditi i rok se bliži',
  'Everything not up to date': 'Sve što nije ažurno',
  'Search patient': 'Pretraži pacijenta',
  'Register members in my care': 'Pacijenti u registrima kojima pružam negu',
  'Patients to recall': 'Pacijenti za poziv',
  'Overdue review items': 'Kontrole koje kasne',
  'No reviews to recall': 'Nema kontrola za poziv',
  'Patients in your care whose register reviews are not up to date appear here.':
    'Ovde se prikazuju pacijenti kojima pružate negu, a čije kontrole nisu ažurne.',
  'Recall list': 'Lista za pozivanje',
  'Review items': 'Kontrole',
  'Due {date}': 'Rok {date}',
  // Indicators
  'Too few patients to show': 'Premalo pacijenata za prikaz',
  suppressed: 'skriveno',
  '{value} per 1 000 registered patients': '{value} na 1 000 registrovanih pacijenata',
  'Quality indicators for {register}': 'Pokazatelji kvaliteta za {register}',
  Indicator: 'Pokazatelj',
  'Share of the register': 'Udeo u registru',
  '{item} in the last 12 months': '{item} u poslednjih 12 meseci',
  'Group by': 'Grupiši po',
  'As of {date}. Counts below {threshold} are not shown to protect privacy.':
    'Stanje na dan {date}. Brojevi manji od {threshold} se ne prikazuju radi zaštite privatnosti.',
  'Targets are placeholders until confirmed by the national clinical guidelines.':
    'Ciljevi su privremeni dok ih ne potvrde nacionalni klinički vodiči.',
  'By facility': 'Po ustanovi',
  'By municipality': 'Po opštinama',
  'Per 1 000': 'Na 1 000',
  'Patients in your care with chronic conditions whose regular reviews are due.':
    'Pacijenti sa hroničnim bolestima kojima pružate negu, a kojima predstoje redovne kontrole.',
  'Quality of chronic care at {facility} – counts only, no names.':
    'Kvalitet zbrinjavanja hroničnih bolesti u ustanovi {facility} – samo brojevi, bez imena.',
  'National quality of chronic care – counts only, no names.':
    'Nacionalni kvalitet zbrinjavanja hroničnih bolesti – samo brojevi, bez imena.',
  // Chart tab
  'Leave empty for today': 'Ostavite prazno za danas',
  'Add to a register': 'Dodaj u registar',
  'e.g. diagnosis confirmed by spirometry': 'npr. dijagnoza potvrđena spirometrijom',
  'Add to register': 'Dodaj u registar',
  'Remove from the {register} register': 'Ukloni iz registra: {register}',
  'e.g. diagnosis revised, moved to another family doctor':
    'npr. dijagnoza je revidirana, prešao/la kod drugog porodičnog lekara',
  'Remove from register': 'Ukloni iz registra',
  'Register suggested by a diagnosis': 'Registar predložen na osnovu dijagnoze',
  'Not in any chronic disease register': 'Nije ni u jednom registru hroničnih bolesti',
  'Patients join automatically when a matching diagnosis is recorded (diabetes, hypertension, asthma, COPD, chronic kidney disease, heart failure).':
    'Pacijenti se automatski dodaju kada se upiše odgovarajuća dijagnoza (dijabetes, hipertenzija, astma, HOBP, hronična bolest bubrega, srčana insuficijencija).',
  'Reviews up to date': 'Kontrole su ažurne',
  'In the register since {date} ({source}) · {facility}':
    'U registru od {date} ({source}) · {facility}',
  'from a diagnosis': 'na osnovu dijagnoze',
  'added by a doctor': 'dodao lekar',
  'Review items for {register}': 'Kontrole za {register}',
  'Review item': 'Kontrola',
  'Last result': 'Poslednji rezultat',
  Target: 'Cilj',
  Trend: 'Kretanje',
  'Every {months} months': 'Svakih {months} meseci',
  'Trend of {item}: {values}': 'Kretanje – {item}: {values}',
  Record: 'Upiši',
  'Recorded review items': 'Upisane kontrole',
  'Earlier register memberships': 'Ranija članstva u registrima',
  '{register}: {from} – {to}': '{register}: {from} – {to}',
  'Intervals and targets are placeholders until confirmed by the national clinical guidelines.':
    'Intervali i ciljevi su privremeni dok ih ne potvrde nacionalni klinički vodiči.',
  // Server messages
  'The patient is already in this register (or the record is closed)':
    'Pacijent je već u ovom registru (ili je karton zatvoren)',
  'Register enrolment not found': 'Članstvo u registru nije pronađeno',
  'The patient has already left this register': 'Pacijent je već uklonjen iz ovog registra',
  'This review item is not recorded by hand for this register':
    'Ova kontrola se ne upisuje ručno za ovaj registar',
  'Choose one of the listed results': 'Izaberite jedan od navedenih rezultata',
  'The patient is not in this register': 'Pacijent nije u ovom registru',
  'The date cannot be in the future': 'Datum ne može biti u budućnosti',
  'The date is too far back': 'Datum je predaleko u prošlosti',
  // API documentation
  'Registers, review items, intervals and targets': 'Registri, kontrole, intervali i ciljevi',
  'A patient’s registers and review status': 'Registri pacijenta i stanje kontrola',
  'Add a patient to a register': 'Dodaj pacijenta u registar',
  'Remove a patient from a register': 'Ukloni pacijenta iz registra',
  'Record a review item (foot check, eye screening …)': 'Upiši kontrolu (pregled stopala, očiju …)',
  'Recall list: overdue reviews of patients in my care':
    'Lista za pozivanje: kontrole koje kasne kod pacijenata kojima pružam negu',
  'Quality indicators (small cells suppressed)': 'Pokazatelji kvaliteta (mali brojevi skriveni)',
  'Chronic disease registers, recalls and quality indicators.':
    'Registri hroničnih bolesti, pozivanje i pokazatelji kvaliteta.',
};
