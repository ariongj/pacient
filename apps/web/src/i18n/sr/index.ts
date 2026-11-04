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
};
