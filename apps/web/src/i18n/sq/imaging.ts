/**
 * Albanian (sq) translations, keyed by the English source text. Keep {placeholders}.
 */
export const imaging: Record<string, string> = {
  // Modalities and statuses
  'X-ray': 'Radiografi',
  CT: 'CT',
  MRI: 'MRI',
  Ultrasound: 'Ekografi',
  Mammography: 'Mamografi',
  Fluoroscopy: 'Fluoroskopi',
  Scheduled: 'E planifikuar',
  Performed: 'E kryer',
  Reported: 'Raportuar',
  Modality: 'Modaliteti',
  'All modalities': 'Të gjitha modalitetet',
  '{modality} · {bodyPart}': '{modality} · {bodyPart}',

  // Body-part presets
  'Chest (PA and lateral)': 'Toraksi (PA dhe lateral)',
  Abdomen: 'Abdomeni',
  'Spine – lumbar': 'Shtylla kurrizore – lumbale',
  'Pelvis and hips': 'Legeni dhe ijet',
  Knee: 'Gjuri',
  'Hand and wrist': 'Dora dhe kyçi i dorës',
  'Ankle and foot': 'Kyçi i këmbës dhe shputa',
  'Head (without contrast)': 'Koka (pa kontrast)',
  'Chest (CT pulmonary angiography)': 'Toraksi (angiografi pulmonare me CT)',
  'Abdomen and pelvis': 'Abdomeni dhe legeni',
  'Spine – cervical': 'Shtylla kurrizore – cervikale',
  Sinuses: 'Sinuset',
  Brain: 'Truri',
  Shoulder: 'Supi',
  Pelvis: 'Legeni',
  Thyroid: 'Tiroidja',
  'Kidneys and bladder': 'Veshkat dhe fshikëza e urinës',
  Obstetric: 'Obstetrike',
  'Leg veins (Doppler)': 'Venat e këmbëve (Doppler)',
  'Both breasts (screening)': 'Të dy gjinjtë (depistim)',
  'Diagnostic mammography': 'Mamografi diagnostike',
  'Barium swallow': 'Gëlltitje me barium',
  'Micturating cystourethrography': 'Cistouretrografi miksionale',

  // Safety screening
  'Pregnancy: {answer}': 'Shtatzënia: {answer}',
  'With contrast': 'Me kontrast',
  'Without contrast': 'Pa kontrast',
  'Contrast allergy: {answer}': 'Alergji ndaj kontrastit: {answer}',
  'Reduced kidney function: {answer}': 'Funksion i ulët i veshkave: {answer}',
  'Implant/pacemaker: {note}': 'Implant/stimulues kardiak: {note}',
  'No implants or pacemaker': 'Pa implante apo stimulues kardiak',
  'Safety screening': 'Kontrolli i sigurisë',
  'Could the patient be pregnant?': 'A mund të jetë pacientja shtatzënë?',
  'Not asked': 'Nuk është pyetur',
  'Required for examinations with radiation in women aged 12–55.':
    'E detyrueshme për ekzaminimet me rrezatim te gratë 12–55 vjeç.',
  'Contrast medium requested': 'Kërkohet lëndë kontrasti',
  'Known contrast allergy?': 'Alergji e njohur ndaj kontrastit?',
  Choose: 'Zgjidhni',
  'Reduced kidney function?': 'Funksion i ulët i veshkave?',
  'Pacemaker, implant or metal in the body?': 'Stimulues kardiak, implant apo metal në trup?',
  'Describe the implant': 'Përshkruani implantin',
  'Type and model if known, so radiology can check MRI safety.':
    'Lloji dhe modeli nëse dihen, që radiologjia të kontrollojë sigurinë për MRI.',
  'Other safety information': 'Informacione të tjera për sigurinë',

  // Chart tab and order dialog
  'Order imaging': 'Kërko imazheri',
  'Requests go to the radiology unit of your facility. A signed report cannot be changed; acknowledge it, then release it to the patient.':
    'Kërkesat shkojnë te njësia e radiologjisë së institucionit tuaj. Një raport i nënshkruar nuk mund të ndryshohet; konfirmoni leximin, pastaj ndajeni me pacientin.',
  'No imaging examinations': 'Nuk ka ekzaminime imazherie',
  'Imaging examinations': 'Ekzaminimet e imazherisë',
  Examination: 'Ekzaminimi',
  'Critical finding': 'Gjetje kritike',
  'Full report': 'Raporti i plotë',
  'Awaiting report': 'Në pritje të raportit',
  'Accession number': 'Numri i ekzaminimit',
  'Clinical question': 'Pyetja klinike',
  'Reported by': 'Raportuar nga',
  Impression: 'Përfundimi',
  Findings: 'Gjetjet',
  'Cancel imaging request': 'Anuloni kërkesën për imazheri',
  'Cancel request': 'Anulo kërkesën',
  'Body part / examination': 'Pjesa e trupit / ekzaminimi',
  'Choose a common examination or type your own.':
    'Zgjidhni një ekzaminim të zakonshëm ose shkruani tuajin.',
  'What should radiology answer? Include relevant history.':
    'Çfarë duhet të përgjigjet radiologjia? Përfshini anamnezën përkatëse.',

  // Radiology worklist
  'Radiology worklist': 'Lista e punës së radiologjisë',
  'For the radiology unit': 'Për njësinë e radiologjisë',
  'The worklist is available to radiologists and radiographers assigned to the radiology unit. Order imaging from the patient’s chart (Imaging tab).':
    'Lista e punës është e qasshme për radiologët dhe teknikët e radiologjisë të caktuar në njësinë e radiologjisë. Imazherinë kërkojeni nga kartela e pacientit (skeda Imazheria).',
  'Examinations requested at your facility, most urgent first.':
    'Ekzaminimet e kërkuara në institucionin tuaj, më urgjentet së pari.',
  'STAT open': 'STAT të hapura',
  'Open and reported today': 'Të hapura dhe të raportuara sot',
  'No examinations in the queue': 'Nuk ka ekzaminime në radhë',
  'Performed by {name}': 'Kryer nga {name}',
  'Mark performed': 'Shëno si të kryer',
  Reschedule: 'Riplanifiko',
  'Write report': 'Shkruaj raportin',
  'Waiting for the radiologist': 'Në pritje të radiologut',
  'Schedule examination': 'Planifikoni ekzaminimin',
  'Sign the report?': 'Ta nënshkruani raportin?',
  'The report will be signed and cannot be changed. The ordering doctor (and their cover) will be alerted immediately about a critical finding.':
    'Raporti do të nënshkruhet dhe nuk mund të ndryshohet. Mjeku që e kërkoi (dhe zëvendësuesi i tij) do të njoftohen menjëherë për gjetjen kritike.',
  'The report will be signed and cannot be changed. The ordering doctor will be notified.':
    'Raporti do të nënshkruhet dhe nuk mund të ndryshohet. Mjeku që e kërkoi do të njoftohet.',
  'Sign report': 'Nënshkruaj raportin',
  'The conclusion the ordering doctor and the patient read first.':
    'Përfundimi që mjeku dhe pacienti lexojnë së pari.',
  'Critical finding – alert the ordering doctor now': 'Gjetje kritike – njofto menjëherë mjekun',
  'Review and sign': 'Shqyrto dhe nënshkruaj',

  // Patient portal
  'X-ray, CT, MRI and ultrasound reports': 'Raportet e radiografisë, CT-së, MRI-së dhe ekografisë',
  'Reports appear here after your doctor has reviewed them. Medical terms can sound worrying out of context – your doctor will explain what the result means for you.':
    'Raportet shfaqen këtu pasi mjeku juaj t’i ketë shqyrtuar. Termat mjekësorë mund të tingëllojnë shqetësues jashtë kontekstit – mjeku juaj do t’ju shpjegojë çfarë do të thotë rezultati për ju.',
  'No imaging reports yet': 'Ende nuk ka raporte imazherie',
  'Examination on {date}': 'Ekzaminimi më {date}',
  'Requested by {name}': 'Kërkuar nga {name}',
  Conclusion: 'Përfundimi',
  'Reported by {name} on {date}': 'Raportuar nga {name} më {date}',

  // Doctor worklist
  'Imaging reports to review': 'Raporte imazherie për shqyrtim',
  'Covering for {name}': 'Në zëvendësim të {name}',

  // Server messages shown in the interface
  'Pregnancy status is required for this examination (patient aged 12–55)':
    'Statusi i shtatzënisë është i detyrueshëm për këtë ekzaminim (paciente 12–55 vjeç)',
  'State whether contrast is requested': 'Tregoni nëse kërkohet kontrast',
  'Contrast requires answers on contrast allergy and kidney function':
    'Kontrasti kërkon përgjigje për alergjinë ndaj kontrastit dhe funksionin e veshkave',
  'MRI requires implant and pacemaker screening':
    'MRI kërkon kontroll për implante dhe stimulues kardiak',
  'Describe the implant or pacemaker so radiology can check MRI safety':
    'Përshkruani implantin ose stimuluesin kardiak që radiologjia të kontrollojë sigurinë për MRI',
  'The stay does not belong to this patient': 'Ky shtrim nuk i përket këtij pacienti',
  'The emergency visit does not belong to this patient':
    'Kjo vizitë në emergjencë nuk i përket këtij pacienti',
  'Imaging order not found': 'Kërkesa për imazheri nuk u gjet',
  'The radiology worklist is for staff of the radiology unit':
    'Lista e punës së radiologjisë është për stafin e njësisë së radiologjisë',
  'Only radiology staff schedule examinations': 'Vetëm stafi i radiologjisë planifikon ekzaminimet',
  'Only ordered examinations can be scheduled': 'Vetëm ekzaminimet e kërkuara mund të planifikohen',
  'Only radiology staff perform examinations': 'Vetëm stafi i radiologjisë kryen ekzaminimet',
  'This examination cannot be marked as performed': 'Ky ekzaminim nuk mund të shënohet si i kryer',
  'Only radiologists of the radiology unit sign reports':
    'Vetëm radiologët e njësisë së radiologjisë nënshkruajnë raportet',
  'Only performed examinations can be reported': 'Vetëm ekzaminimet e kryera mund të raportohen',
  'Only reported examinations can be acknowledged':
    'Vetëm ekzaminimet e raportuara mund të konfirmohen',
  'Report already acknowledged': 'Leximi i raportit është konfirmuar tashmë',
  'Acknowledge the report before releasing it':
    'Konfirmoni leximin e raportit para se ta ndani me pacientin',
  'Report already released': 'Raporti është ndarë tashmë me pacientin',
  'The examination has already been performed': 'Ekzaminimi është kryer tashmë',
};
