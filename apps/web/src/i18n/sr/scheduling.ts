/**
 * Serbian (Latin, sr-Latn) translations, keyed by the English source text. Keep {placeholders}.
 */
export const scheduling: Record<string, string> = {
  'This time is no longer available. Please choose another slot.':
    'Ovaj termin više nije slobodan. Molimo izaberite drugi termin.',
  'You already have 3 upcoming online bookings. Cancel one or call the facility to book more.':
    'Već imate 3 predstojeća onlajn zakazivanja. Otkažite jedno ili pozovite ustanovu da zakažete više.',
  'Online booking is possible from tomorrow up to 60 days ahead':
    'Onlajn zakazivanje je moguće od sutra do 60 dana unapred',
  'You can book doctors of your registration facility or your care team':
    'Možete zakazati kod lekara ustanove u kojoj ste registrovani ili iz Vašeg tima za negu',
  'Only the doctor or their facility’s director or reception can change consulting hours':
    'Radno vreme za prijem može da menja samo lekar ili direktor odnosno prijemna služba njegove ustanove',
  'This doctor works at another facility': 'Ovaj lekar radi u drugoj ustanovi',
  'Two consulting-hour blocks on the same day overlap':
    'Dva bloka radnog vremena istog dana se preklapaju',
  'Appointments can be cancelled online up to 2 hours before. Please call the facility.':
    'Termini se mogu otkazati onlajn najkasnije 2 sata ranije. Molimo pozovite ustanovu.',
  'The end time must be after the start time': 'Vreme završetka mora biti posle vremena početka',
  'The block is shorter than one slot': 'Blok je kraći od jednog termina',
  'The validity period ends before it starts': 'Period važenja se završava pre nego što počinje',
  'Ask for at most 31 days at a time': 'Tražite najviše 31 dan odjednom',
  'Use HH:MM': 'Koristite format ČČ:MM',
  'Use YYYY-MM-DD': 'Koristite format GGGG-MM-DD',
  'New appointment booked online for {time}': 'Novi termin zakazan onlajn za {time}',
  'Reminder: appointment tomorrow at {time} with {doctor}':
    'Podsetnik: termin sutra u {time} kod {doctor}',
  'Weekly consulting hours': 'Nedeljno radno vreme za prijem',
  'Save hours': 'Sačuvaj radno vreme',
  'Bookable times are generated from these hours. Patients can book "online" blocks themselves in the portal; other blocks are for bookings by the facility. Existing appointments are not changed.':
    'Slobodni termini se prave iz ovog radnog vremena. Pacijenti sami mogu da zakažu "onlajn" blokove na portalu; ostali blokovi su za zakazivanje od strane ustanove. Postojeći termini se ne menjaju.',
  'no consulting hours': 'nema radnog vremena za prijem',
  'Slot length': 'Trajanje termina',
  'Patients can book online': 'Pacijenti mogu da zakažu onlajn',
  'Valid from (optional)': 'Važi od (opciono)',
  'Valid until (optional)': 'Važi do (opciono)',
  'Remove block on {day}': 'Ukloni blok za {day}',
  'Add hours on {day}': 'Dodaj radno vreme za {day}',
  'Consulting hours saved': 'Radno vreme za prijem je sačuvano',
  'Leave and other absences': 'Odmori i druga odsustva',
  'No times are offered on these days. Appointments already booked stay as they are.':
    'Ovih dana se ne nude termini. Već zakazani termini ostaju kakvi jesu.',
  'No absences planned': 'Nema planiranih odsustava',
  Absences: 'Odsustva',
  'First day': 'Prvi dan',
  'Last day': 'Poslednji dan',
  'Reason (optional)': 'Razlog (opciono)',
  'Add absence': 'Dodaj odsustvo',
  '{count} booked appointment falls in this period – please rebook it.':
    'Zakazanih termina u ovom periodu: {count} – molimo zakažite ga ponovo.',
  '{count} booked appointments fall in this period – please rebook them.':
    'Zakazanih termina u ovom periodu: {count} – molimo zakažite ih ponovo.',
  'Free times in the next 14 days': 'Slobodni termini u narednih 14 dana',
  'Free times': 'Slobodni termini',
  'Bookable online': 'Mogu se zakazati onlajn',
  'When patients and the front desk can book appointments with you.':
    'Kada pacijenti i prijemna služba mogu da zakažu termin kod Vas.',
  '{count} appointments · {online} booked online · {noShows} no-shows':
    'Termina: {count} · zakazano onlajn: {online} · nedolazaka: {noShows}',
  'no-show rate {pct}%': 'stopa nedolazaka {pct}%',
  'Booked online': 'Zakazano onlajn',
  'No doctor of your facility offers online booking yet. Send a request to your doctor or call the facility.':
    'Nijedan lekar Vaše ustanove još ne nudi onlajn zakazivanje. Pošaljite zahtev svom lekaru ili pozovite ustanovu.',
  'your care team': 'Vaš tim za negu',
  'Your choice': 'Vaš izbor',
  'Book this time': 'Zakaži ovaj termin',
  'Book a free time online, or send a request that your doctor confirms.':
    'Zakažite slobodan termin onlajn ili pošaljite zahtev koji potvrđuje Vaš lekar.',
  'Your appointment is booked': 'Vaš termin je zakazan',
  'You will get a reminder the day before.': 'Dan ranije ćete dobiti podsetnik.',
  'Call the facility to cancel': 'Pozovite ustanovu radi otkazivanja',
  'Book an appointment': 'Zakažite termin',
  Earlier: 'Ranije',
  Later: 'Kasnije',
  'Loading free times…': 'Učitavanje slobodnih termina…',
  'Choose a day': 'Izaberite dan',
  '{count} free time': 'Slobodnih termina: {count}',
  '{count} free times': 'Slobodnih termina: {count}',
  'staff only': 'samo za osoblje',
  'No free times in these two weeks. Try later dates or send a request instead.':
    'Nema slobodnih termina u ove dve nedelje. Pokušajte kasnije datume ili pošaljite zahtev.',
  'No free consulting hours in these two weeks.':
    'Nema slobodnog radnog vremena za prijem u ove dve nedelje.',
  'This time is outside the doctor’s consulting hours or already taken. You can still book it.':
    'Ovo vreme je van radnog vremena lekara ili je već zauzeto. Ipak ga možete zakazati.',
  'How to choose the time': 'Kako izabrati vreme',
  'Free slots': 'Slobodni termini',
  'Other time': 'Drugo vreme',
  'Selected:': 'Izabrano:',
  Sunday: 'Nedelja',
  Monday: 'Ponedeljak',
  Tuesday: 'Utorak',
  Wednesday: 'Sreda',
  Thursday: 'Četvrtak',
  Friday: 'Petak',
  Saturday: 'Subota',
  Sun: 'Ned',
  Mon: 'Pon',
  Tue: 'Uto',
  Wed: 'Sre',
  Thu: 'Čet',
  Fri: 'Pet',
  Sat: 'Sub',
};
