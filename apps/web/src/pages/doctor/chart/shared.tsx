import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type RequestOptions } from '../../../api/client';
import type { Encounter } from '../../../api/types';
import { useUser } from '../../../auth/AuthContext';
import { SelectField } from '../../../components/ui';
import { formatDate, humanize } from '../../../format';
import { t } from '../../../i18n';

/** Mutation against a patient's chart that refreshes every cached view of that chart. */
export function useChartMutation<TVars>(
  patientId: string,
  request: (vars: TVars) => { path: string } & RequestOptions,
  onDone?: () => void,
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: TVars) => {
      const { path, ...opts } = request(vars);
      return api<unknown>(`/patients/${patientId}${path}`, opts);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['patient', patientId] });
      void qc.invalidateQueries({ queryKey: ['worklist'] });
      onDone?.();
    },
  });
}

/** Optional link from a clinical entry to one of the patient's recent visits. */
export function EncounterSelect({ encounters }: { encounters: Encounter[] }) {
  return (
    <SelectField
      label={t('Linked visit')}
      name="encounterId"
      placeholder={t('Not linked to a visit')}
      options={encounters.map((e) => ({
        value: e.id,
        label: `${formatDate(e.startedAt)} · ${humanize(e.type)} · ${e.reason}`,
      }))}
    />
  );
}

/** Converts named numeric fields of a form-values object into numbers (omitting blanks). */
export function numbers(values: Record<string, string>, keys: string[]) {
  const out: Record<string, number> = {};
  for (const k of keys) {
    const v = values[k];
    if (v !== undefined && v !== '') out[k] = Number(v);
  }
  return out;
}

/**
 * Which clinical workspace is viewing the chart. Doctors author diagnoses, prescriptions, notes and
 * results; nurses record observations, reported allergies, vaccinations, doses and tasks. The API
 * enforces this – the UI only hides actions that would be refused.
 */
export function useChartRole() {
  const user = useUser();
  const isDoctor = user.role === 'DOCTOR';
  return { isDoctor, isNurse: user.role === 'NURSE', base: isDoctor ? '/doctor' : '/nurse' };
}
