/**
 * Serbian Latin (sr) translations for the patient pathway (next steps between registration, visit, orders and
 * follow-up), keyed by the English source text. Keep {placeholders}.
 */
export const journey: Record<string, string> = {
  'Open chart of {name}': 'Otvori karton pacijenta {name}',
  Medicines: 'Lekovi',
  'Tests and imaging': 'Analize i snimanje',
  'Record and access': 'Karton i pristup',
  'Record areas': 'Oblasti kartona',
  'The patient is registered at your facility. The next step is an appointment.':
    'Pacijent je registrovan u vašoj ustanovi. Sledeći korak je termin.',
  'The patient is registered at your facility.': 'Pacijent se registruje u vašoj ustanovi.',
  'Specimen taken {time}': 'Uzorak uzet {time}',
  'Specimen taken for {test}': 'Uzorak uzet za {test}',
  'Only laboratory staff or the care team can record the specimen':
    'Samo osoblje laboratorije ili tim za negu može da evidentira uzorak',
  'Medicine catalogue': 'Katalog lekova',
  'The national list of medicines that can be prescribed, stocked and scanned at the bedside.':
    'Nacionalna lista lekova koji se mogu propisati, držati na zalihama i skenirati uz krevet.',
  'Add medicine': 'Dodaj lek',
  'Also show medicines no longer in use': 'Prikaži i lekove koji se više ne koriste',
  'No medicines found': 'Nije pronađen nijedan lek',
  'Search to see more.': 'Pretražite da vidite više.',
  'ATC code': 'ATC šifra',
  'Active ingredients': 'Aktivne supstance',
  'Pack barcode': 'Bar-kod pakovanja',
  'No barcode': 'Bez bar-koda',
  'No longer in use': 'Više se ne koristi',
  Essential: 'Esencijalni',
  'Edit medicine': 'Izmeni lek',
  'The generic (INN) name, e.g. Amoxicillin': 'Generički (INN) naziv, npr. Amoxicillin',
  Strength: 'Jačina',
  'e.g. 500 mg': 'npr. 500 mg',
  Form: 'Oblik',
  'e.g. tablet, capsule, solution for injection': 'npr. tableta, kapsula, rastvor za injekciju',
  'What stock is counted in, e.g. tablet, ampoule, bottle':
    'Jedinica u kojoj se broje zalihe, npr. tableta, ampula, boca',
  'e.g. J01CA04': 'npr. J01CA04',
  'The GTIN/EAN number printed under the barcode. Without it the pack cannot be confirmed by scanning.':
    'GTIN/EAN broj odštampan ispod bar-koda. Bez njega pakovanje ne može da se potvrdi skeniranjem.',
  'Generic names separated by commas, e.g. amoxicillin, clavulanic acid. Used by the allergy and interaction checks.':
    'Generički nazivi razdvojeni zarezima, npr. amoxicillin, clavulanic acid. Koriste ih provere alergija i interakcija.',
  'On the essential medicines list': 'Na listi esencijalnih lekova',
  'In use (untick to stop new prescriptions and stock entries)':
    'U upotrebi (uklonite oznaku da zaustavite nove recepte i unose zaliha)',
  '{count} medicine': '{count} lek',
  '{count} medicines': '{count} lekova',
  'Another catalogue item already has this barcode': 'Druga stavka kataloga već ima ovaj bar-kod',
  'Enter the GTIN/EAN printed under the pack barcode (check digit included)':
    'Unesite GTIN/EAN odštampan ispod bar-koda pakovanja (sa kontrolnom cifrom)',
};
