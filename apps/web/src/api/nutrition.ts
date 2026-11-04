import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { t } from '../i18n';
import { api } from './client';

export type DietType =
  | 'NORMAL'
  | 'NIL_BY_MOUTH'
  | 'CLEAR_FLUIDS'
  | 'FULL_FLUIDS'
  | 'SOFT'
  | 'PUREED'
  | 'DIABETIC'
  | 'LOW_SALT'
  | 'RENAL'
  | 'LOW_FAT'
  | 'HIGH_PROTEIN'
  | 'GLUTEN_FREE'
  | 'VEGETARIAN'
  | 'ENTERAL_TUBE';

export const DIET_TYPES: DietType[] = [
  'NORMAL',
  'DIABETIC',
  'LOW_SALT',
  'LOW_FAT',
  'RENAL',
  'HIGH_PROTEIN',
  'GLUTEN_FREE',
  'VEGETARIAN',
  'SOFT',
  'PUREED',
  'FULL_FLUIDS',
  'CLEAR_FLUIDS',
  'ENTERAL_TUBE',
  'NIL_BY_MOUTH',
];

export function dietLabel(d: string): string {
  const labels: Record<DietType, string> = {
    NORMAL: t('Normal diet'),
    NIL_BY_MOUTH: t('Nil by mouth'),
    CLEAR_FLUIDS: t('Clear fluids'),
    FULL_FLUIDS: t('Full fluids'),
    SOFT: t('Soft diet'),
    PUREED: t('Pureed diet'),
    DIABETIC: t('Diabetic diet'),
    LOW_SALT: t('Low-salt diet'),
    RENAL: t('Renal diet'),
    LOW_FAT: t('Low-fat diet'),
    HIGH_PROTEIN: t('High-protein diet'),
    GLUTEN_FREE: t('Gluten-free diet'),
    VEGETARIAN: t('Vegetarian diet'),
    ENTERAL_TUBE: t('Tube feeding'),
  };
  return labels[d as DietType] ?? d;
}

export function dietDescription(d: DietType): string {
  const descriptions: Record<DietType, string> = {
    NORMAL: t('Regular hospital menu.'),
    NIL_BY_MOUTH: t('Nothing to eat or drink.'),
    CLEAR_FLUIDS: t('Water, clear tea, clear broth, apple juice, jelly.'),
    FULL_FLUIDS: t('All drinks, soups, milk, yoghurt and puddings.'),
    SOFT: t('Tender, moist food that is easy to chew.'),
    PUREED: t('Smooth food with no lumps, for swallowing difficulties.'),
    DIABETIC: t('Controlled carbohydrates, no added sugar.'),
    LOW_SALT: t('No added salt, no salty foods.'),
    RENAL: t('Limited potassium, phosphate and salt.'),
    LOW_FAT: t('Lean meat, no fried food.'),
    HIGH_PROTEIN: t('Extra protein for healing and recovery.'),
    GLUTEN_FREE: t('No wheat, barley or rye (coeliac disease).'),
    VEGETARIAN: t('No meat or fish.'),
    ENTERAL_TUBE: t('Nutrition through a feeding tube – no tray.'),
  };
  return descriptions[d];
}

export function allergyLabel(tag: string): string {
  const labels: Record<string, string> = {
    peanuts: t('Peanuts'),
    'tree nuts': t('Tree nuts'),
    gluten: t('Gluten'),
    milk: t('Milk'),
    egg: t('Egg'),
    fish: t('Fish'),
    shellfish: t('Shellfish'),
    soy: t('Soy'),
    sesame: t('Sesame'),
  };
  return labels[tag] ?? tag;
}

export type Meal = 'BREAKFAST' | 'LUNCH' | 'DINNER';
export const MEALS: Meal[] = ['BREAKFAST', 'LUNCH', 'DINNER'];
export const mealLabel = (m: Meal) =>
  ({ BREAKFAST: t('Breakfast'), LUNCH: t('Lunch'), DINNER: t('Dinner') })[m];

export type Risk = 'LOW' | 'MEDIUM' | 'HIGH';
export const riskLabel = (r: string) =>
  ({ LOW: t('Low risk'), MEDIUM: t('Medium risk'), HIGH: t('High risk') })[r as Risk] ?? r;
export const riskTone = (r: string) =>
  r === 'HIGH' ? ('danger' as const) : r === 'MEDIUM' ? ('warning' as const) : ('success' as const);

export interface NpoStatus {
  level: 'SOLIDS' | 'FULL';
  surgicalCaseId: string;
  procedure: string;
  operationAt: string;
  solidsFrom: string;
  fluidsFrom: string;
  solidsFromLocal: string;
  fluidsFromLocal: string;
}

export interface DietLine {
  admissionId: string;
  patientId: string;
  patientName: string;
  ageYears: number;
  unitId: string;
  unitName: string;
  bedLabel: string | null;
  dietType: DietType;
  hasOrder: boolean;
  restrictions: string[];
  foodAllergies: string[];
  fluidLimitMl: number | null;
  notes: string | null;
  npo: NpoStatus | null;
  temporaryIdentity: string | null;
}

export interface KitchenList {
  date: string;
  meal: Meal;
  mealTime: string;
  servedAt: string;
  wards: { unitId: string; unitName: string; patients: DietLine[] }[];
  totals: Partial<Record<DietType, number>>;
  count: number;
}

export interface WardLine extends DietLine {
  admittedAt: string;
  screening: { tool: string; score: number; risk: Risk; screenedAt: string } | null;
  screeningState: 'DONE' | 'DUE' | 'OVERDUE';
}

export interface ScreeningDue {
  admissionId: string;
  patientId: string;
  patientName: string;
  ageYears: number;
  unitName: string;
  bedLabel: string | null;
  admittedAt: string;
  dueBy: string;
  screeningState: 'DUE' | 'OVERDUE';
  recommendedTool: 'NRS2002' | 'STRONGKIDS';
}

export interface DietOrder {
  id: string;
  admissionId: string;
  dietType: DietType;
  restrictions: string[] | null;
  fluidLimitMl: number | null;
  notes?: string | null;
  reason?: string | null;
  surgicalCaseId: string | null;
  startsAt: string;
  endsAt: string | null;
  orderedBy: string;
}

export interface Screening {
  id: string;
  tool: 'NRS2002' | 'MUST' | 'STRONGKIDS';
  score: number;
  risk: Risk;
  answers: Record<string, unknown>;
  screenedAt: string;
  screenedBy: string;
}

export interface PatientNutrition {
  admission: { id: string; admittedAt: string; unitId: string } | null;
  current: DietOrder | null;
  history: DietOrder[];
  foodAllergies: string[];
  npo: NpoStatus | null;
  screenings: Screening[];
  screeningState: 'DONE' | 'DUE' | 'OVERDUE' | null;
  ageYears: number;
  recommendedTool: 'NRS2002' | 'STRONGKIDS';
  rules: { npoSolidsHours: number; npoClearFluidsHours: number };
}

const KEY = ['nutrition'] as const;

export const useKitchen = (meal: Meal, date: string, unitId?: string) =>
  useQuery({
    queryKey: [...KEY, 'kitchen', meal, date, unitId ?? 'all'],
    queryFn: () =>
      api<KitchenList>('/nutrition/kitchen', {
        query: { meal, date, ...(unitId ? { unitId } : {}) },
      }),
    refetchInterval: 60_000,
  });

export const useWard = (unitId: string | undefined) =>
  useQuery({
    queryKey: [...KEY, 'ward', unitId],
    queryFn: () => api<{ items: WardLine[] }>(`/nutrition/wards/${unitId}`).then((r) => r.items),
    enabled: Boolean(unitId),
    refetchInterval: 60_000,
  });

export const useScreeningDue = () =>
  useQuery({
    queryKey: [...KEY, 'screening-due'],
    queryFn: () => api<{ items: ScreeningDue[] }>('/nutrition/screening-due').then((r) => r.items),
  });

export const usePatientNutrition = (patientId: string) =>
  useQuery({
    queryKey: ['patient', patientId, 'nutrition'],
    queryFn: () => api<PatientNutrition>(`/nutrition/patients/${patientId}`),
  });

export function useOrderDiet(patientId: string, onDone?: () => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ admissionId, ...body }: { admissionId: string } & Record<string, unknown>) =>
      api(`/nutrition/admissions/${admissionId}/diet`, { method: 'POST', body }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['patient', patientId, 'nutrition'] });
      void qc.invalidateQueries({ queryKey: KEY });
      onDone?.();
    },
  });
}

export function useScreen(patientId: string, onDone?: () => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { tool: string; answers: Record<string, unknown> }) =>
      api<Screening>(`/nutrition/patients/${patientId}/screenings`, { method: 'POST', body }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['patient', patientId, 'nutrition'] });
      void qc.invalidateQueries({ queryKey: KEY });
      onDone?.();
    },
  });
}

/** Today's date (local) as YYYY-MM-DD. */
export function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
