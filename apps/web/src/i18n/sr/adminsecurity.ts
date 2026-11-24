/**
 * Serbian Latin (sr) translations for administrator security (re-authentication, bank details, sessions), keyed by the English source text. Keep {placeholders}.
 * Round 2, builder S1.
 */
export const adminsecurity: Record<string, string> = {
  // The password asked again (server message): five wrong ones lock the account for 15 minutes.
  'Too many wrong passwords. Try again in 15 minutes.':
    'Previše pogrešnih lozinki. Pokušajte ponovo za 15 minuta.',
  // Platform overview: the bank details were changed in the last 14 days.
  'Bank details changed on {date}': 'Bankovni podaci su promenjeni {date}',
  'You changed the bank details printed on invoices ({time}).':
    'Promenili ste bankovne podatke koji se štampaju na fakturama ({time}).',
  '{name} changed the bank details printed on invoices ({time}).':
    'Korisnik {name} je promenio bankovne podatke koji se štampaju na fakturama ({time}).',
  'An administrator': 'Administrator',
  'Customers pay to the account printed on their invoices. If nobody expected this change, correct it before the next invoice is issued.':
    'Klijenti plaćaju na račun koji je odštampan na njihovim fakturama. Ako niko nije očekivao ovu promenu, ispravite je pre izdavanja sledeće fakture.',
  'Check the operator settings': 'Proverite podešavanja operatera',
  // An administrator is signed out after 30 minutes without input.
  'Are you still there?': 'Da li ste još tu?',
  'For security, administrators are signed out after 30 minutes without activity. You will be signed out at {time} unless you stay signed in.':
    'Radi bezbednosti, administratori se odjavljuju posle 30 minuta bez aktivnosti. Bićete odjavljeni u {time} ako ne izaberete da ostanete prijavljeni.',
  'Time left:': 'Preostalo vreme:',
  'Stay signed in': 'Ostani prijavljen',
  'Sign out now': 'Odjavi se sada',
  'You were signed out after 30 minutes without activity.':
    'Odjavljeni ste posle 30 minuta bez aktivnosti.',
  'Sign in again to continue.': 'Prijavite se ponovo da biste nastavili.',
  // An administrator's account history: deploy/recover-admin.sh.
  'Recovered on the server by the owner of the installation':
    'Vraćen na serveru od strane vlasnika instalacije',
};
