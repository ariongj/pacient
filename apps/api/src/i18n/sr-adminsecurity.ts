/**
 * Serbian (Latin) translations of server messages for administrator security (bank details changed, sessions). English source texts are the keys.
 * Round 2, builder S1.
 */
export const srAdminsecurity: Record<string, string> = {
  // To every other administrator when the IBAN or bank on invoices changes.
  'The bank details on invoices were changed by {name} at {time}':
    'Bankovne podatke na fakturama promenio je korisnik {name} u {time}',
  'Check the IBAN and bank under Operator settings. If nobody expected this change, correct them before the next invoice is issued.':
    'Proverite IBAN i banku u odeljku Podešavanja operatera. Ako niko nije očekivao ovu promenu, ispravite ih pre izdavanja sledeće fakture.',
  // To every other administrator when an administrator was recovered on the server.
  'The administrator account of {name} was recovered on the server':
    'Administratorski nalog korisnika {name} je vraćen na serveru',
  'Its password and two-step sign-in were reset on the server by the owner of the installation. If nobody expected this, check who has access to the server.':
    'Vlasnik instalacije je na serveru resetovao lozinku i prijavu u dva koraka ovog naloga. Ako to niko nije očekivao, proverite ko ima pristup serveru.',
};
