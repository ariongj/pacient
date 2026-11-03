import { care } from './care';
import { ed } from './ed';
import { imaging } from './imaging';
import { inpatient } from './inpatient';
import { newborn } from './newborn';
import { partner } from './partner';
import { clinical } from './clinical';
import { common } from './common';
import { management } from './management';
import { merge } from './merge';
import { portal } from './portal';

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
};
