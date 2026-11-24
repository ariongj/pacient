/**
 * Albanian translations of server messages for billing corrections (payments, credit notes) and
 * the column headers of the accountant's exports (the sales book is always in Albanian). English
 * source texts are the keys. Round 2, builder B2.
 */
export const sqBillingcorrections: Record<string, string> = {
  'Your facility’s subscription: credit note {number} was issued':
    'Abonimi i institucionit tuaj: u lëshua nota e kreditit {number}',
  // Column headers and values of the CSV exports.
  'Invoice number': 'Numri i faturës',
  'Credit note number': 'Numri i notës së kreditit',
  'Issue date': 'Data e lëshimit',
  'Due date': 'Afati i pagesës',
  Customer: 'Klienti',
  'Facility code': 'Kodi i institucionit',
  'Customer business number': 'NUI i klientit',
  'Customer fiscal number': 'Numri fiskal i klientit',
  'Customer VAT number': 'Numri i TVSH-së i klientit',
  'Service from': 'Shërbimi nga',
  'Service to': 'Shërbimi deri',
  'Net amount': 'Vlera pa TVSH',
  'VAT rate (%)': 'Norma e TVSH-së (%)',
  'VAT amount': 'TVSH',
  'Total amount': 'Vlera me TVSH',
  Currency: 'Monedha',
  'Invoice status': 'Statusi i faturës',
  'Paid amount': 'E paguar',
  'Credited amount': 'E kredituar',
  Balance: 'Mbetja për pagesë',
  'Settled on': 'E shlyer më',
  'Voided on': 'E anuluar më',
  Open: 'E hapur',
  Settled: 'E shlyer',
  Voided: 'E anuluar',
  Date: 'Data',
  Entry: 'Regjistrimi',
  'Payment method': 'Mënyra e pagesës',
  'Payment reference': 'Referenca e pagesës',
  Amount: 'Shuma',
  'Reversal reason': 'Arsyeja e anulimit të pagesës',
  'Payment received': 'Pagesë e pranuar',
  'Payment reversed': 'Pagesë e anuluar',
  Reason: 'Arsyeja',
  'Bank transfer': 'Transfer bankar',
  Cash: 'Para në dorë',
  Card: 'Kartelë',
  Other: 'Tjetër',
};
