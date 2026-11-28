/**
 * Serbian Latin (sr) translations for payments and their reversal, credit notes and exports for the accountant, keyed by the English source text. Keep {placeholders}.
 * Round 2, builder B2.
 */
export const billingcorrections: Record<string, string> = {
  'Credit note': 'Knjižno odobrenje',
  'Credit notes': 'Knjižna odobrenja',
  'Credit note {number}': 'Knjižno odobrenje {number}',
  'CREDIT NOTE': 'KNJIŽNO ODOBRENJE',
  'For invoice {number} of {date}': 'Za fakturu {number} od {date}',
  'Credit for invoice {number}: {reason}': 'Odobrenje za fakturu {number}: {reason}',
  'Not registered for VAT': 'Nije u sistemu PDV-a',
  'Total credited': 'Ukupno odobreno',
  'This credit note reduces invoice {number} ({total}) by {amount}.':
    'Ovo knjižno odobrenje umanjuje fakturu {number} ({total}) za {amount}.',
  'for invoice {number}': 'za fakturu {number}',
  // Payments and the balance on the invoice page
  'Payments and balance': 'Uplate i saldo',
  'Invoice total': 'Ukupno po fakturi',
  Credited: 'Odobreno',
  'Still owed': 'Preostalo za plaćanje',
  'Still owed: {amount}': 'Preostalo za plaćanje: {amount}',
  'To refund': 'Za povraćaj',
  'To refund: {amount}': 'Za povraćaj: {amount}',
  'More was paid and credited than the invoice total. Refunds are made outside Pacient, by bank transfer; record each refund here once it is made.':
    'Plaćeno je i odobreno više od ukupnog iznosa fakture. Povraćaj se vrši van Pacienta, bankovnim transferom; evidentirajte ovde svaki povraćaj kada je izvršen.',
  'Record refund': 'Evidentiraj povraćaj',
  'Refunded on {date}: {amount}': 'Vraćeno {date}: {amount}',
  'Amount refunded (€)': 'Vraćeni iznos (€)',
  'Refunded on': 'Vraćeno dana',
  'Record the refund once the money was sent back to the facility. The invoice does not change; its directors see when it was refunded. You will be asked for your password.':
    'Evidentirajte povraćaj kada je novac vraćen ustanovi. Faktura se ne menja; njeni direktori vide kada je iznos vraćen. Biće zatražena vaša lozinka.',
  'The service operator refunds this amount to your facility.':
    'Operater usluge vraća ovaj iznos vašoj ustanovi.',
  'No payments recorded yet.': 'Još nije evidentirana nijedna uplata.',
  'Received|payment': 'Primljena',
  'Reversed|payment': 'Stornirana',
  'Reverse|payment action': 'Storniraj',
  'Recorded by {name}': 'Evidentirao/la {name}',
  '{date} by {name}': '{date}, {name}',
  'Reverse payment': 'Storniraj uplatu',
  '{amount} received on {date}': '{amount} primljeno {date}',
  'The payment stays on record, marked as reversed. A paid invoice is open again; if it is overdue, the subscription shows the overdue payment again. You will be asked for your password.':
    'Uplata ostaje evidentirana, označena kao stornirana. Plaćena faktura ponovo postaje otvorena; ako joj je istekao rok, pretplata ponovo prikazuje plaćanje koje kasni. Biće zatražena vaša lozinka.',
  'E.g. the bank returned the transfer, or it was recorded on the wrong invoice.':
    'Npr. banka je vratila transfer ili je uplata evidentirana na pogrešnu fakturu.',
  'Amount received (€)': 'Primljeni iznos (€)',
  'Less than what is owed leaves the rest open.':
    'Manji iznos od preostalog ostavlja ostatak otvorenim.',
  'Enter an amount above 0 and at most {max}.': 'Unesite iznos veći od 0 i najviše {max}.',
  // Voiding
  'Only for a mistake noticed straight away: an invoice of this month without payments or credit notes that was not yet e-mailed. You will be asked for your password.':
    'Samo za grešku uočenu odmah: faktura iz ovog meseca bez uplata i knjižnih odobrenja koja još nije poslata e-poštom. Biće zatražena vaša lozinka.',
  'This invoice can no longer be voided: {why} Issue a credit note instead.':
    'Ova faktura više ne može da se poništi: {why} Umesto toga izdajte knjižno odobrenje.',
  'Only an open invoice can be voided.': 'Samo otvorena faktura može da se poništi.',
  'A payment was recorded on this invoice.': 'Na ovoj fakturi je evidentirana uplata.',
  'A credit note was issued for this invoice.': 'Za ovu fakturu je izdato knjižno odobrenje.',
  'It was issued before this month.': 'Izdata je pre ovog meseca.',
  'It was already e-mailed to the customer.': 'Već je poslata kupcu e-poštom.',
  // Issuing a credit note
  'Issue credit note': 'Izdaj knjižno odobrenje',
  'An issued invoice is never changed. To reduce or cancel what it charges, issue a credit note.':
    'Izdata faktura se nikada ne menja. Da biste umanjili ili poništili njen iznos, izdajte knjižno odobrenje.',
  'Up to {amount} can still be credited.': 'Još može da se odobri do {amount}.',
  'Amount to credit, VAT included (€)': 'Iznos odobrenja, sa PDV-om (€)',
  'Printed on the credit note, e.g. “Service not available from 3 to 10 March”.':
    'Štampa se na knjižnom odobrenju, npr. „Usluga nije bila dostupna od 3. do 10. marta”.',
  'A credit note cannot be changed or withdrawn':
    'Knjižno odobrenje ne može da se izmeni niti povuče',
  'The invoice is paid: the amount credited is to be refunded to the facility, outside Pacient.':
    'Faktura je plaćena: odobreni iznos treba vratiti ustanovi, van Pacienta.',
  'What is still owed goes down by the amount; a credit note that brings it to 0 settles the invoice.':
    'Preostali dug se umanjuje za ovaj iznos; knjižno odobrenje koje ga svede na 0 izmiruje fakturu.',
  'The credit note is numbered, e-mailed to the facility and shown to its directors. You will be asked for your password.':
    'Knjižno odobrenje dobija broj, šalje se ustanovi e-poštom i prikazuje njenim direktorima. Biće zatražena vaša lozinka.',
  // The subscription history
  'No invoice is overdue any more after a credit note':
    'Posle knjižnog odobrenja više nema fakture kojoj je istekao rok',
  'A payment was reversed': 'Uplata je stornirana',
  // Exports for the accountant
  'Export for the accountant': 'Izvoz za računovođu',
  'Payments and reversals': 'Uplate i storniranja',
  'Sales book (in Albanian)': 'Knjiga izlaznih računa (na albanskom)',
  Year: 'Godina',
  'Quarter {number}': '{number}. kvartal',
  'From {from} to {to}': 'Od {from} do {to}',
  'CSV files (UTF-8, comma-separated) for a spreadsheet or accounting software: calendar days in Kosovo, amounts in euros with a decimal point. Payments are listed by payment date, reversals as negative amounts on the day they were reversed. Each download asks for your password and is recorded.':
    'CSV datoteke (UTF-8, razdvojene zarezima) za tabele ili računovodstveni softver: kalendarski dani na Kosovu, iznosi u evrima sa decimalnom tačkom. Uplate su navedene po datumu plaćanja, storniranja kao negativni iznosi na dan storniranja. Svako preuzimanje traži vašu lozinku i evidentira se.',
  // Messages from the server
  'Nothing is owed on this invoice': 'Po ovoj fakturi ništa nije dugovano',
  'The payment is more than what is still owed on the invoice. Record the amount owed and refund the rest outside Pacient.':
    'Uplata je veća od preostalog duga po fakturi. Evidentirajte dugovani iznos, a ostatak vratite van Pacienta.',
  'An invoice with payments cannot be voided. Issue a credit note instead.':
    'Faktura sa uplatama ne može da se poništi. Umesto toga izdajte knjižno odobrenje.',
  'An invoice with credit notes cannot be voided. Issue a credit note instead.':
    'Faktura sa knjižnim odobrenjima ne može da se poništi. Umesto toga izdajte knjižno odobrenje.',
  'Only an invoice issued this month can be voided. Issue a credit note instead.':
    'Samo faktura izdata ovog meseca može da se poništi. Umesto toga izdajte knjižno odobrenje.',
  'An invoice already e-mailed to the customer cannot be voided. Issue a credit note instead.':
    'Faktura koja je već poslata kupcu e-poštom ne može da se poništi. Umesto toga izdajte knjižno odobrenje.',
  'Only an open invoice can be voided': 'Samo otvorena faktura može da se poništi',
  'This payment was already reversed': 'Ova uplata je već stornirana',
  'Payment not found': 'Uplata nije pronađena',
  'Credit note not found': 'Knjižno odobrenje nije pronađeno',
  'A voided invoice is not owed, so there is nothing to credit':
    'Poništena faktura se ne duguje, pa nema šta da se odobri',
  'Nothing is left to credit on this invoice': 'Na ovoj fakturi više nema šta da se odobri',
  'A credit note cannot be more than the invoice total less its earlier credit notes':
    'Knjižno odobrenje ne može biti veće od ukupnog iznosa fakture umanjenog za ranija knjižna odobrenja',
  'The period ends before it starts': 'Period se završava pre nego što počinje',
  'An export covers at most one year': 'Izvoz obuhvata najviše jednu godinu',
  'Use a date as YYYY-MM-DD': 'Unesite datum kao GGGG-MM-DD',
  'The refund date cannot be in the future': 'Datum povraćaja ne može biti u budućnosti',
  'The refund date is before the invoice date': 'Datum povraćaja je pre datuma fakture',
  'Nothing is to be refunded on this invoice': 'Po ovoj fakturi nema ništa za povraćaj',
  'A refund cannot be more than what is to be refunded on the invoice':
    'Povraćaj ne može biti veći od iznosa za povraćaj po fakturi',
  'Not a valid date': 'Datum nije ispravan',
};
