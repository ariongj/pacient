import { EmptyState } from '../../../components/ui';
import { t } from '../../../i18n';

export function ScreeningTab({ patientId: _patientId }: { patientId: string }) {
  return <EmptyState title={t('Screening|cancer')} />;
}
