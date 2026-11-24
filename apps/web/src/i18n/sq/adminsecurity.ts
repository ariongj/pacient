/**
 * Albanian (sq) translations for administrator security (re-authentication, bank details, sessions), keyed by the English source text. Keep {placeholders}.
 * Round 2, builder S1.
 */
export const adminsecurity: Record<string, string> = {
  // The password asked again (server message): five wrong ones lock the account for 15 minutes.
  'Too many wrong passwords. Try again in 15 minutes.':
    'Shumë fjalëkalime të gabuara. Provoni përsëri pas 15 minutash.',
  // Platform overview: the bank details were changed in the last 14 days.
  'Bank details changed on {date}': 'Të dhënat bankare u ndryshuan më {date}',
  'You changed the bank details printed on invoices ({time}).':
    'Ju i ndryshuat të dhënat bankare që shtypen në fatura ({time}).',
  '{name} changed the bank details printed on invoices ({time}).':
    '{name} i ndryshoi të dhënat bankare që shtypen në fatura ({time}).',
  'An administrator': 'Një administrator',
  'Customers pay to the account printed on their invoices. If nobody expected this change, correct it before the next invoice is issued.':
    'Klientët paguajnë në llogarinë që shtypet në faturat e tyre. Nëse askush nuk e priste këtë ndryshim, korrigjojeni para se të lëshohet fatura e radhës.',
  'Check the operator settings': 'Kontrolloni cilësimet e operatorit',
  // An administrator is signed out after 30 minutes without input.
  'Are you still there?': 'A jeni ende aty?',
  'For security, administrators are signed out after 30 minutes without activity. You will be signed out at {time} unless you stay signed in.':
    'Për siguri, administratorët çkyçen pas 30 minutash pa aktivitet. Do të çkyçeni në {time}, përveç nëse zgjidhni të mbeteni të kyçur.',
  'Time left:': 'Koha e mbetur:',
  'Stay signed in': 'Mbetu i kyçur',
  'Sign out now': 'Dil tani',
  'You were signed out after 30 minutes without activity.':
    'U çkyçët pas 30 minutash pa aktivitet.',
  'Sign in again to continue.': 'Kyçuni përsëri për të vazhduar.',
  // An administrator's account history: deploy/recover-admin.sh.
  'Recovered on the server by the owner of the installation':
    'Rikuperuar në server nga pronari i instalimit',
};
