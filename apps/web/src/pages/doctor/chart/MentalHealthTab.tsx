import { EmptyState } from '../../../components/ui';
import { t } from '../../../i18n';

export function MentalHealthTab({ patientId: _patientId }: { patientId: string }) {
  return <EmptyState title={t('Mental health safeguards')} />;
}
