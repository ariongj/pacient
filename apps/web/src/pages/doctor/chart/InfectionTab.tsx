import { EmptyState } from '../../../components/ui';
import { t } from '../../../i18n';

export function InfectionTab({ patientId: _patientId }: { patientId: string }) {
  return <EmptyState title={t('Infection prevention')} />;
}
