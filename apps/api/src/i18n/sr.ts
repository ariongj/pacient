import { srPews } from './sr-pews.js';
import { srBcma } from './sr-bcma.js';
import { srDosing } from './sr-dosing.js';
import { srMonitoring } from './sr-monitoring.js';
import { srPrivacy } from './sr-privacy.js';
import { srDowntime } from './sr-downtime.js';
import { srTelemedicine } from './sr-telemedicine.js';
import { srSurveillance } from './sr-surveillance.js';
import { srNews } from './sr-news.js';
import { srBilling } from './sr-billing.js';
import { srNutrition } from './sr-nutrition.js';
import { srBloodbank } from './sr-bloodbank.js';
import { srSafety } from './sr-safety.js';
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
import { srDeaths } from './sr-deaths.js';
import { srCertificates } from './sr-certificates.js';
import { srWaiting } from './sr-waiting.js';
import { srRegisters } from './sr-registers.js';
import { srIncidents } from './sr-incidents.js';
import { srMaternity } from './sr-maternity.js';
import { srScreening } from './sr-screening.js';
import { srErx } from './sr-erx.js';
import { srLicences } from './sr-licences.js';
import { srComplaints } from './sr-complaints.js';
import { srDirectives } from './sr-directives.js';
import { srEms } from './sr-ems.js';
import { srInfection } from './sr-infection.js';
import { srSepsis } from './sr-sepsis.js';
import { srRosters } from './sr-rosters.js';
import { srHomecare } from './sr-homecare.js';
import { srEquipment } from './sr-equipment.js';
import { srRemote } from './sr-remote.js';
import { srOncology } from './sr-oncology.js';
import { srDialysis } from './sr-dialysis.js';
import { srMentalhealth } from './sr-mentalhealth.js';
import { srDonors } from './sr-donors.js';
import { srOpendata } from './sr-opendata.js';

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
  ...srSafety,
  ...srBloodbank,
  ...srNutrition,
  ...srBilling,
  ...srNews,
  ...srSurveillance,
  ...srTelemedicine,
  ...srDowntime,
  ...srPrivacy,
  ...srMonitoring,
  ...srDosing,
  ...srBcma,
  ...srPews,
  ...srDeaths,
  ...srCertificates,
  ...srWaiting,
  ...srRegisters,
  ...srIncidents,
  ...srMaternity,
  ...srScreening,
  ...srErx,
  ...srLicences,
  ...srComplaints,
  ...srDirectives,
  ...srEms,
  ...srInfection,
  ...srSepsis,
  ...srRosters,
  ...srHomecare,
  ...srEquipment,
  ...srRemote,
  ...srOncology,
  ...srDialysis,
  ...srMentalhealth,
  ...srDonors,
  ...srOpendata,
};
