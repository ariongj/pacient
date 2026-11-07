import { gestationLabel, outcomeLabel, useMyPregnancy, type Pregnancy } from '../../api/maternity';
import {
  Alert,
  Badge,
  Card,
  DefinitionList,
  EmptyState,
  PageHeader,
  QueryView,
  Table,
} from '../../components/ui';
import { formatDate } from '../../format';
import { t } from '../../i18n';
import { KeyTestsTable, ScheduleTable, VisitsTable } from '../doctor/chart/PregnancyTab';

/** Short, general advice – the same for every mother; the care team gives personal advice. */
const ADVICE = [
  'Take folic acid every day until 12 weeks, and iron if your doctor recommends it.',
  'Come to every check-up and bring your pregnancy card.',
  'Contact the maternity unit at once for bleeding, fluid leaking, severe headache, blurred vision, swelling of the face or hands, or if the baby moves less than usual.',
  'Do not smoke or drink alcohol; ask your doctor before taking any medicine.',
];

function Current({ p }: { p: Pregnancy }) {
  const upcoming = p.schedule.find((c) => c.state === 'DUE' || c.state === 'UPCOMING');
  return (
    <>
      <Card title={t('Your pregnancy – {ga}', { ga: gestationLabel(p.gestation) })}>
        {p.postTerm && (
          <Alert tone="warning">
            {t('You are past your due date. Contact your maternity unit if you have not already.')}
          </Alert>
        )}
        <DefinitionList
          items={[
            [t('Due date'), formatDate(p.eddDate)],
            [t('Next check-up'), p.nextVisitDate ? formatDate(p.nextVisitDate) : '—'],
            [
              t('Next recommended contact'),
              upcoming
                ? t('Week {week}, around {date}', {
                    week: upcoming.week,
                    date: formatDate(upcoming.targetDate),
                  })
                : '—',
            ],
            [
              t('Care'),
              p.riskLevel === 'HIGH'
                ? t('Your care includes the specialist maternity team.')
                : t('Routine antenatal care.'),
            ],
            [t('Booking facility'), p.facilityName],
          ]}
        />
      </Card>
      <Card title={t('Your check-ups')}>
        <VisitsTable pregnancy={p} showNotes={false} />
      </Card>
      <div
        style={{
          display: 'grid',
          gap: '1rem',
          gridTemplateColumns: 'repeat(auto-fit, minmax(min(320px, 100%), 1fr))',
        }}
      >
        <Card title={t('Recommended contacts')}>
          <ScheduleTable pregnancy={p} />
        </Card>
        <Card title={t('Tests in pregnancy')}>
          <KeyTestsTable pregnancy={p} />
        </Card>
      </div>
      <Card title={t('Good to know')}>
        <ul>
          {ADVICE.map((a) => (
            <li key={a}>{t(a)}</li>
          ))}
        </ul>
      </Card>
    </>
  );
}

/** The mother's pregnancy record in the portal: due date, check-ups and recommended contacts. */
export function PortalPregnancyPage() {
  const query = useMyPregnancy();
  return (
    <div className="stack">
      <PageHeader
        title={t('My pregnancy')}
        subtitle={t('Your due date, check-ups and the tests recommended in pregnancy.')}
      />
      <QueryView query={query}>
        {(data) => {
          if (data.confidentialFromGuardians) {
            return (
              <Card>
                <EmptyState title={t('Not shown to guardians')}>
                  {t(
                    'Pregnancy records of a young person are confidential and are not shown in a guardian’s portal.',
                  )}
                </EmptyState>
              </Card>
            );
          }
          const current = data.items.find((p) => p.status === 'ONGOING');
          const earlier = data.items.filter((p) => p.status !== 'ONGOING');
          return (
            <>
              {current ? (
                <Current p={current} />
              ) : (
                <Card>
                  <EmptyState title={t('No ongoing pregnancy recorded')}>
                    {t('Your pregnancy is recorded here after your first antenatal check-up.')}
                  </EmptyState>
                </Card>
              )}
              {earlier.length > 0 && (
                <Card title={t('Earlier pregnancies')}>
                  <Table caption={t('Earlier pregnancies')}>
                    <thead>
                      <tr>
                        <th>{t('Due date')}</th>
                        <th>{t('Outcome')}</th>
                        <th>{t('Date')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {earlier.map((p) => (
                        <tr key={p.id}>
                          <td>{formatDate(p.eddDate)}</td>
                          <td>
                            <Badge>{outcomeLabel(p.status)}</Badge>
                          </td>
                          <td>{formatDate(p.endedAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                </Card>
              )}
            </>
          );
        }}
      </QueryView>
    </div>
  );
}
