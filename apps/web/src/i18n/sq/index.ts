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

export const sq: Record<string, string> = {
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
};
