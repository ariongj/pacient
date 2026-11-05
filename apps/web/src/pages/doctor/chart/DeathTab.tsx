import { EmptyState } from '../../../components/ui';
import { t } from '../../../i18n';

export function DeathTab({ patientId: _patientId }: { patientId: string }) {
  return <EmptyState title={t('Death certificate')} />;
}
