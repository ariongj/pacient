/**
 * Albanian (sq) translations, keyed by the English source text. Keep {placeholders}.
 * Barcode-checked medication administration and patient wristbands.
 */
export const bcma: Record<string, string> = {
  // Bedside checks (MAR)
  'STOP – do not give': 'NDALO – mos e jepni',
  'This cannot be overridden. Check the patient and the medicine and scan again.':
    'Kjo nuk mund të anashkalohet. Kontrolloni pacientin dhe barin dhe skanoni përsëri.',
  'Check before giving': 'Kontrolloni para dhënies',
  Scanned: 'Skanuar',
  'Wristband only': 'Vetëm byzylyku',
  'Pack only': 'Vetëm pakoja',
  'Override reason': 'Arsyeja e anashkalimit',
  'Override: {reason}': 'Anashkalim: {reason}',
  'This is not a wristband code. Scan the patient’s wristband first.':
    'Ky nuk është kod byzylyku. Skanoni fillimisht byzylykun e pacientit.',
  'That was a wristband. Now scan the medicine pack.':
    'Ky ishte byzylyk. Tani skanoni pakon e barit.',
  Steps: 'Hapat',
  '1. Wristband': '1. Byzylyku',
  '(not scanned)': '(pa skanim)',
  '2. Medicine pack': '2. Pakoja e barit',
  '3. Check and confirm': '3. Kontrolli dhe konfirmimi',
  'Scan the patient’s wristband': 'Skanoni byzylykun e pacientit',
  'Wristband cannot be scanned': 'Byzylyku nuk mund të skanohet',
  'Scan the medicine pack': 'Skanoni pakon e barit',
  'Patient confirmed': 'Pacienti u konfirmua',
  'Pack cannot be scanned': 'Pakoja nuk mund të skanohet',
  'wristband matches this chart': 'byzylyku përputhet me këtë kartelë',
  'not scanned': 'pa skanim',
  'Last given {time}': 'Dhënë së fundi {time}',
  'Reason for giving without a complete check': 'Arsyeja e dhënies pa kontroll të plotë',
  'At least {count} characters. The reason is recorded in the audit log.':
    'Së paku {count} karaktere. Arsyeja ruhet në regjistrin e auditimit.',
  'Start again': 'Fillo nga e para',
  'Give with reason': 'Jep me arsye',
  'Confirm dose given': 'Konfirmo dhënien e dozës',
  'No doses given yet': 'Ende pa doza të dhëna',
  'Scanning {pct}%': 'Skanimi {pct}%',
  '{unit}, last {days} days: {scanned} of {given} doses given with both scans; {overridden} overrides':
    '{unit}, {days} ditët e fundit: {scanned} nga {given} doza të dhëna me të dy skanimet; {overridden} anashkalime',
  'Scan to give': 'Skano dhe jep',
  'Barcode check': 'Kontrolli me barkod',
  'Giving without scanning': 'Dhënie pa skanim',
  'Use “Scan to give” whenever possible. A dose recorded as given without scanning the wristband and the pack needs a reason, which is audited.':
    'Përdorni “Skano dhe jep” sa herë që është e mundur. Doza e regjistruar si e dhënë pa skanuar byzylykun dhe pakon kërkon arsye, e cila auditohet.',
  // Server messages shown in forms
  'A reason of at least 10 characters is required to give a dose without both scans or despite a warning':
    'Për të dhënë dozën pa të dy skanimet ose pavarësisht paralajmërimit nevojitet arsye me së paku 10 karaktere',
  'The wristband scan could not be confirmed': 'Skanimi i byzylykut nuk u konfirmua',
  'The medicine pack scan could not be confirmed': 'Skanimi i pakos së barit nuk u konfirmua',
  'Wristbands are printed only for admitted patients or patients in the emergency department':
    'Byzylykët printohen vetëm për pacientë të shtruar ose në emergjencë',
  'A scanned wristband must include the scanned code':
    'Byzylyku i skanuar duhet të ketë kodin e skanuar',
  'A scanned pack must include the scanned barcode':
    'Pakoja e skanuar duhet të ketë barkodin e skanuar',
  // Wristband
  'Print wristband': 'Printo byzylykun',
  'Temporary number (newborn)': 'Numër i përkohshëm (i porsalindur)',
  'Wristband preview': 'Pamja paraprake e byzylykut',
  'Wristband code': 'Kodi i byzylykut',
  DOB: 'Dat. lindjes',
  ALLERGY: 'ALERGJI',
  'Patient wristband': 'Byzylyku i pacientit',
  'A wristband identifies the patient at every dose, sample and transfusion.':
    'Byzylyku identifikon pacientin në çdo dozë, mostër dhe transfuzion.',
  'Wristband ready': 'Byzylyku është gati',
  'Printing creates a new signed code for this patient and is recorded in the audit log. Check the patient’s name and date of birth with the patient before putting the band on.':
    'Printimi krijon një kod të ri të nënshkruar për këtë pacient dhe ruhet në regjistrin e auditimit. Kontrolloni emrin dhe datëlindjen me pacientin para se t’ia vendosni byzylykun.',
  'Not confirmed by the laboratory – not printed': 'I pakonfirmuar nga laboratori – nuk printohet',
  Stay: 'Qëndrimi',
  'Allergies not recorded': 'Alergjitë nuk janë regjistruar',
  'Record the allergy status in the chart as soon as possible.':
    'Regjistroni statusin e alergjive në kartelë sa më shpejt.',
  'Print again': 'Printo përsëri',
  'Issue a new wristband': 'Lësho byzylyk të ri',
  'Create and print wristband': 'Krijo dhe printo byzylykun',
  '{name} has been admitted': '{name} u shtrua',
  'Print the wristband now – it is scanned before every dose.':
    'Printoni byzylykun tani – ai skanohet para çdo doze.',
  // Scanner
  'Code read': 'Kodi u lexua',
  'Camera on – hold the code in front of the camera': 'Kamera ndezur – mbajeni kodin para kamerës',
  'The camera is not available. Use the scanner or type the code.':
    'Kamera nuk është e disponueshme. Përdorni skanerin ose shkruani kodin.',
  'Scan or type, then Enter': 'Skanoni ose shkruani, pastaj Enter',
  'Enter code': 'Fut kodin',
  'Stop camera': 'Ndal kamerën',
  'Use camera': 'Përdor kamerën',
  'Handheld scanners type the code and press Enter for you.':
    'Skanerët e dorës e shkruajnë kodin dhe shtypin Enter vetë.',
  'Camera preview': 'Pamja e kamerës',
};
