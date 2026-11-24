/**
 * Albanian (sq) translations for payments and their reversal, credit notes and exports for the accountant, keyed by the English source text. Keep {placeholders}.
 * Round 2, builder B2.
 */
export const billingcorrections: Record<string, string> = {
  'Credit note': 'Notë krediti',
  'Credit notes': 'Notat e kreditit',
  'Credit note {number}': 'Nota e kreditit {number}',
  'CREDIT NOTE': 'NOTË KREDITI',
  'For invoice {number} of {date}': 'Për faturën {number} të datës {date}',
  'Credit for invoice {number}: {reason}': 'Kreditim për faturën {number}: {reason}',
  'Not registered for VAT': 'Jo i regjistruar për TVSH',
  'Total credited': 'Gjithsej e kredituar',
  'This credit note reduces invoice {number} ({total}) by {amount}.':
    'Kjo notë krediti e zvogëlon faturën {number} ({total}) për {amount}.',
  'for invoice {number}': 'për faturën {number}',
  // Payments and the balance on the invoice page
  'Payments and balance': 'Pagesat dhe mbetja',
  'Invoice total': 'Totali i faturës',
  Credited: 'E kredituar',
  'Still owed': 'Mbetja për pagesë',
  'Still owed: {amount}': 'Mbetja për pagesë: {amount}',
  'To refund': 'Për t’u kthyer',
  'To refund: {amount}': 'Për t’u kthyer: {amount}',
  'More was paid and credited than the invoice total. Refunds are made outside Pacient, by bank transfer; record the refund as a note in the subscription history.':
    'Është paguar dhe kredituar më shumë se totali i faturës. Kthimet e parave bëhen jashtë Pacient-it, me transfer bankar; regjistrojeni kthimin si shënim në historikun e abonimit.',
  'The service operator refunds this amount to your facility.':
    'Operatori i shërbimit ia kthen këtë shumë institucionit tuaj.',
  'No payments recorded yet.': 'Ende nuk është regjistruar asnjë pagesë.',
  'Received|payment': 'E pranuar',
  'Reversed|payment': 'E anuluar',
  'Reverse|payment action': 'Anulo',
  'Recorded by {name}': 'Regjistruar nga {name}',
  '{date} by {name}': '{date} nga {name}',
  'Reverse payment': 'Anulo pagesën',
  '{amount} received on {date}': '{amount} e pranuar më {date}',
  'The payment stays on record, marked as reversed. A paid invoice is open again; if it is overdue, the subscription shows the overdue payment again. You will be asked for your password.':
    'Pagesa mbetet e regjistruar, e shënuar si e anuluar. Një faturë e paguar hapet sërish; nëse i ka kaluar afati, abonimi shfaq sërish pagesën e vonuar. Do t’ju kërkohet fjalëkalimi.',
  'E.g. the bank returned the transfer, or it was recorded on the wrong invoice.':
    'P.sh. banka e ktheu transferin, ose u regjistrua në faturën e gabuar.',
  'Amount received (€)': 'Shuma e pranuar (€)',
  'Less than what is owed leaves the rest open.':
    'Një shumë më e vogël se mbetja e lë pjesën tjetër të hapur.',
  'Enter an amount above 0 and at most {max}.': 'Shkruani një shumë mbi 0 dhe deri në {max}.',
  // Voiding
  'Only for a mistake noticed straight away: an invoice of this month without payments or credit notes that was not yet e-mailed. You will be asked for your password.':
    'Vetëm për një gabim të vërejtur menjëherë: një faturë e këtij muaji pa pagesa dhe pa nota krediti, që ende nuk është dërguar me e-mail. Do t’ju kërkohet fjalëkalimi.',
  'This invoice can no longer be voided: {why} Issue a credit note instead.':
    'Kjo faturë nuk mund të anulohet më: {why} Në vend të kësaj lëshoni një notë krediti.',
  'Only an open invoice can be voided.': 'Vetëm një faturë e hapur mund të anulohet.',
  'A payment was recorded on this invoice.': 'Në këtë faturë është regjistruar një pagesë.',
  'A credit note was issued for this invoice.': 'Për këtë faturë është lëshuar një notë krediti.',
  'It was issued before this month.': 'Është lëshuar para këtij muaji.',
  'It was already e-mailed to the customer.': 'I është dërguar tashmë klientit me e-mail.',
  // Issuing a credit note
  'Issue credit note': 'Lësho notë krediti',
  'An issued invoice is never changed. To reduce or cancel what it charges, issue a credit note.':
    'Një faturë e lëshuar nuk ndryshohet kurrë. Për ta zvogëluar ose anuluar shumën e saj, lëshoni një notë krediti.',
  'Up to {amount} can still be credited.': 'Mund të kreditohen ende deri në {amount}.',
  'Amount to credit, VAT included (€)': 'Shuma për kreditim, me TVSH (€)',
  'Printed on the credit note, e.g. “Service not available from 3 to 10 March”.':
    'Shtypet në notën e kreditit, p.sh. “Shërbimi nuk ishte në dispozicion nga 3 deri më 10 mars”.',
  'A credit note cannot be changed or withdrawn':
    'Një notë krediti nuk mund të ndryshohet ose tërhiqet',
  'The invoice is paid: the amount credited is to be refunded to the facility, outside Pacient.':
    'Fatura është paguar: shuma e kredituar duhet t’i kthehet institucionit, jashtë Pacient-it.',
  'What is still owed goes down by the amount; a credit note that brings it to 0 settles the invoice.':
    'Mbetja për pagesë zvogëlohet për këtë shumë; një notë krediti që e sjell në 0 e shlyen faturën.',
  'The credit note is numbered, e-mailed to the facility and shown to its directors. You will be asked for your password.':
    'Nota e kreditit numërohet, i dërgohet institucionit me e-mail dhe u shfaqet drejtorëve të tij. Do t’ju kërkohet fjalëkalimi.',
  // The subscription history
  'No invoice is overdue any more after a credit note':
    'Pas një note krediti nuk ka më fatura me afat të kaluar',
  'A payment was reversed': 'Një pagesë u anulua',
  // Exports for the accountant
  'Export for the accountant': 'Eksport për kontabilistin',
  'Payments and reversals': 'Pagesat dhe anulimet',
  'Sales book (in Albanian)': 'Libri i shitjes (në shqip)',
  Year: 'Viti',
  'Quarter {number}': 'Tremujori {number}',
  'From {from} to {to}': 'Nga {from} deri më {to}',
  'CSV files (UTF-8, comma-separated) for a spreadsheet or accounting software: calendar days in Kosovo, amounts in euros with a decimal point. Payments are listed by payment date, reversals as negative amounts on the day they were reversed. Each download asks for your password and is recorded.':
    'Skedarë CSV (UTF-8, të ndarë me presje) për tabela ose softuer kontabiliteti: ditë kalendarike në Kosovë, shuma në euro me pikë dhjetore. Pagesat renditen sipas datës së pagesës, anulimet si shuma negative në ditën kur u anuluan. Çdo shkarkim kërkon fjalëkalimin tuaj dhe regjistrohet.',
  // Messages from the server
  'Nothing is owed on this invoice': 'Për këtë faturë nuk ka asgjë për të paguar',
  'The payment is more than what is still owed on the invoice. Record the amount owed and refund the rest outside Pacient.':
    'Pagesa është më e madhe se mbetja e faturës. Regjistroni shumën e mbetur dhe kthejeni pjesën tjetër jashtë Pacient-it.',
  'An invoice with payments cannot be voided. Issue a credit note instead.':
    'Një faturë me pagesa nuk mund të anulohet. Në vend të kësaj lëshoni një notë krediti.',
  'An invoice with credit notes cannot be voided. Issue a credit note instead.':
    'Një faturë me nota krediti nuk mund të anulohet. Në vend të kësaj lëshoni një notë krediti.',
  'Only an invoice issued this month can be voided. Issue a credit note instead.':
    'Vetëm një faturë e lëshuar këtë muaj mund të anulohet. Në vend të kësaj lëshoni një notë krediti.',
  'An invoice already e-mailed to the customer cannot be voided. Issue a credit note instead.':
    'Një faturë që i është dërguar tashmë klientit me e-mail nuk mund të anulohet. Në vend të kësaj lëshoni një notë krediti.',
  'Only an open invoice can be voided': 'Vetëm një faturë e hapur mund të anulohet',
  'This payment was already reversed': 'Kjo pagesë është anuluar tashmë',
  'Payment not found': 'Pagesa nuk u gjet',
  'Credit note not found': 'Nota e kreditit nuk u gjet',
  'A voided invoice is not owed, so there is nothing to credit':
    'Një faturë e anuluar nuk paguhet, prandaj nuk ka asgjë për të kredituar',
  'Nothing is left to credit on this invoice':
    'Në këtë faturë nuk ka mbetur asgjë për të kredituar',
  'A credit note cannot be more than the invoice total less its earlier credit notes':
    'Një notë krediti nuk mund të jetë më e madhe se totali i faturës minus notat e mëparshme të kreditit',
  'The period ends before it starts': 'Periudha përfundon para se të fillojë',
  'An export covers at most one year': 'Një eksport mbulon më së shumti një vit',
  'Use a date as YYYY-MM-DD': 'Shkruani datën si VVVV-MM-DD',
  'Not a valid date': 'Data nuk është e vlefshme',
};
