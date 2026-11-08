import { EmptyState } from '../../../components/ui';
import { t } from '../../../i18n';

export function HomeCareTab({ patientId: _patientId }: { patientId: string }) {
  return <EmptyState title={t('Home care')} />;
}
