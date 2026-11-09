import { monitoring } from './monitoring';
import { privacy } from './privacy';
import { downtime } from './downtime';
import { pews } from './pews';
import { bcma } from './bcma';
import { dosing } from './dosing';
import { telemedicine } from './telemedicine';
import { surveillance } from './surveillance';
import { news } from './news';
import { billing } from './billing';
import { nutrition } from './nutrition';
import { bloodbank } from './bloodbank';
import { safety } from './safety';
import { security } from './security';
import { vaccination } from './vaccination';
import { scheduling } from './scheduling';
import { common } from './common';
import { management } from './management';
import { portal } from './portal';
import { clinical } from './clinical';
import { care } from './care';
import { merge } from './merge';
import { inpatient } from './inpatient';
import { ed } from './ed';
import { newborn } from './newborn';
import { imaging } from './imaging';
import { partner } from './partner';
import { theatre } from './theatre';
import { pharmacy } from './pharmacy';
import { pacs } from './pacs';
import { deaths } from './deaths';
import { certificates } from './certificates';
import { waiting } from './waiting';
import { registers } from './registers';
import { incidents } from './incidents';
import { storage } from './storage';
import { maternity } from './maternity';
import { screening } from './screening';
import { erx } from './erx';
import { licences } from './licences';
import { complaints } from './complaints';
import { directives } from './directives';
import { ems } from './ems';
import { infection } from './infection';
import { sepsis } from './sepsis';
import { rosters } from './rosters';
import { homecare } from './homecare';
import { equipment } from './equipment';
import { remote } from './remote';
import { oncology } from './oncology';
import { dialysis } from './dialysis';
import { mentalhealth } from './mentalhealth';
import { donors } from './donors';
import { opendata } from './opendata';
import { history } from './history';
import { accessreviews } from './accessreviews';
import { terminology } from './terminology';
import { support } from './support';
import { labwork } from './labwork';
import { proms } from './proms';

export const sr: Record<string, string> = {
  ...common,
  ...management,
  ...portal,
  ...clinical,
  ...care,
  ...merge,
  ...inpatient,
  ...ed,
  ...newborn,
  ...imaging,
  ...partner,
  ...theatre,
  ...pharmacy,
  ...pacs,
  ...scheduling,
  ...vaccination,
  ...security,
  ...safety,
  ...bloodbank,
  ...nutrition,
  ...billing,
  ...news,
  ...surveillance,
  ...telemedicine,
  ...dosing,
  ...bcma,
  ...pews,
  ...downtime,
  ...privacy,
  ...monitoring,
  ...deaths,
  ...certificates,
  ...waiting,
  ...registers,
  ...incidents,
  ...storage,
  ...maternity,
  ...screening,
  ...erx,
  ...licences,
  ...complaints,
  ...directives,
  ...ems,
  ...infection,
  ...sepsis,
  ...rosters,
  ...homecare,
  ...equipment,
  ...remote,
  ...oncology,
  ...dialysis,
  ...mentalhealth,
  ...donors,
  ...opendata,
  ...history,
  ...accessreviews,
  ...terminology,
  ...support,
  ...labwork,
  ...proms,
};
