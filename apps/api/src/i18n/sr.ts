import { srSecurity } from './sr-security.js';
import { srVaccination } from './sr-vaccination.js';
import { srScheduling } from './sr-scheduling.js';
import { srTheatre } from './sr-theatre.js';
import { srStock } from './sr-stock.js';
import { srPacs } from './sr-pacs.js';
import { srCore } from './sr-core.js';
import { srIdentity } from './sr-identity.js';
import { srInpatient } from './sr-inpatient.js';
import { srEd } from './sr-ed.js';
import { srImaging } from './sr-imaging.js';
import { srPartner } from './sr-partner.js';

export const sr: Record<string, string> = {
  ...srCore,
  ...srIdentity,
  ...srInpatient,
  ...srEd,
  ...srImaging,
  ...srPartner,
  ...srTheatre,
  ...srStock,
  ...srPacs,
  ...srScheduling,
  ...srVaccination,
  ...srSecurity,
};
