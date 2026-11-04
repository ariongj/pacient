/**
 * Albanian (sq) translations, keyed by the English source text. Placeholders in braces – {name} –
 * must be kept as they are. Missing entries fall back to English.
 */
export const merge: Record<string, string> = {
  // Page
  'Duplicate records': 'Kartela të dyfishta',
  'Find people registered more than once at your facility and merge their records into one.':
    'Gjeni personat e regjistruar më shumë se një herë në institucionin tuaj dhe bashkoni kartelat e tyre në një.',
  'Possible duplicates': 'Kartela të mundshme të dyfishta',
  'Records with the same date of birth and a matching or very similar name, phone or email. Nothing is merged automatically – always check identity documents first.':
    'Kartela me të njëjtën datë lindjeje dhe emër, telefon ose email të njëjtë ose shumë të ngjashëm. Asgjë nuk bashkohet automatikisht – gjithmonë kontrolloni fillimisht dokumentet e identitetit.',
  'No likely duplicates found': 'Nuk u gjet asnjë kartelë e mundshme e dyfishtë',
  'You can still compare any two records below.':
    'Megjithatë mund të krahasoni më poshtë çdo dy kartela.',
  'Possible duplicate': 'E mundshme e dyfishtë',
  Why: 'Pse',
  Actions: 'Veprimet',
  Compare: 'Krahaso',
  '{score}% match': 'Përputhje {score}%',
  'Registered {date}': 'Regjistruar më {date}',
  'Portal account': 'Llogari në portal',
  'National ID': 'Numri personal',
  'The merge is listed in the history below, where it can be undone if needed.':
    'Bashkimi shfaqet në historikun më poshtë, ku mund të zhbëhet nëse nevojitet.',

  // Reasons from the server
  'Same name and date of birth': 'Emri dhe data e lindjes të njëjta',
  'First and last name swapped': 'Emri dhe mbiemri të ndërruar',
  'Very similar name and same date of birth': 'Emër shumë i ngjashëm dhe datë lindjeje e njëjtë',
  'Same phone number': 'Numri i telefonit i njëjtë',
  'Same email address': 'Adresa e email-it e njëjtë',
  'Different sex recorded': 'Gjinia e regjistruar ndryshon',

  // Manual compare
  'Compare any two records': 'Krahasoni çdo dy kartela',
  'Not in the list above? Search for both records registered at your facility.':
    'Nuk është në listën më lart? Kërkoni të dyja kartelat e regjistruara në institucionin tuaj.',
  'First record': 'Kartela e parë',
  'Second record': 'Kartela e dytë',
  'Name or national ID': 'Emri ose numri personal',
  'No patients found': 'Nuk u gjet asnjë pacient',
  Select: 'Zgjidh',
  Change: 'Ndrysho',
  'Choose two different records': 'Zgjidhni dy kartela të ndryshme',

  // Compare & merge dialog
  'Compare and merge records': 'Krahaso dhe bashko kartelat',
  'Choose the record to keep – normally the one with the correct national ID. Only identity details and the number of entries are shown; clinical content stays with the care team.':
    'Zgjidhni kartelën që do të mbahet – zakonisht atë me numrin personal të saktë. Shfaqen vetëm të dhënat e identitetit dhe numri i shënimeve; përmbajtja klinike mbetet te ekipi i kujdesit.',
  'Both records have a portal account': 'Të dyja kartelat kanë llogari në portal',
  'Ask the patient which account they use and have the other one deactivated before merging.':
    'Pyesni pacientin cilën llogari përdor dhe kërkoni që tjetra të çaktivizohet para bashkimit.',
  'Comparison of the two records': 'Krahasimi i dy kartelave',
  Detail: 'Të dhëna',
  'Keep this record': 'Mbaje këtë kartelë',
  'Duplicate – will be closed': 'E dyfishtë – do të mbyllet',
  'Date of birth': 'Data e lindjes',
  Sex: 'Gjinia',
  Phone: 'Telefoni',
  Email: 'Email-i',
  Address: 'Adresa',
  Municipality: 'Komuna',
  'Emergency contact': 'Kontakti për emergjenca',
  'Blood type': 'Grupi i gjakut',
  Guardians: 'Kujdestarët',
  Registered: 'Regjistruar',
  Yes: 'Po',
  No: 'Jo',
  'Entries in total': 'Shënime gjithsej',
  'Details that differ – which value should the kept record have?':
    'Të dhënat që ndryshojnë – cilën vlerë duhet të ketë kartela që mbahet?',
  '(empty)': '(bosh)',
  'Reason for the merge': 'Arsyeja e bashkimit',
  'For the audit trail, e.g. “Same person – surname misspelt at walk-in registration, confirmed with ID card”.':
    'Për regjistrin e auditimit, p.sh. “I njëjti person – mbiemri i shkruar gabim gjatë regjistrimit pa termin, konfirmuar me letërnjoftim”.',
  Cancel: 'Anulo',
  'Review merge': 'Shqyrto bashkimin',
  Back: 'Kthehu',
  'Merge records': 'Bashko kartelat',
  'Please confirm the merge': 'Ju lutemi konfirmoni bashkimin',
  '{count} entry will move from {from} to {to}.': '{count} shënim do të kalojë nga {from} te {to}.',
  '{count} entries will move from {from} to {to}.':
    '{count} shënime do të kalojnë nga {from} te {to}.',
  'The record {nationalId} will be closed and marked as merged.':
    'Kartela {nationalId} do të mbyllet dhe do të shënohet si e bashkuar.',
  'Taken from the duplicate: {fields}.': 'Merren nga kartela e dyfishtë: {fields}.',
  'The patient’s portal account will move to the surviving record.':
    'Llogaria e pacientit në portal do të kalojë te kartela që mbahet.',
  'The doctors on the care team are notified.': 'Mjekët e ekipit të kujdesit njoftohen.',
  'You can undo this merge later from the merge history.':
    'Këtë bashkim mund ta zhbëni më vonë nga historiku i bashkimeve.',
  'Records merged: {count} entry moved to {name}.':
    'Kartelat u bashkuan: {count} shënim kaloi te {name}.',
  'Records merged: {count} entries moved to {name}.':
    'Kartelat u bashkuan: {count} shënime kaluan te {name}.',

  // Section labels (record counts)
  Allergies: 'Alergjitë',
  Appointments: 'Terminet',
  'Care team': 'Ekipi i kujdesit',
  'Care tasks': 'Detyrat e kujdesit',
  'Consent records': 'Pëlqimet',
  'Correction requests': 'Kërkesat për korrigjim',
  Diagnoses: 'Diagnozat',
  'Emergency access grants': 'Qasjet emergjente',
  'Note addenda': 'Shtojcat e shënimeve',
  Visits: 'Vizitat',
  Vaccinations: 'Vaksinimet',
  'Laboratory messages': 'Mesazhet e laboratorit',
  'Laboratory orders': 'Kërkesat për analiza',
  'Laboratory results': 'Rezultatet e analizave',
  'Medication administrations': 'Dhëniet e barnave',
  'Message threads': 'Bisedat',
  Documents: 'Dokumentet',
  Prescriptions: 'Recetat',
  Referrals: 'Referimet',
  'Vital signs': 'Shenjat vitale',

  // History
  'Merge history': 'Historiku i bashkimeve',
  'No merges yet': 'Ende nuk ka bashkime',
  'Kept record': 'Kartela e mbajtur',
  'Merged duplicate': 'Kartela e dyfishtë e bashkuar',
  Reason: 'Arsyeja',
  When: 'Kur',
  '{count} entry moved': '{count} shënim u zhvendos',
  '{count} entries moved': '{count} shënime u zhvendosën',
  'portal account moved': 'llogaria në portal u zhvendos',
  'Undone {date}': 'Zhbërë më {date}',
  'Undo merge': 'Zhbëje bashkimin',
  'The {count} entries that were moved go back to {name} ({nationalId}) and that record is reopened. Entries added since the merge stay with {survivor}.':
    '{count} shënimet që u zhvendosën kthehen te {name} ({nationalId}) dhe ajo kartelë rihapet. Shënimet e shtuara pas bashkimit mbeten te {survivor}.',
  'Reason for undoing the merge': 'Arsyeja e zhbërjes së bashkimit',

  // Server messages
  'Both records have a portal account. Deactivate the account the patient no longer uses, then merge.':
    'Të dyja kartelat kanë llogari në portal. Çaktivizoni llogarinë që pacienti nuk e përdor më, pastaj bashkojini.',
  'One of these records has already been merged': 'Njëra nga këto kartela është bashkuar tashmë',
  'Both records must be registered at your facility':
    'Të dyja kartelat duhet të jenë të regjistruara në institucionin tuaj',
  'Only records registered at your facility can be compared':
    'Mund të krahasohen vetëm kartelat e regjistruara në institucionin tuaj',
  'This merge has already been undone': 'Ky bashkim është zhbërë tashmë',
  'The records changed since the merge': 'Kartelat kanë ndryshuar pas bashkimit',
  'This record was merged into another record. Open the surviving record instead.':
    'Kjo kartelë është bashkuar me një kartelë tjetër. Hapni kartelën që është mbajtur.',
  'Merge not found': 'Bashkimi nuk u gjet',
  'Hospital stays': 'Shtrimet në spital',
  'Emergency visits': 'Vizitat në urgjencë',
  Imaging: 'Imazheria',
  'Medication safety alerts': 'Alarmet e sigurisë së barnave',
  'Blood group results': 'Rezultatet e grupit të gjakut',
  'Transfusion requests': 'Kërkesat për transfuzion',
  Transfusions: 'Transfuzionet',
  'Diet orders': 'Urdhrat e dietës',
  'Nutrition screenings': 'Vlerësimet e ushqyerjes',
  Insurance: 'Sigurimi',
  Charges: 'Pagesat e shërbimeve',
  Payments: 'Pagesat',
  'Early warning scores': 'Pikët e paralajmërimit të hershëm',
  'Notifiable disease reports': 'Raportet e sëmundjeve ngjitëse',
};
