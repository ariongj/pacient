/**
 * Serbian (Latin) translations of server messages for billing corrections (payments, credit
 * notes) and the column headers of the accountant's exports (the sales book is always in
 * Albanian). English source texts are the keys. Round 2, builder B2.
 */
export const srBillingcorrections: Record<string, string> = {
  'Your facility’s subscription: credit note {number} was issued':
    'Pretplata vaše ustanove: izdato je knjižno odobrenje {number}',
  // Column headers and values of the CSV exports.
  'Invoice number': 'Broj fakture',
  'Credit note number': 'Broj knjižnog odobrenja',
  'Issue date': 'Datum izdavanja',
  'Due date': 'Rok plaćanja',
  Customer: 'Kupac',
  'Facility code': 'Šifra ustanove',
  'Customer business number': 'NUI kupca',
  'Customer fiscal number': 'Poreski broj kupca',
  'Customer VAT number': 'PDV broj kupca',
  'Service from': 'Usluga od',
  'Service to': 'Usluga do',
  'Net amount': 'Iznos bez PDV-a',
  'VAT rate (%)': 'Stopa PDV-a (%)',
  'VAT amount': 'PDV',
  'Total amount': 'Iznos sa PDV-om',
  Currency: 'Valuta',
  'Invoice status': 'Status fakture',
  'Paid amount': 'Plaćeno',
  'Credited amount': 'Odobreno',
  Balance: 'Preostalo za plaćanje',
  'Settled on': 'Izmirena dana',
  'Voided on': 'Poništena dana',
  Open: 'Otvorena',
  Settled: 'Izmirena',
  Voided: 'Poništena',
  Date: 'Datum',
  Entry: 'Stavka',
  'Payment method': 'Način plaćanja',
  'Payment reference': 'Poziv na broj',
  Amount: 'Iznos',
  'Reversal reason': 'Razlog storniranja uplate',
  'Payment received': 'Primljena uplata',
  'Payment reversed': 'Stornirana uplata',
  Reason: 'Razlog',
  'Bank transfer': 'Bankovni transfer',
  Cash: 'Gotovina',
  Card: 'Kartica',
  Other: 'Drugo',
};
