import { EmptyState } from '../../../components/ui';
import { t } from '../../../i18n';

export function OncologyTab({ patientId: _patientId }: { patientId: string }) {
  return <EmptyState title={t('Cancer registry')} />;
}
