import { useState } from 'react';
import { Link } from 'react-router-dom';
import { displayName, useTemporaryRecords, type TemporaryRecord } from '../../api/identity';
import { useUser } from '../../auth/AuthContext';
import { Badge, Button, Card, EmptyState, PageHeader, QueryView, Table } from '../../components/ui';
import { formatDate, formatDateTime, humanize } from '../../format';
import { t } from '../../i18n';
import { ConfirmIdentityDialog, UnknownPatientDialog } from './IdentityDialogs';

/** Records with a temporary number: newborns and patients who could not be identified. */
export function TemporaryIdentitiesPage() {
  const user = useUser();
  const canRegister = user.role !== 'DIRECTOR';
  const chartBase =
    user.role === 'DOCTOR' ? '/doctor/patients' : user.role === 'NURSE' ? '/nurse/patients' : null;
  const [registering, setRegistering] = useState(false);
  const [confirming, setConfirming] = useState<TemporaryRecord | null>(null);
  const list = useTemporaryRecords();

  return (
    <>
      <PageHeader
        title={t('Temporary identities')}
        subtitle={t(
          'Newborns waiting for a national ID and patients who have not been identified yet',
        )}
        actions={
          canRegister ? (
            <Button onClick={() => setRegistering(true)}>{t('Register unknown patient')}</Button>
          ) : undefined
        }
      />
      <Card>
        <p className="muted">
          {t(
            'A temporary number (TMP…) keeps the care going until the real identity is known. Confirm the identity as soon as possible; if the person already has a record, the director merges the two.',
          )}
        </p>
        <QueryView query={list}>
          {(items) =>
            items.length === 0 ? (
              <EmptyState title={t('No temporary records')} />
            ) : (
              <Table caption={t('Temporary records')}>
                <thead>
                  <tr>
                    <th>{t('Patient')}</th>
                    <th>{t('Kind')}</th>
                    <th>{t('Temporary number')}</th>
                    <th>{t('Details')}</th>
                    <th>{t('Registered')}</th>
                    <th>
                      <span className="sr-only">{t('Actions')}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((r) => (
                    <tr key={r.id}>
                      <td>
                        {chartBase ? (
                          <Link to={`${chartBase}/${r.id}`}>{displayName(r)}</Link>
                        ) : (
                          displayName(r)
                        )}
                        <div className="muted">{humanize(r.sex)}</div>
                      </td>
                      <td>
                        {r.temporaryIdentity === 'NEWBORN' ? (
                          <Badge tone="info">{t('Newborn')}</Badge>
                        ) : (
                          <Badge tone="warning">{t('Unidentified')}</Badge>
                        )}
                      </td>
                      <td>
                        <code>{r.nationalId}</code>
                      </td>
                      <td>
                        {r.temporaryIdentity === 'NEWBORN' ? (
                          <>
                            {t('Mother: {name}', { name: r.motherName ?? '—' })}
                            {r.bornAt && (
                              <div className="muted">
                                {t('Born {date}', { date: formatDateTime(r.bornAt) })}
                              </div>
                            )}
                          </>
                        ) : (
                          <>
                            {r.identityNote}
                            <div className="muted">
                              {t('Estimated year of birth {year}', {
                                year: r.dateOfBirth.slice(0, 4),
                              })}
                            </div>
                          </>
                        )}
                      </td>
                      <td>{formatDate(r.createdAt)}</td>
                      <td>
                        <Button size="sm" variant="secondary" onClick={() => setConfirming(r)}>
                          {r.temporaryIdentity === 'NEWBORN'
                            ? t('Enter national ID')
                            : t('Confirm identity')}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )
          }
        </QueryView>
      </Card>
      {canRegister && (
        <UnknownPatientDialog open={registering} onClose={() => setRegistering(false)} />
      )}
      <ConfirmIdentityDialog patient={confirming} onClose={() => setConfirming(null)} />
    </>
  );
}
