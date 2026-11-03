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
};
