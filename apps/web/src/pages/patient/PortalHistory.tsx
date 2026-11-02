import { t } from '../../i18n';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../api/client';
import type {
  Diagnosis,
  Encounter,
  Immunization,
  Page,
  Prescription,
  Vitals,
} from '../../api/types';
import {
  Card,
  EmptyState,
  PageHeader,
  Pagination,
  QueryView,
  StatusBadge,
  TabPanel,
  Table,
  Tabs,
} from '../../components/ui';
import { formatDate, formatDateTime, humanize } from '../../format';
import { usePatientId } from './shared';

type Tab = 'visits' | 'conditions' | 'medications' | 'vaccinations' | 'vitals';

function Visits() {
  const id = usePatientId();
  const [page, setPage] = useState(1);
  const q = useQuery({
    queryKey: ['patient', id, 'encounters', page],
    queryFn: () =>
      api<Page<Encounter>>(`/patients/${id}/encounters`, { query: { page, pageSize: 10 } }),
  });
  return (
    <QueryView query={q}>
      {(d) =>
        d.items.length ? (
          <>
            <ol className="timeline">
              {d.items.map((e) => (
                <li key={e.id}>
                  <div className="timeline-date">{formatDateTime(e.startedAt)}</div>
                  <div className="row-between">
                    <h3>{e.reason}</h3>
                    <span className="row">
                      <StatusBadge value={e.type} />
                    </span>
                  </div>
                  <div className="muted">
                    {e.doctorName}
                    {e.doctorSpecialty ? ` (${e.doctorSpecialty})` : ''} · {e.facilityName}
                  </div>
                  {e.notes ? (
                    <div className="note">{e.notes}</div>
                  ) : e.noteStatus === 'DRAFT' ? (
                    <p className="muted">
                      {t('The visit note will appear here once your doctor signs it.')}
                    </p>
                  ) : null}
                  {e.addenda.map((a) => (
                    <div key={a.id} className="addendum">
                      <strong>{t('Addendum')}</strong> — {a.reason}{' '}
                      <span className="muted">
                        ({a.authorName}, {formatDate(a.createdAt)})
                      </span>
                      <div>{a.content}</div>
                    </div>
                  ))}
                  {e.diagnoses.length > 0 && (
                    <p>
                      <strong>{t('Diagnoses:')} </strong>
                      {e.diagnoses.map((dx) => `${dx.description} (${dx.icd10Code})`).join('; ')}
                    </p>
                  )}
                  {e.prescriptions.length > 0 && (
                    <p>
                      <strong>{t('Prescribed:')} </strong>
                      {e.prescriptions
                        .map((p) => `${p.medication} ${p.dosage}, ${p.frequency}`)
                        .join('; ')}
                    </p>
                  )}
                </li>
              ))}
            </ol>
            <Pagination page={d.page} totalPages={d.totalPages} onChange={setPage} />
          </>
        ) : (
          <EmptyState title={t('No visits recorded yet')} />
        )
      }
    </QueryView>
  );
}

function Conditions() {
  const id = usePatientId();
  const q = useQuery({
    queryKey: ['patient', id, 'diagnoses'],
    queryFn: () => api<{ items: Diagnosis[] }>(`/patients/${id}/diagnoses`),
  });
  return (
    <QueryView query={q}>
      {(d) =>
        d.items.length ? (
          <Table caption={t('Diagnoses')}>
            <thead>
              <tr>
                <th>{t('Condition')}</th>
                <th>{t('Code')}</th>
                <th>{t('Status')}</th>
                <th>{t('Diagnosed')}</th>
                <th>{t('Doctor')}</th>
              </tr>
            </thead>
            <tbody>
              {d.items.map((x) => (
                <tr key={x.id}>
                  <td>{x.description}</td>
                  <td>
                    <code>{x.icd10Code}</code>
                  </td>
                  <td>
                    <StatusBadge value={x.status} />
                    {x.resolvedAt && (
                      <div className="muted">
                        {t('Resolved {date}', { date: formatDate(x.resolvedAt) })}
                      </div>
                    )}
                  </td>
                  <td>{formatDate(x.diagnosedAt)}</td>
                  <td>{x.doctorName}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <EmptyState title={t('No conditions recorded')} />
        )
      }
    </QueryView>
  );
}

function Medications() {
  const id = usePatientId();
  const q = useQuery({
    queryKey: ['patient', id, 'prescriptions'],
    queryFn: () => api<{ items: Prescription[] }>(`/patients/${id}/prescriptions`),
  });
  return (
    <QueryView query={q}>
      {(d) =>
        d.items.length ? (
          <Table caption={t('Medication history')}>
            <thead>
              <tr>
                <th>{t('Medication')}</th>
                <th>{t('Dose & frequency')}</th>
                <th>{t('Route')}</th>
                <th>{t('Period')}</th>
                <th>{t('Status')}</th>
                <th>{t('Prescriber')}</th>
              </tr>
            </thead>
            <tbody>
              {d.items.map((p) => (
                <tr key={p.id}>
                  <td>
                    <strong>{p.medication}</strong>
                    {p.instructions && <div className="muted">{p.instructions}</div>}
                  </td>
                  <td>
                    {p.dosage}, {p.frequency}
                  </td>
                  <td>{humanize(p.route)}</td>
                  <td>
                    {formatDate(p.startDate)} – {p.endDate ? formatDate(p.endDate) : t('ongoing')}
                  </td>
                  <td>
                    <StatusBadge value={p.status} />
                  </td>
                  <td>{p.doctorName}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <EmptyState title={t('No medications recorded')} />
        )
      }
    </QueryView>
  );
}

function Vaccinations() {
  const id = usePatientId();
  const q = useQuery({
    queryKey: ['patient', id, 'immunizations'],
    queryFn: () => api<{ items: Immunization[] }>(`/patients/${id}/immunizations`),
  });
  return (
    <QueryView query={q}>
      {(d) =>
        d.items.length ? (
          <Table caption={t('Vaccinations')}>
            <thead>
              <tr>
                <th>{t('Vaccine')}</th>
                <th className="num">{t('Dose')}</th>
                <th>{t('Date')}</th>
                <th>{t('Facility')}</th>
                <th>{t('Given by')}</th>
                <th>{t('Lot')}</th>
                <th>{t('Site')}</th>
              </tr>
            </thead>
            <tbody>
              {d.items.map((v) => (
                <tr key={v.id}>
                  <td>
                    <strong>{v.vaccine}</strong>
                    {v.notes && <div className="muted">{v.notes}</div>}
                  </td>
                  <td className="num">{v.doseNumber ?? '—'}</td>
                  <td>{formatDate(v.administeredAt)}</td>
                  <td>{v.facilityName}</td>
                  <td>{v.administeredBy}</td>
                  <td>{v.lotNumber ?? '—'}</td>
                  <td>{v.site ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <EmptyState title={t('No vaccinations recorded')} />
        )
      }
    </QueryView>
  );
}

function VitalsTab() {
  const id = usePatientId();
  const q = useQuery({
    queryKey: ['patient', id, 'vitals'],
    queryFn: () => api<{ items: Vitals[] }>(`/patients/${id}/vitals`),
  });
  return (
    <QueryView query={q}>
      {(d) =>
        d.items.length ? (
          <Table caption={t('Vital signs')}>
            <thead>
              <tr>
                <th>{t('Date')}</th>
                <th className="num">{t('Blood pressure')}</th>
                <th className="num">{t('Heart rate')}</th>
                <th className="num">{t('Temp.')}</th>
                <th className="num">SpO₂</th>
                <th className="num">{t('Weight')}</th>
              </tr>
            </thead>
            <tbody>
              {d.items.map((v) => (
                <tr key={v.id}>
                  <td>{formatDate(v.recordedAt)}</td>
                  <td className="num">{v.systolic ? `${v.systolic}/${v.diastolic} mmHg` : '—'}</td>
                  <td className="num">{v.heartRate ? `${v.heartRate} bpm` : '—'}</td>
                  <td className="num">{v.temperatureC ? `${v.temperatureC} °C` : '—'}</td>
                  <td className="num">{v.oxygenSaturation ? `${v.oxygenSaturation}%` : '—'}</td>
                  <td className="num">{v.weightKg ? `${v.weightKg} kg` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <EmptyState title={t('No measurements recorded')} />
        )
      }
    </QueryView>
  );
}

export function PortalHistory() {
  const [tab, setTab] = useState<Tab>('visits');
  return (
    <>
      <PageHeader
        title={t('Medical history')}
        subtitle={t(
          'Visits, conditions and medications recorded by your doctors. Each entry shows who recorded it and where.',
        )}
      />
      <Card>
        <Tabs
          label={t('Medical history sections')}
          active={tab}
          onChange={setTab}
          tabs={[
            { id: 'visits', label: t('Visits') },
            { id: 'conditions', label: t('Conditions') },
            { id: 'medications', label: t('Medications') },
            { id: 'vaccinations', label: t('Vaccinations') },
            { id: 'vitals', label: t('Measurements') },
          ]}
        />
        <TabPanel id={tab}>
          {tab === 'visits' && <Visits />}
          {tab === 'conditions' && <Conditions />}
          {tab === 'medications' && <Medications />}
          {tab === 'vaccinations' && <Vaccinations />}
          {tab === 'vitals' && <VitalsTab />}
        </TabPanel>
      </Card>
    </>
  );
}
