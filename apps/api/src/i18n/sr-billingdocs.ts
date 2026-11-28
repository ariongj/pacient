/**
 * Serbian (Latin) translations of server messages for billing documents (the billing_document e-mail, PDF labels). English source texts are the keys.
 * Round 2, builder B1.
 */
export const srBillingdocs: Record<string, string> = {
  // The billing_document e-mail
  'Hello,': 'Poštovani,',
  'Invoice {number} from {operator}': 'Faktura {number} od {operator}',
  'Reminder: invoice {number} is overdue': 'Podsetnik: faktura {number} nije plaćena u roku',
  'Credit note {number} from {operator}': 'Knjižno odobrenje {number} od {operator}',
  'Invoice {number}': 'Faktura {number}',
  'Credit note {number}': 'Knjižno odobrenje {number}',
  'Please find attached invoice {number} for the Pacient service, period {period}.':
    'U prilogu je faktura {number} za uslugu Pacient, period {period}.',
  'Invoice {number} for the Pacient service, period {period}, is overdue. It is attached again.':
    'Faktura {number} za uslugu Pacient, period {period}, nije plaćena u roku. Ponovo je u prilogu.',
  'There is nothing to pay: the invoice is for your records.':
    'Nema ništa za plaćanje: faktura je za vašu evidenciju.',
  'Amount to pay: {total}, due by {date}.': 'Iznos za plaćanje: {total}, rok plaćanja {date}.',
  'Please pay by bank transfer to IBAN {iban} with the reference {reference}.':
    'Molimo uplatite bankovnim prenosom na IBAN {iban} sa pozivom na broj {reference}.',
  'If you have paid in the meantime, please ignore this reminder.':
    'Ako ste u međuvremenu platili, zanemarite ovaj podsetnik.',
  'Please find attached credit note {number} for invoice {invoice}.':
    'U prilogu je knjižno odobrenje {number} za fakturu {invoice}.',
  'Amount credited: {total}.': 'Odobreni iznos: {total}.',
  // What is still owed when the message is queued.
  'Still to pay: {balance} of {total}, due by {date}.':
    'Preostalo za plaćanje: {balance} od {total}, rok plaćanja {date}.',
  'This invoice is paid – attached for your records.':
    'Ova faktura je plaćena – u prilogu je za vašu evidenciju.',
  'Invoice {invoice} was already paid: {balance} will be refunded to you.':
    'Faktura {invoice} je već plaćena: iznos od {balance} biće vam vraćen.',
  'Still to pay on invoice {invoice}: {balance}.':
    'Preostalo za plaćanje po fakturi {invoice}: {balance}.',
  'Invoice {invoice} is settled: there is nothing more to pay.':
    'Faktura {invoice} je izmirena: nema više ništa za plaćanje.',
  'You receive this e-mail as a billing contact of a facility that uses Pacient. Billing e-mails never contain health information.':
    'Ovaj e-mail primate kao kontakt za fakturisanje ustanove koja koristi Pacient. E-mailovi o fakturisanju nikada ne sadrže zdravstvene podatke.',

  // Invoice and credit note PDFs
  INVOICE: 'FAKTURA',
  'CREDIT NOTE': 'KNJIŽNO ODOBRENJE',
  'No.': 'Br.',
  Issued: 'Izdato',
  'Due date': 'Rok plaćanja',
  'Service period': 'Period usluge',
  Invoice: 'Faktura',
  'Bill to': 'Kupac',
  Customer: 'Kupac',
  Facility: 'Ustanova',
  'Fiscal number (NUI)': 'Fiskalni broj (NUI)',
  'Business number (NUI)': 'Poslovni broj (NUI)',
  'Fiscal number': 'Fiskalni broj',
  'VAT number': 'PDV broj',
  'Facility code': 'Šifra ustanove',
  'Your reference': 'Vaša referenca',
  Description: 'Opis',
  Period: 'Period',
  Amount: 'Iznos',
  'Subscription to the Pacient service: {line}': 'Pretplata na uslugu Pacient: {line}',
  '{plan} plan – monthly': 'Plan {plan} – mesečno',
  '{plan} plan – yearly': 'Plan {plan} – godišnje',
  'Amount without VAT': 'Iznos bez PDV-a',
  'VAT {rate}': 'PDV {rate}',
  'Not registered for VAT': 'Nije u sistemu PDV-a',
  'Total to pay': 'Ukupno za plaćanje',
  'Total credited': 'Ukupno odobreno',
  'There is nothing to pay.': 'Nema ništa za plaćanje.',
  'Please pay {amount} by bank transfer by {date}.':
    'Molimo uplatite {amount} bankovnim prenosom do {date}.',
  'Still to pay: {balance} of {total}. Please pay it by bank transfer by {date}.':
    'Preostalo za plaćanje: {balance} od {total}. Molimo uplatite bankovnim prenosom do {date}.',
  'This invoice is paid. There is nothing more to pay.':
    'Ova faktura je plaćena. Nema više ništa za plaćanje.',
  Bank: 'Banka',
  'Payment reference': 'Poziv na broj',
  'Paid on {date}': 'Plaćeno {date}',
  'Voided on {date}': 'Poništena {date}',
  'Credit note for invoice {number}': 'Knjižno odobrenje za fakturu {number}',
  Reason: 'Razlog',
  'Correction of invoice {number}': 'Ispravka fakture {number}',
  'This credit note reduces the amount of invoice {number} by {amount}.':
    'Ovo knjižno odobrenje umanjuje iznos fakture {number} za {amount}.',
};
