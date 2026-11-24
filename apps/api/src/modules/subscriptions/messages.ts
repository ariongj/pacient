/**
 * Notification titles of the subscriptions module (server-side, per recipient's language). To be
 * registered in src/i18n/sq.ts and src/i18n/sr.ts; until then the English text is used.
 */
export const sqSubscriptions: Record<string, string> = {
  'Your facility’s subscription: invoice {number} was issued':
    'Abonimi i institucionit tuaj: u lëshua fatura {number}',
  'Your facility’s subscription is active again': 'Abonimi i institucionit tuaj është sërish aktiv',
  'Your facility’s trial is no longer suspended':
    'Periudha provuese e institucionit tuaj nuk është më e pezulluar',
  'Your facility’s subscription is no longer suspended, but an invoice is overdue':
    'Abonimi i institucionit tuaj nuk është më i pezulluar, por ka një faturë me afat të kaluar',
  'Your facility’s subscription has ended': 'Abonimi i institucionit tuaj ka përfunduar',
  'Your facility’s subscription has an overdue invoice':
    'Abonimi i institucionit tuaj ka një faturë me afat të kaluar',
  'Your facility’s subscription is suspended – new staff accounts cannot be added':
    'Abonimi i institucionit tuaj është pezulluar – nuk mund të shtohen llogari të reja të stafit',
  'Your facility’s trial ends on {date}':
    'Periudha provuese e institucionit tuaj përfundon më {date}',
  'Your facility’s subscription renews on {date}':
    'Abonimi i institucionit tuaj rinovohet më {date}',
  'Your facility’s subscription was changed': 'Abonimi i institucionit tuaj u ndryshua',
  'Your facility’s subscription will end on {date}':
    'Abonimi i institucionit tuaj përfundon më {date}',
  'Your facility’s subscription will continue': 'Abonimi i institucionit tuaj vazhdon',
};

export const srSubscriptions: Record<string, string> = {
  'Your facility’s subscription: invoice {number} was issued':
    'Pretplata vaše ustanove: izdata je faktura {number}',
  'Your facility’s subscription is active again': 'Pretplata vaše ustanove je ponovo aktivna',
  'Your facility’s trial is no longer suspended':
    'Probni period vaše ustanove više nije suspendovan',
  'Your facility’s subscription is no longer suspended, but an invoice is overdue':
    'Pretplata vaše ustanove više nije suspendovana, ali ima fakturu kojoj je istekao rok plaćanja',
  'Your facility’s subscription has ended': 'Pretplata vaše ustanove je završena',
  'Your facility’s subscription has an overdue invoice':
    'Pretplata vaše ustanove ima fakturu kojoj je istekao rok plaćanja',
  'Your facility’s subscription is suspended – new staff accounts cannot be added':
    'Pretplata vaše ustanove je suspendovana – novi nalozi osoblja ne mogu da se dodaju',
  'Your facility’s trial ends on {date}': 'Probni period vaše ustanove ističe {date}',
  'Your facility’s subscription renews on {date}': 'Pretplata vaše ustanove se obnavlja {date}',
  'Your facility’s subscription was changed': 'Pretplata vaše ustanove je izmenjena',
  'Your facility’s subscription will end on {date}': 'Pretplata vaše ustanove ističe {date}',
  'Your facility’s subscription will continue': 'Pretplata vaše ustanove se nastavlja',
};
