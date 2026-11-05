/**
 * Albanian (sq) translations for disease registers, keyed by the English source text. Keep {placeholders}.
 */
export const registers: Record<string, string> = {
  // Registers
  Diabetes: 'Diabeti',
  Hypertension: 'Hipertensioni',
  Asthma: 'Astma',
  COPD: 'SPOK (sëmundja pulmonare obstruktive kronike)',
  'Chronic kidney disease': 'Sëmundja kronike e veshkave',
  'Heart failure': 'Insuficienca e zemrës',
  Register: 'Regjistri',
  'All registers': 'Të gjithë regjistrat',
  // Review items
  HbA1c: 'HbA1c',
  'Kidney function (creatinine / eGFR)': 'Funksioni i veshkave (kreatinina / eGFR)',
  'Urine albumin–creatinine ratio': 'Raporti albuminë–kreatininë në urinë',
  Cholesterol: 'Kolesteroli',
  'Weight / BMI': 'Pesha / ITM',
  'Foot examination': 'Ekzaminimi i këmbëve',
  'Eye (retinal) screening': 'Kontrolli i syve (retinës)',
  'Smoking status': 'Duhanpirja',
  'Influenza vaccination': 'Vaksinimi kundër gripit',
  'Inhaler technique checked': 'Kontrolli i teknikës së inhalatorit',
  'Written asthma action plan': 'Plani i shkruar i veprimit për astmën',
  Spirometry: 'Spirometria',
  Potassium: 'Kaliumi',
  // Results
  Abnormal: 'Jonormal',
  'Declined by the patient': 'Refuzuar nga pacienti',
  'Never smoked': 'Nuk ka pirë kurrë duhan',
  'Ex-smoker': 'Ish-duhanpirës',
  Smoker: 'Duhanpirës',
  Obstruction: 'Obstruksion',
  // States and targets
  'Up to date|review': 'Në rregull',
  'Due soon': 'Afati po afron',
  'Due|review': 'Për t’u bërë',
  'HbA1c at target': 'HbA1c brenda synimit',
  'Blood pressure at target': 'Tensioni brenda synimit',
  'Cholesterol at target': 'Kolesteroli brenda synimit',
  'HbA1c ≤ 7.5 % (58 mmol/mol)': 'HbA1c ≤ 7,5 % (58 mmol/mol)',
  'Below 140/90 mmHg (below 150/90 mmHg from age 80)':
    'Nën 140/90 mmHg (nën 150/90 mmHg nga mosha 80 vjeç)',
  'Total cholesterol < 5.0 mmol/L': 'Kolesteroli total < 5,0 mmol/L',
  'eGFR ≈ {value} mL/min/1.73 m²': 'eGFR ≈ {value} mL/min/1,73 m²',
  'BMI {value}': 'ITM {value}',
  'No recent value': 'Pa vlerë të fundit',
  'At target': 'Brenda synimit',
  'Above target': 'Mbi synimin',
  'Not at target: {target}': 'Jashtë synimit: {target}',
  // Recall list
  'Overdue reviews': 'Kontrollet me vonesë',
  'Overdue, due and due soon': 'Me vonesë, për t’u bërë dhe me afat që po afron',
  'Everything not up to date': 'Gjithçka që nuk është në rregull',
  'Search patient': 'Kërko pacientin',
  'Register members in my care': 'Pacientë në regjistra në kujdesin tim',
  'Patients to recall': 'Pacientë për t’u thirrur',
  'Overdue review items': 'Kontrolle me vonesë',
  'No reviews to recall': 'Asnjë kontroll për t’u thirrur',
  'Patients in your care whose register reviews are not up to date appear here.':
    'Këtu shfaqen pacientët në kujdesin tuaj, kontrollet e të cilëve nuk janë në rregull.',
  'Recall list': 'Lista e thirrjeve',
  'Review items': 'Kontrollet',
  'Due {date}': 'Afati {date}',
  // Indicators
  'Too few patients to show': 'Shumë pak pacientë për t’u shfaqur',
  suppressed: 'e fshehur',
  '{value} per 1 000 registered patients': '{value} për 1 000 pacientë të regjistruar',
  'Quality indicators for {register}': 'Treguesit e cilësisë për {register}',
  Indicator: 'Treguesi',
  'Share of the register': 'Pjesa e regjistrit',
  '{item} in the last 12 months': '{item} në 12 muajt e fundit',
  'Group by': 'Grupo sipas',
  'As of {date}. Counts below {threshold} are not shown to protect privacy.':
    'Gjendja më {date}. Numrat nën {threshold} nuk shfaqen për të mbrojtur privatësinë.',
  'Targets are placeholders until confirmed by the national clinical guidelines.':
    'Synimet janë të përkohshme derisa të konfirmohen nga udhëzuesit klinikë kombëtarë.',
  'By facility': 'Sipas institucionit',
  'By municipality': 'Sipas komunës',
  'Per 1 000': 'Për 1 000',
  'Patients in your care with chronic conditions whose regular reviews are due.':
    'Pacientët me sëmundje kronike në kujdesin tuaj që kanë kontrolle të rregullta për t’u bërë.',
  'Quality of chronic care at {facility} – counts only, no names.':
    'Cilësia e kujdesit për sëmundjet kronike në {facility} – vetëm numra, pa emra.',
  'National quality of chronic care – counts only, no names.':
    'Cilësia kombëtare e kujdesit për sëmundjet kronike – vetëm numra, pa emra.',
  // Chart tab
  'Leave empty for today': 'Lëreni bosh për sot',
  'Add to a register': 'Shto në një regjistër',
  'e.g. diagnosis confirmed by spirometry': 'p.sh. diagnoza u konfirmua me spirometri',
  'Add to register': 'Shto në regjistër',
  'Remove from the {register} register': 'Hiq nga regjistri: {register}',
  'e.g. diagnosis revised, moved to another family doctor':
    'p.sh. diagnoza u rishikua, kaloi te një mjek tjetër i familjes',
  'Remove from register': 'Hiq nga regjistri',
  'Register suggested by a diagnosis': 'Regjistër i sugjeruar nga një diagnozë',
  'Not in any chronic disease register': 'Nuk është në asnjë regjistër të sëmundjeve kronike',
  'Patients join automatically when a matching diagnosis is recorded (diabetes, hypertension, asthma, COPD, chronic kidney disease, heart failure).':
    'Pacientët shtohen automatikisht kur regjistrohet një diagnozë përkatëse (diabeti, hipertensioni, astma, SPOK, sëmundja kronike e veshkave, insuficienca e zemrës).',
  'Reviews up to date': 'Kontrollet në rregull',
  'In the register since {date} ({source}) · {facility}':
    'Në regjistër që nga {date} ({source}) · {facility}',
  'from a diagnosis': 'nga një diagnozë',
  'added by a doctor': 'shtuar nga mjeku',
  'Review items for {register}': 'Kontrollet për {register}',
  'Review item': 'Kontrolli',
  'Last result': 'Rezultati i fundit',
  Target: 'Synimi',
  Trend: 'Ecuria',
  'Every {months} months': 'Çdo {months} muaj',
  'Trend of {item}: {values}': 'Ecuria e {item}: {values}',
  Record: 'Regjistro',
  'Recorded review items': 'Kontrollet e regjistruara',
  'Earlier register memberships': 'Anëtarësime të mëparshme në regjistra',
  '{register}: {from} – {to}': '{register}: {from} – {to}',
  'Intervals and targets are placeholders until confirmed by the national clinical guidelines.':
    'Intervalet dhe synimet janë të përkohshme derisa të konfirmohen nga udhëzuesit klinikë kombëtarë.',
  // Server messages
  'The patient is already in this register (or the record is closed)':
    'Pacienti është tashmë në këtë regjistër (ose kartela është e mbyllur)',
  'Register enrolment not found': 'Anëtarësimi në regjistër nuk u gjet',
  'The patient has already left this register': 'Pacienti është hequr tashmë nga ky regjistër',
  'This review item is not recorded by hand for this register':
    'Ky kontroll nuk regjistrohet me dorë për këtë regjistër',
  'Choose one of the listed results': 'Zgjidhni një nga rezultatet e listuara',
  'The patient is not in this register': 'Pacienti nuk është në këtë regjistër',
  'The date cannot be in the future': 'Data nuk mund të jetë në të ardhmen',
  'The date is too far back': 'Data është shumë e hershme',
  // API documentation
  'Registers, review items, intervals and targets':
    'Regjistrat, kontrollet, intervalet dhe synimet',
  'A patient’s registers and review status': 'Regjistrat dhe gjendja e kontrolleve të një pacienti',
  'Add a patient to a register': 'Shto një pacient në regjistër',
  'Remove a patient from a register': 'Hiq një pacient nga regjistri',
  'Record a review item (foot check, eye screening …)': 'Regjistro një kontroll (këmbët, sytë …)',
  'Recall list: overdue reviews of patients in my care':
    'Lista e thirrjeve: kontrollet me vonesë të pacientëve në kujdesin tim',
  'Quality indicators (small cells suppressed)':
    'Treguesit e cilësisë (numrat e vegjël të fshehur)',
  'Chronic disease registers, recalls and quality indicators.':
    'Regjistrat e sëmundjeve kronike, thirrjet dhe treguesit e cilësisë.',
};
