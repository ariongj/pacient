/**
 * Albanian translations of server messages for billing documents (the billing_document e-mail, PDF labels). English source texts are the keys.
 * Round 2, builder B1.
 */
export const sqBillingdocs: Record<string, string> = {
  // The billing_document e-mail
  'Hello,': 'Përshëndetje,',
  'Invoice {number} from {operator}': 'Fatura {number} nga {operator}',
  'Reminder: invoice {number} is overdue': 'Kujtesë: fatura {number} ka kaluar afatin',
  'Credit note {number} from {operator}': 'Nota e kreditit {number} nga {operator}',
  'Invoice {number}': 'Fatura {number}',
  'Credit note {number}': 'Nota e kreditit {number}',
  'Please find attached invoice {number} for the Pacient service, period {period}.':
    'Bashkëngjitur gjeni faturën {number} për shërbimin Pacient, periudha {period}.',
  'Invoice {number} for the Pacient service, period {period}, is overdue. It is attached again.':
    'Fatura {number} për shërbimin Pacient, periudha {period}, ka kaluar afatin e pagesës. E bashkëngjitim edhe një herë.',
  'There is nothing to pay: the invoice is for your records.':
    'Nuk ka asgjë për të paguar: fatura është për evidencën tuaj.',
  'Amount to pay: {total}, due by {date}.': 'Shuma për pagesë: {total}, me afat deri më {date}.',
  'Please pay by bank transfer to IBAN {iban} with the reference {reference}.':
    'Ju lutemi paguani me transfertë bankare në IBAN {iban} me referencën {reference}.',
  'If you have paid in the meantime, please ignore this reminder.':
    'Nëse keni paguar ndërkohë, ju lutemi shpërfilleni këtë kujtesë.',
  'Please find attached credit note {number} for invoice {invoice}.':
    'Bashkëngjitur gjeni notën e kreditit {number} për faturën {invoice}.',
  'Amount credited: {total}.': 'Shuma e kredituar: {total}.',
  // What is still owed when the message is queued.
  'Still to pay: {balance} of {total}, due by {date}.':
    'Mbetet për pagesë: {balance} nga {total}, me afat deri më {date}.',
  'This invoice is paid – attached for your records.':
    'Kjo faturë është paguar – e bashkëngjitur për evidencën tuaj.',
  'Invoice {invoice} was already paid: {balance} will be refunded to you.':
    'Fatura {invoice} ishte paguar tashmë: shuma prej {balance} do t’ju kthehet.',
  'Still to pay on invoice {invoice}: {balance}.':
    'Mbetet për pagesë për faturën {invoice}: {balance}.',
  'Invoice {invoice} is settled: there is nothing more to pay.':
    'Fatura {invoice} është shlyer: nuk ka më asgjë për të paguar.',
  'You receive this e-mail as a billing contact of a facility that uses Pacient. Billing e-mails never contain health information.':
    'E merrni këtë e-mail si kontakt për faturim i një institucioni që përdor Pacient. E-mailet e faturimit nuk përmbajnë kurrë informacion shëndetësor.',

  // Invoice and credit note PDFs
  INVOICE: 'FATURË',
  'CREDIT NOTE': 'NOTË KREDITI',
  'No.': 'Nr.',
  Issued: 'Lëshuar',
  'Due date': 'Afati i pagesës',
  'Service period': 'Periudha e shërbimit',
  Invoice: 'Fatura',
  'Bill to': 'Faturohet për',
  Customer: 'Klienti',
  Facility: 'Institucioni',
  'Fiscal number (NUI)': 'Numri fiskal (NUI)',
  'Business number (NUI)': 'Numri i biznesit (NUI)',
  'Fiscal number': 'Numri fiskal',
  'VAT number': 'Numri i TVSH-së',
  'Facility code': 'Kodi i institucionit',
  'Your reference': 'Referenca juaj',
  Description: 'Përshkrimi',
  Period: 'Periudha',
  Amount: 'Shuma',
  'Subscription to the Pacient service: {line}': 'Abonim në shërbimin Pacient: {line}',
  '{plan} plan – monthly': 'Plani {plan} – mujor',
  '{plan} plan – yearly': 'Plani {plan} – vjetor',
  'Amount without VAT': 'Shuma pa TVSH',
  'VAT {rate}': 'TVSH {rate}',
  'Not registered for VAT': 'Jo i regjistruar për TVSH',
  'Total to pay': 'Gjithsej për pagesë',
  'Total credited': 'Gjithsej e kredituar',
  'There is nothing to pay.': 'Nuk ka asgjë për të paguar.',
  'Please pay {amount} by bank transfer by {date}.':
    'Ju lutemi paguani {amount} me transfertë bankare deri më {date}.',
  'Still to pay: {balance} of {total}. Please pay it by bank transfer by {date}.':
    'Mbetet për pagesë: {balance} nga {total}. Ju lutemi paguajeni me transfertë bankare deri më {date}.',
  'This invoice is paid. There is nothing more to pay.':
    'Kjo faturë është paguar. Nuk ka më asgjë për të paguar.',
  Bank: 'Banka',
  'Payment reference': 'Referenca e pagesës',
  'Paid on {date}': 'Paguar më {date}',
  'Voided on {date}': 'Anuluar më {date}',
  'Credit note for invoice {number}': 'Notë krediti për faturën {number}',
  Reason: 'Arsyeja',
  'Correction of invoice {number}': 'Korrigjim i faturës {number}',
  'This credit note reduces the amount of invoice {number} by {amount}.':
    'Kjo notë krediti e zvogëlon shumën e faturës {number} për {amount}.',
};
