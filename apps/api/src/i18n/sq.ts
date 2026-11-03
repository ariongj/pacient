import { sqSecurity } from './sq-security.js';
import { sqVaccination } from './sq-vaccination.js';
import { sqScheduling } from './sq-scheduling.js';
import { sqTheatre } from './sq-theatre.js';
import { sqStock } from './sq-stock.js';
import { sqPacs } from './sq-pacs.js';
import { sqCore } from './sq-core.js';
import { sqEd } from './sq-ed.js';
import { sqIdentity } from './sq-identity.js';
import { sqImaging } from './sq-imaging.js';
import { sqInpatient } from './sq-inpatient.js';
import { sqPartner } from './sq-partner.js';

export const sq: Record<string, string> = {
  ...sqCore,
  ...sqIdentity,
  ...sqInpatient,
  ...sqEd,
  ...sqImaging,
  ...sqPartner,
  ...sqTheatre,
  ...sqStock,
  ...sqPacs,
  ...sqScheduling,
  ...sqVaccination,
  ...sqSecurity,
};
