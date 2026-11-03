import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../../api/client';
import { deliveryLabel, gestationLabel, usePatientBirth } from '../../../api/identity';
import { Badge, Button, Card, DefinitionList, EmptyState, QueryView, Table } from '../../../components/ui';
import { formatDateTime, formatNumber, humanize } from '../../../format';
import { t } from '../../../i18n';
import { RegisterBirthDialog } from '../../births/IdentityDialogs';
import { useChartRole } from './shared';

interface Demographics {
  id: string;
  nationalId: string;
  firstName: string;
  lastName: string;
  dateOfBirth: string;
  sex: string;
}

/** Birth details for a newborn; births and "Register birth" for a mother. */
export function BirthsTab({ patientId }: { patientId: string }) {
  const { base, isDoctor, isNurse } = useChartRole();
  const [registering, setRegistering] = useState(false);
  const birth = usePatientBirth(patientId);
  const patient = useQuery({
    queryKey: ['patient', patientId, 'demographics'],
    queryFn: () => api<Demographics>(`/patients/${patientId}`),
  });
  const canRegister = (isDoctor || isNurse) && patient.data && patient.data.sex !== 'MALE';

  return (
    <QueryView query={birth}>
      {({ asNewborn, asMother }) => (
        <div className="stack">
          {asNewborn && (
            <Card title={t('Birth')}>
              <DefinitionList
                items={[
                  [t('Born'), formatDateTime(asNewborn.bornAt)],
                  [t('Place of birth'), asNewborn.facilityName],
                  [
                    t('Mother'),
                    <Link key="m" to={`${base}/patients/${asNewborn.motherId}?tab=births`}>
                      {asNewborn.motherName}
                    </Link>,
                  ],
                  [t('Delivery'), deliveryLabel(asNewborn.deliveryType)],
                  [t('Gestation'), gestationLabel(asNewborn.gestationalWeeks, asNewborn.gestationalDays)],
                  [t('Birth weight'), t('{grams} g', { grams: formatNumber(asNewborn.birthWeightGrams) })],
                  [t('Length'), asNewborn.lengthCm ? t('{cm} cm', { cm: asNewborn.lengthCm }) : '—'],
                  [
                    t('Head circumference'),
                    asNewborn.headCircumferenceCm ? t('{cm} cm', { cm: asNewborn.headCircumferenceCm }) : '—',
                  ],
                  [
                    t('Apgar (1 / 5 / 10 min)'),
                    `${asNewborn.apgar1} / ${asNewborn.apgar5} / ${asNewborn.apgar10 ?? '—'}`,
                  ],
                  [t('Birth order'), String(asNewborn.birthOrder)],
                  [t('Attended by'), asNewborn.attendantName],
                  [
                    t('Civil registration'),
                    asNewborn.civilRegisteredAt ? (
                      <Badge key="c" tone="success">
                        {t('Registered')}
                      </Badge>
                    ) : (
                      <Badge key="c" tone="warning">
                        {t('Awaiting national ID')}
                      </Badge>
                    ),
                  ],
                ]}
              />
              {asNewborn.birthWeightGrams < 2500 && <Badge tone="warning">{t('Low birth weight')}</Badge>}{' '}
              {asNewborn.gestationalWeeks < 37 && <Badge tone="warning">{t('Preterm')}</Badge>}
              {asNewborn.notes && <p style={{ whiteSpace: 'pre-wrap' }}>{asNewborn.notes}</p>}
            </Card>
          )}
          {(!asNewborn || asMother.length > 0) && (
            <Card
              title={t('Births')}
              actions={
                canRegister ? (
                  <Button size="sm" onClick={() => setRegistering(true)}>
                    {t('Register birth')}
                  </Button>
                ) : undefined
              }
            >
              {asMother.length === 0 ? (
                <EmptyState title={t('No births recorded')} />
              ) : (
                <Table caption={t('Births')}>
                  <thead>
                    <tr>
                      <th>{t('Born')}</th>
                      <th>{t('Baby')}</th>
                      <th>{t('Delivery')}</th>
                      <th>{t('Weight')}</th>
                      <th>{t('Apgar 1 / 5')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {asMother.map((b) => (
                      <tr key={b.id}>
                        <td>{formatDateTime(b.bornAt)}</td>
                        <td>
                          <Link to={`${base}/patients/${b.newbornId}?tab=births`}>{b.newbornName}</Link>
                          <div className="muted">
                            {humanize(b.newbornSex)} · <code>{b.newbornNationalId}</code>
                          </div>
                        </td>
                        <td>{deliveryLabel(b.deliveryType)}</td>
                        <td>{t('{grams} g', { grams: formatNumber(b.birthWeightGrams) })}</td>
                        <td>
                          {b.apgar1} / {b.apgar5}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </Card>
          )}
          {canRegister && patient.data && (
            <RegisterBirthDialog open={registering} onClose={() => setRegistering(false)} mother={patient.data} />
          )}
        </div>
      )}
    </QueryView>
  );
}
