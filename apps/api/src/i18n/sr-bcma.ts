/** Serbian (Latin) translations of server messages for this module. */
export const srBcma: Record<string, string> = {
  'This is not a valid wristband of this system. Do not give – confirm the patient’s identity and print a new wristband.':
    'Ovo nije važeća identifikaciona narukvica ovog sistema. Ne davati – potvrdite identitet pacijenta i odštampajte novu narukvicu.',
  'Wrong patient: this wristband belongs to another patient. Do not give.':
    'Pogrešan pacijent: ova narukvica pripada drugom pacijentu. Ne davati.',
  'The wristband is too old. Confirm the patient’s identity and print a new one.':
    'Narukvica je previše stara. Potvrdite identitet pacijenta i odštampajte novu.',
  'This barcode is not in the medicines catalogue.': 'Ovaj bar-kod nije u katalogu lekova.',
  'Wrong medicine: the scanned pack ({scanned}) is not the prescribed medicine ({prescribed}). Do not give.':
    'Pogrešan lek: skenirano pakovanje ({scanned}) nije propisani lek ({prescribed}). Ne davati.',
  'Same medicine, different strength ({scanned}). Check the dose before giving.':
    'Isti lek, druga jačina ({scanned}). Proverite dozu pre davanja.',
  'Not due yet: last given {last}, next dose due {next}.':
    'Još nije vreme: poslednji put dato {last}, sledeća doza {next}.',
  'Already given {last}.': 'Već dato {last}.',
  'The as-needed limit is reached: {count} of {max} doses given in the last 24 hours.':
    'Dostignuto je ograničenje za davanje po potrebi: {count} od {max} doza u poslednja 24 sata.',
};
