import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  deliveryLabel,
  gestationLabel,
  useBirths,
  useTemporaryRecords,
  type TemporaryRecord,
} from '../../api/identity';
import { useUser } from '../../auth/AuthContext';
import { Badge, Button, Card, EmptyState, PageHeader, QueryView, Table } from '../../components/ui';
import { formatDateTime, formatNumber, humanize } from '../../format';
import { t } from '../../i18n';
import { ConfirmIdentityDialog, RegisterBirthDialog } from './IdentityDialogs';

/** Births at the facility and newborns still waiting for a national ID. */
export function BirthsPage() {
  const user = useUser();
  const clinician = user.role === 'DOCTOR' || user.role === 'NURSE';
  const chartBase = user.role === 'DOCTOR' ? '/doctor/patients' : '/nurse/patients';
  const [registering, setRegistering] = useState(false);
  const [confirming, setConfirming] = useState<TemporaryRecord | null>(null);
  const births = useBirths();
  const temporary = useTemporaryRecords();

  return (
    <>
      <PageHeader
        title={t('Births')}
        subtitle={t('Babies born at your facility in the last 30 days')}
        actions={
          clinician ? (
            <Button onClick={() => setRegistering(true)}>{t('Register birth')}</Button>
          ) : undefined
        }
      />

      <Card title={t('Awaiting civil registration')}>
        <p className="muted">
          {t(
            'Newborns keep a temporary number until the civil registry issues a national ID. Enter it here when the parents bring the birth certificate.',
          )}
        </p>
        <QueryView query={temporary}>
          {(items) => {
            const newborns = items.filter((i) => i.temporaryIdentity === 'NEWBORN');
            return newborns.length === 0 ? (
              <EmptyState title={t('All newborns have a national ID')} />
            ) : (
              <Table caption={t('Newborns awaiting civil registration')}>
                <thead>
                  <tr>
                    <th>{t('Baby')}</th>
                    <th>{t('Mother')}</th>
                    <th>{t('Born')}</th>
                    <th>{t('Temporary number')}</th>
                    <th>
                      <span className="sr-only">{t('Actions')}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {newborns.map((n) => (
                    <tr key={n.id}>
                      <td>
                        {clinician ? (
                          <Link to={`${chartBase}/${n.id}`}>
                            {n.firstName} {n.lastName}
                          </Link>
                        ) : (
                          `${n.firstName} ${n.lastName}`
                        )}
                        <div className="muted">{humanize(n.sex)}</div>
                      </td>
                      <td>{n.motherName ?? '—'}</td>
                      <td>{n.bornAt ? formatDateTime(n.bornAt) : '—'}</td>
                      <td>
                        <code>{n.nationalId}</code>
                      </td>
                      <td>
                        <Button size="sm" variant="secondary" onClick={() => setConfirming(n)}>
                          {t('Enter national ID')}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            );
          }}
        </QueryView>
      </Card>

      <Card title={t('Births – last 30 days')}>
        <QueryView query={births}>
          {({ items, clinical }) =>
            items.length === 0 ? (
              <EmptyState title={t('No births registered')} />
            ) : (
              <Table caption={t('Births')}>
                <thead>
                  <tr>
                    <th>{t('Born')}</th>
                    <th>{t('Baby')}</th>
                    <th>{t('Mother')}</th>
                    {clinical && (
                      <>
                        <th>{t('Weight')}</th>
                        <th>{t('Apgar 1 / 5')}</th>
                        <th>{t('Gestation')}</th>
                        <th>{t('Delivery')}</th>
                      </>
                    )}
                    <th>{t('Civil registration')}</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((b) => (
                    <tr key={b.id}>
                      <td>{formatDateTime(b.bornAt)}</td>
                      <td>
                        {clinician ? (
                          <Link to={`${chartBase}/${b.newbornId}`}>
                            {b.newbornFirstName} {b.newbornLastName}
                          </Link>
                        ) : (
                          `${b.newbornFirstName} ${b.newbornLastName}`
                        )}
                        <div className="muted">
                          {humanize(b.newbornSex)}
                          {b.birthOrder > 1 && ` · ${t('Twin {n}', { n: b.birthOrder })}`}
                        </div>
                      </td>
                      <td>{b.motherName}</td>
                      {clinical && (
                        <>
                          <td>
                            {t('{grams} g', { grams: formatNumber(b.birthWeightGrams ?? 0) })}
                            {(b.birthWeightGrams ?? 0) < 2500 && (
                              <div>
                                <Badge tone="warning">{t('Low birth weight')}</Badge>
                              </div>
                            )}
                          </td>
                          <td>
                            {b.apgar1} / {b.apgar5}
                          </td>
                          <td>
                            {gestationLabel(b.gestationalWeeks ?? 0, b.gestationalDays ?? 0)}
                            {(b.gestationalWeeks ?? 40) < 37 && (
                              <div>
                                <Badge tone="warning">{t('Preterm')}</Badge>
                              </div>
                            )}
                          </td>
                          <td>{b.deliveryType ? deliveryLabel(b.deliveryType) : '—'}</td>
                        </>
                      )}
                      <td>
                        {b.civilRegisteredAt ? (
                          <Badge tone="success">{t('Registered')}</Badge>
                        ) : (
                          <Badge tone="warning">{t('Temporary number')}</Badge>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )
          }
        </QueryView>
      </Card>

      {clinician && (
        <RegisterBirthDialog open={registering} onClose={() => setRegistering(false)} />
      )}
      <ConfirmIdentityDialog patient={confirming} onClose={() => setConfirming(null)} />
    </>
  );
}
