import { EmptyState } from '../../../components/ui';
import { t } from '../../../i18n';

export function DirectivesTab({ patientId: _patientId }: { patientId: string }) {
  return <EmptyState title={t('Wishes and directives')} />;
}
