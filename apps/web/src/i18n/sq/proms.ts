/**
 * Albanian (sq) translations for patient-reported outcomes, keyed by the English source text. Keep {placeholders}.
 * Questionnaire items themselves are in the API (modules/proms/instruments.ts), as working translations.
 */
export const proms: Record<string, string> = {
  'PHQ-9 (depression)': 'PHQ-9 (depresioni)',
  'GAD-7 (anxiety)': 'GAD-7 (ankthi)',
  'WHO-5 (well-being)': 'WHO-5 (mirëqenia)',
  'AUDIT-C (alcohol)': 'AUDIT-C (alkooli)',
  'Every week': 'Çdo javë',
  'Every month': 'Çdo muaj',
  'Every three months': 'Çdo tre muaj',
  Minimal: 'Minimal',
  'Moderately severe': 'Mesatarisht i rëndë',
  'Good well-being': 'Mirëqenie e mirë',
  'Low well-being': 'Mirëqenie e ulët',
  'Very low well-being': 'Mirëqenie shumë e ulët',
  'Lower risk': 'Rrezik më i ulët',
  'Increased risk': 'Rrezik i shtuar',
  'Not due yet': 'Ende jo në afat',
  'Questionnaires asked for': 'Pyetësorët e kërkuar',
  'No questionnaires asked for': 'Nuk është kërkuar asnjë pyetësor',
  Questionnaire: 'Pyetësori',
  'Next due': 'Afati i radhës',
  'Asked by': 'Kërkuar nga',
  'Answers: {name}': 'Përgjigjet: {name}',
  'Result|questionnaire': 'Rezultati',
  'Safety flag': 'Shenjë sigurie',
  Answers: 'Përgjigjet',
  'A change of {n} points or more is clinically meaningful.':
    'Një ndryshim prej {n} pikësh ose më shumë është klinikisht i rëndësishëm.',
  'Earlier requests': 'Kërkesat e mëparshme',
  '{from} to {to}': '{from} deri {to}',
  'How often: {name}': 'Sa shpesh: {name}',
  'Stop asking': 'Ndalo kërkesën',
  'Ask for a questionnaire': 'Kërko një pyetësor',
  'First due (optional)': 'Afati i parë (opsional)',
  'Guardians never see this questionnaire or its answers; a young person answers it in their own portal account.':
    'Kujdestarët nuk e shohin kurrë këtë pyetësor ose përgjigjet e tij; i riu ose e reja e plotëson në llogarinë e vet në portal.',
  'Ask the patient': 'Kërkoji pacientit',
  'Stop asking for this questionnaire': 'Ndalo kërkesën për këtë pyetësor',
  'Short questionnaires from your care team about how you are feeling.':
    'Pyetësorë të shkurtër nga ekipi juaj i kujdesit për mënyrën si ndiheni.',
  'Thank you – your answers have been sent': 'Faleminderit – përgjigjet tuaja u dërguan',
  '{name}: {score} – {severity}.': '{name}: {score} – {severity}.',
  'Some questionnaires are answered only by the young person in their own account, so you do not see them here.':
    'Disa pyetësorë i plotëson vetëm i riu ose e reja në llogarinë e vet, prandaj nuk i shihni këtu.',
  'Questionnaires for you': 'Pyetësorë për ju',
  'No questionnaires at the moment': 'Për momentin nuk ka pyetësorë',
  'When your care team asks you to fill in a questionnaire, it appears here.':
    'Kur ekipi juaj i kujdesit ju kërkon të plotësoni një pyetësor, ai shfaqet këtu.',
  'next: {date}': 'i radhës: {date}',
  'asked by {name}': 'kërkuar nga {name}',
  'Answer now anyway': 'Përgjigjuni tani gjithsesi',
  'Fill in the questionnaire': 'Plotësoni pyetësorin',
  'Your answers are read by your care team during working hours. If you feel unsafe or very unwell, call 112.':
    'Përgjigjet tuaja i lexon ekipi juaj i kujdesit gjatë orarit të punës. Nëse nuk ndiheni të sigurt ose ndiheni shumë keq, telefononi 112.',
  'My answers: {name}': 'Përgjigjet e mia: {name}',
  'Albanian and Serbian wording is a working translation, to be replaced by validated translations before clinical use.':
    'Teksti shqip dhe serbisht është përkthim pune, që duhet zëvendësuar me përkthime të validuara para përdorimit klinik.',
  '{score} of {max}': '{score} nga {max}',
  'First answer': 'Përgjigja e parë',
  'no change': 'pa ndryshim',
  'meaningful improvement': 'përmirësim i rëndësishëm',
  'meaningful worsening': 'përkeqësim i rëndësishëm',
  'slightly better': 'pak më mirë',
  'slightly worse': 'pak më keq',
  '{diff} since last time ({what})': '{diff} që nga herë e fundit ({what})',
  'You are not alone – please talk to someone now':
    'Nuk jeni vetëm – ju lutemi flisni me dikë tani',
  'Your answers say you have had thoughts of being better off dead or of hurting yourself. If you might act on these thoughts or are in danger, call 112 now.':
    'Përgjigjet tuaja tregojnë se keni pasur mendime se do të ishte më mirë të ishit të vdekur ose për ta lënduar veten. Nëse mund të veproni sipas këtyre mendimeve ose jeni në rrezik, telefononi 112 tani.',
  'You can also call the mental health helpline: number to be confirmed by the Ministry of Health (placeholder in this demo).':
    'Mund të telefononi edhe linjën ndihmëse për shëndetin mendor: numri do të konfirmohet nga Ministria e Shëndetësisë (vend i rezervuar në këtë demonstrim).',
  'Your care team has been told and will contact you. Questionnaires are not watched around the clock, so do not wait for them if you need help now.':
    'Ekipi juaj i kujdesit është njoftuar dhe do t’ju kontaktojë. Pyetësorët nuk ndiqen gjatë gjithë kohës, prandaj mos prisni nëse keni nevojë për ndihmë tani.',
  'Please talk to your doctor soon': 'Ju lutemi flisni së shpejti me mjekun tuaj',
  'Your answers suggest that you are having a hard time. Please contact your family doctor within the next few days. If you feel unsafe, call 112.':
    'Përgjigjet tuaja tregojnë se po kaloni një periudhë të vështirë. Ju lutemi kontaktoni mjekun e familjes brenda ditëve në vijim. Nëse nuk ndiheni të sigurt, telefononi 112.',
  'Please choose an answer.': 'Ju lutemi zgjidhni një përgjigje.',
  'Please answer every question before sending.':
    'Ju lutemi përgjigjuni çdo pyetjeje para se ta dërgoni.',
  'Send my answers': 'Dërgo përgjigjet e mia',
  '{name}: scores over time': '{name}: pikët me kalimin e kohës',
  'No answers yet.': 'Ende nuk ka përgjigje.',
  'Safety question': 'Pyetje sigurie',
  'Review questionnaire answers': 'Shqyrto përgjigjet e pyetësorit',
  'Needs attention today': 'Kërkon vëmendje sot',
  'Contact the patient today and follow the local protocol for suicide risk assessment before marking these answers as reviewed.':
    'Kontaktoni pacientin sot dhe ndiqni protokollin lokal për vlerësimin e rrezikut për vetëvrasje para se t’i shënoni këto përgjigje si të shqyrtuara.',
  'e.g. called the patient, appointment booked, safety plan agreed':
    'p.sh. u telefonua pacienti, u caktua takim, u ra dakord për planin e sigurisë',
  'How many patients answer the questionnaires their care team asks for.':
    'Sa pacientë u përgjigjen pyetësorëve që u kërkon ekipi i kujdesit.',
  'Answers of patients in your care, those that need attention today first.':
    'Përgjigjet e pacientëve në kujdesin tuaj, së pari ato që kërkojnë vëmendje sot.',
  'Not reviewed yet': 'Ende të pashqyrtuara',
  'Needing attention today': 'Që kërkojnë vëmendje sot',
  'All answers': 'Të gjitha përgjigjet',
  'All questionnaires': 'Të gjithë pyetësorët',
  'Answers with a safety flag (thoughts of self-harm or a severe depression score): contact the patient today and follow the local protocol for suicide risk assessment.':
    'Përgjigjet me shenjë sigurie (mendime për vetëlëndim ose pikë të rënda depresioni): kontaktoni pacientin sot dhe ndiqni protokollin lokal për vlerësimin e rrezikut për vetëvrasje.',
  'Questionnaire answers of patients in your care appear here.':
    'Këtu shfaqen përgjigjet e pyetësorëve të pacientëve në kujdesin tuaj.',
  'Questionnaire answers to review': 'Përgjigjet e pyetësorëve për t’u shqyrtuar',
  Answered: 'Përgjigjur më',
  'Clinically meaningful': 'Klinikisht i rëndësishëm',
  'Completion in the last 90 days': 'Plotësimi në 90 ditët e fundit',
  'Patients asked': 'Pacientë të pyetur',
  'Answered at least once': 'U përgjigjën të paktën një herë',
  Completion: 'Plotësimi',
  'Safety flags': 'Shenjat e sigurisë',
  'Safety flags reviewed within 24 hours': 'Shenjat e sigurisë të shqyrtuara brenda 24 orësh',
  'Patients asked: requests made at least 14 days ago and active in the period. Counts below {n} are hidden, as are counts from which a hidden one could be worked out. No names or scores are shown.':
    'Pacientë të pyetur: kërkesa të bëra të paktën 14 ditë më parë dhe aktive gjatë periudhës. Numrat nën {n} fshihen, si edhe numrat nga të cilët mund të nxirret një numër i fshehur. Nuk shfaqen emra ose pikë.',
  'This questionnaire is answered by the young person themselves':
    'Këtë pyetësor e plotëson vetë i riu ose e reja',
  'Your care team has not asked you to fill in this questionnaire':
    'Ekipi juaj i kujdesit nuk ju ka kërkuar ta plotësoni këtë pyetësor',
  'The answers are for a different questionnaire': 'Përgjigjet janë për një pyetësor tjetër',
  'This questionnaire is no longer requested': 'Ky pyetësor nuk kërkohet më',
  'This questionnaire is already requested for the patient':
    'Ky pyetësor është kërkuar tashmë për pacientin',
  'Questionnaire request not found': 'Kërkesa për pyetësor nuk u gjet',
  'This questionnaire request has ended': 'Kjo kërkesë për pyetësor ka përfunduar',
  'This questionnaire request has already ended': 'Kjo kërkesë për pyetësor ka përfunduar tashmë',
  'Questionnaire answers not found': 'Përgjigjet e pyetësorit nuk u gjetën',
  'These answers have already been reviewed': 'Këto përgjigje janë shqyrtuar tashmë',
  'The first questionnaire must be due within a year':
    'Pyetësori i parë duhet të jetë në afat brenda një viti',
  'Unknown questions in the answers': 'Pyetje të panjohura në përgjigje',
  'Please answer every question': 'Ju lutemi përgjigjuni çdo pyetjeje',
  'Some answers are not valid': 'Disa përgjigje nuk janë të vlefshme',
};
