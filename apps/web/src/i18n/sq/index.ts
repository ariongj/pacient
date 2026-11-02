import { care } from './care';
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
};
