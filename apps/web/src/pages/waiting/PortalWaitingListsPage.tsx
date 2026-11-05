import {
  kindLabel,
  priorityLabel,
  removalLabel,
  specialtyLabel,
  useMyWaiting,
  type MyWaitingEntry,
} from '../../api/waiting';
import { useAuth } from '../../auth/AuthContext';
import {
  Alert,
  Card,
  DefinitionList,
  EmptyState,
  PageHeader,
  QueryView,
} from '../../components/ui';
import { formatDate, formatDateTime } from '../../format';
import { t } from '../../i18n';
import { usePatientId } from '../patient/shared';
import { WaitingStatusBadge } from './WaitingComponents';

/**
 * The patient's (or their child's) places on elective waiting lists. No queue positions are
 * shown: the order depends on clinical priority, not on the date alone.
 */
export function PortalWaitingListsPage() {
  const { acting } = useAuth();
  const patientId = usePatientId();
  const entries = useMyWaiting(patientId);
  return (
    <>
      <PageHeader
        title={t('My waiting lists')}
        subtitle={
          acting
            ? t('Planned treatments your family member is waiting for.')
            : t('Planned operations and specialist appointments you are waiting for.')
        }
      />
      <Alert tone="info">
        {t(
          'Patients are treated in order of clinical priority. Each priority has a maximum waiting time; the target date shows when you should be treated at the latest. To postpone or if your condition changes, contact the facility or your doctor.',
        )}
      </Alert>
      <QueryView query={entries}>
        {(items) =>
          items.length === 0 ? (
            <EmptyState title={t('You are not on any waiting list')} />
          ) : (
            <div className="stack">
              {items.map((e) => (
                <EntryCard key={e.id} e={e} />
              ))}
            </div>
          )
        }
      </QueryView>
    </>
  );
}

function EntryCard({ e }: { e: MyWaitingEntry }) {
  const active = ['WAITING', 'SCHEDULED', 'SUSPENDED'].includes(e.status);
  return (
    <Card title={e.procedureName} actions={<WaitingStatusBadge status={e.status} />}>
      <DefinitionList
        items={[
          [t('Facility'), e.facilityName],
          [t('Specialty'), specialtyLabel(e.specialty)],
          [t('Type'), kindLabel(e.kind)],
          [t('Priority'), priorityLabel(e.priority)],
          [t('Added to the list'), formatDate(e.addedAt)],
          ...(active
            ? ([
                [
                  t('Waiting time'),
                  t('{days} of {max} days', { days: e.waitingDays, max: e.maxDays }),
                ],
                [t('Target date'), formatDate(e.targetDate)],
              ] as [string, string][])
            : []),
          ...(e.suspendedDays
            ? ([[t('Days postponed at your request'), String(e.suspendedDays)]] as [
                string,
                string,
              ][])
            : []),
          ...(e.scheduledFor
            ? ([[t('Scheduled for'), formatDateTime(e.scheduledFor)]] as [string, string][])
            : []),
          ...(e.completedAt
            ? ([[t('Treated on'), formatDate(e.completedAt)]] as [string, string][])
            : []),
          ...(e.removedReason
            ? ([[t('Reason for removal'), removalLabel(e.removedReason)]] as [string, string][])
            : []),
        ]}
      />
    </Card>
  );
}
