/**
 * Albanian translations of server messages for administrator security (bank details changed, sessions). English source texts are the keys.
 * Round 2, builder S1.
 */
export const sqAdminsecurity: Record<string, string> = {
  // To every other administrator when the IBAN or bank on invoices changes.
  'The bank details on invoices were changed by {name} at {time}':
    'Të dhënat bankare në fatura u ndryshuan nga {name} më {time}',
  'Check the IBAN and bank under Operator settings. If nobody expected this change, correct them before the next invoice is issued.':
    'Kontrolloni IBAN-in dhe bankën te Cilësimet e operatorit. Nëse askush nuk e priste këtë ndryshim, korrigjojini para se të lëshohet fatura e radhës.',
  // To every other administrator when an administrator was recovered on the server.
  'The administrator account of {name} was recovered on the server':
    'Llogaria e administratorit {name} u rikuperua në server',
  'Its password and two-step sign-in were reset on the server by the owner of the installation. If nobody expected this, check who has access to the server.':
    'Fjalëkalimi dhe hyrja me dy hapa e saj u rivendosën në server nga pronari i instalimit. Nëse askush nuk e priste këtë, kontrolloni kush ka qasje në server.',
};
