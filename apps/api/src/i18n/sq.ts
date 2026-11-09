import { sqPews } from './sq-pews.js';
import { sqBcma } from './sq-bcma.js';
import { sqDosing } from './sq-dosing.js';
import { sqMonitoring } from './sq-monitoring.js';
import { sqPrivacy } from './sq-privacy.js';
import { sqDowntime } from './sq-downtime.js';
import { sqTelemedicine } from './sq-telemedicine.js';
import { sqSurveillance } from './sq-surveillance.js';
import { sqNews } from './sq-news.js';
import { sqBilling } from './sq-billing.js';
import { sqNutrition } from './sq-nutrition.js';
import { sqBloodbank } from './sq-bloodbank.js';
import { sqSafety } from './sq-safety.js';
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
import { sqDeaths } from './sq-deaths.js';
import { sqCertificates } from './sq-certificates.js';
import { sqWaiting } from './sq-waiting.js';
import { sqRegisters } from './sq-registers.js';
import { sqIncidents } from './sq-incidents.js';
import { sqMaternity } from './sq-maternity.js';
import { sqScreening } from './sq-screening.js';
import { sqErx } from './sq-erx.js';
import { sqLicences } from './sq-licences.js';
import { sqComplaints } from './sq-complaints.js';
import { sqDirectives } from './sq-directives.js';
import { sqEms } from './sq-ems.js';
import { sqInfection } from './sq-infection.js';
import { sqSepsis } from './sq-sepsis.js';
import { sqRosters } from './sq-rosters.js';
import { sqHomecare } from './sq-homecare.js';
import { sqEquipment } from './sq-equipment.js';
import { sqRemote } from './sq-remote.js';
import { sqOncology } from './sq-oncology.js';
import { sqDialysis } from './sq-dialysis.js';
import { sqMentalhealth } from './sq-mentalhealth.js';
import { sqDonors } from './sq-donors.js';
import { sqOpendata } from './sq-opendata.js';
import { sqHistory } from './sq-history.js';
import { sqAccessreviews } from './sq-accessreviews.js';
import { sqTerminology } from './sq-terminology.js';
import { sqSupport } from './sq-support.js';
import { sqLabwork } from './sq-labwork.js';
import { sqProms } from './sq-proms.js';

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
  ...sqSafety,
  ...sqBloodbank,
  ...sqNutrition,
  ...sqBilling,
  ...sqNews,
  ...sqSurveillance,
  ...sqTelemedicine,
  ...sqDowntime,
  ...sqPrivacy,
  ...sqMonitoring,
  ...sqDosing,
  ...sqBcma,
  ...sqPews,
  ...sqDeaths,
  ...sqCertificates,
  ...sqWaiting,
  ...sqRegisters,
  ...sqIncidents,
  ...sqMaternity,
  ...sqScreening,
  ...sqErx,
  ...sqLicences,
  ...sqComplaints,
  ...sqDirectives,
  ...sqEms,
  ...sqInfection,
  ...sqSepsis,
  ...sqRosters,
  ...sqHomecare,
  ...sqEquipment,
  ...sqRemote,
  ...sqOncology,
  ...sqDialysis,
  ...sqMentalhealth,
  ...sqDonors,
  ...sqOpendata,
  ...sqHistory,
  ...sqAccessreviews,
  ...sqTerminology,
  ...sqSupport,
  ...sqLabwork,
  ...sqProms,
};
