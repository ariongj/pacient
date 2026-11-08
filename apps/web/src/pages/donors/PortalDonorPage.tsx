import { donorGroup, useDonorsAction, useMyDonorCard, type MyDonorCard } from '../../api/donors';
import {
  Alert,
  Badge,
  Card,
  DefinitionList,
  EmptyState,
  ErrorAlert,
  PageHeader,
  QueryView,
  Table,
} from '../../components/ui';
import { formatDate, formatDateTime } from '../../format';
import { t, tn } from '../../i18n';
import './donors.css';

/** The donor's own card: group, donations and when they can give blood again – never results. */
export function PortalDonorPage() {
  const card = useMyDonorCard();
  return (
    <>
      <PageHeader
        title={t('Blood donation')}
        subtitle={t('Your blood donor card: your donations and when you can give blood again.')}
      />
      <QueryView query={card}>
        {(c) => (c.registered ? <DonorCard card={c} /> : <NotRegistered />)}
      </QueryView>
    </>
  );
}

function NotRegistered() {
  return (
    <Card>
      <EmptyState title={t('You are not registered as a blood donor')}>
        {t(
          'Healthy adults aged 18 to 60 can become donors. Bring your ID card to a blood bank; the staff will check that you can donate.',
        )}
      </EmptyState>
    </Card>
  );
}

function DonorCard({ card }: { card: MyDonorCard }) {
  const consent = useDonorsAction<{ contactConsent: boolean }>(() => '/mine', 'PATCH');
  const today = new Date().toISOString().slice(0, 10);
  const canDonate =
    card.state === 'ACTIVE' && card.nextEligibleDate && card.nextEligibleDate <= today;
  return (
    <div className="stack">
      <Card title={t('My donor card')}>
        <div className="donor-head">
          <div>
            <div className="muted small">{t('Blood group')}</div>
            <div className="donor-card-group">
              {card.group ? donorGroup(card.group.abo, card.group.rhD) : '—'}
            </div>
            {!card.group && (
              <div className="muted small">{t('Confirmed after your first tested donation')}</div>
            )}
          </div>
          <DefinitionList
            items={[
              [
                t('Donations'),
                tn(card.donationCount ?? 0, '{count} donation', '{count} donations'),
              ],
              [t('First donation'), formatDate(card.firstDonationAt)],
              [t('Last donation'), formatDate(card.lastDonationAt)],
            ]}
          />
        </div>
        {card.state === 'CONTACT_BLOOD_BANK' ? (
          <Alert tone="info" title={t('Please contact the blood bank')}>
            {t(
              'Before your next donation, please talk to the blood bank staff. They will explain everything to you in person.',
            )}
          </Alert>
        ) : card.state === 'TEMPORARILY_DEFERRED' ? (
          <Alert
            tone="warning"
            title={t('You can donate again from {date}', {
              date: formatDate(card.nextEligibleDate ?? card.deferredUntil),
            })}
          >
            {t('This is a temporary pause. Thank you for your understanding.')}
          </Alert>
        ) : canDonate ? (
          <Alert tone="success" title={t('You can donate blood now')}>
            {t(
              'If you feel well, you are welcome at the blood bank. Eat and drink before you come.',
            )}
          </Alert>
        ) : (
          <Alert
            tone="info"
            title={t('You can donate again from {date}', {
              date: formatDate(card.nextEligibleDate),
            })}
          />
        )}
        {(card.donationCount ?? 0) > 0 && (
          <p>
            <Badge tone="success">{t('Thank you')}</Badge>{' '}
            {t('Your donations may have helped up to {n} people.', {
              n: (card.donationCount ?? 0) * 3,
            })}
          </p>
        )}
      </Card>
      <Card title={t('Appeals')}>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={consent.variables?.contactConsent ?? card.contactConsent ?? false}
            disabled={consent.isPending}
            onChange={(e) => consent.mutate({ contactConsent: e.target.checked })}
          />
          {t('Notify me when blood of my group is needed (at most once every 4 weeks)')}
        </label>
        <ErrorAlert error={consent.error} />
      </Card>
      <Card title={t('My visits')}>
        {(card.donations ?? []).length === 0 ? (
          <EmptyState title={t('No visits yet')} />
        ) : (
          <Table caption={t('My visits')}>
            <thead>
              <tr>
                <th>{t('Date')}</th>
                <th>{t('Blood bank')}</th>
                <th>{t('Result|visit')}</th>
              </tr>
            </thead>
            <tbody>
              {card.donations!.map((d) => (
                <tr key={d.attendedAt}>
                  <td>{formatDateTime(d.attendedAt)}</td>
                  <td>{d.facilityName}</td>
                  <td>{d.outcome === 'COMPLETED' ? t('Blood donated') : t('No blood taken')}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}
