import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../api/client';
import type { Diagnosis, Encounter, Page, Prescription, Vitals } from '../../api/types';
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

type Tab = 'visits' | 'conditions' | 'medications' | 'vitals';

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
                      The visit note will appear here once your doctor signs it.
                    </p>
                  ) : null}
                  {e.addenda.map((a) => (
                    <div key={a.id} className="addendum">
                      <strong>Addendum</strong> — {a.reason}{' '}
                      <span className="muted">
                        ({a.authorName}, {formatDate(a.createdAt)})
                      </span>
                      <div>{a.content}</div>
                    </div>
                  ))}
                  {e.diagnoses.length > 0 && (
                    <p>
                      <strong>Diagnoses: </strong>
                      {e.diagnoses.map((dx) => `${dx.description} (${dx.icd10Code})`).join('; ')}
                    </p>
                  )}
                  {e.prescriptions.length > 0 && (
                    <p>
                      <strong>Prescribed: </strong>
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
          <EmptyState title="No visits recorded yet" />
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
          <Table caption="Diagnoses">
            <thead>
              <tr>
                <th>Condition</th>
                <th>Code</th>
                <th>Status</th>
                <th>Diagnosed</th>
                <th>Doctor</th>
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
                      <div className="muted">Resolved {formatDate(x.resolvedAt)}</div>
                    )}
                  </td>
                  <td>{formatDate(x.diagnosedAt)}</td>
                  <td>{x.doctorName}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <EmptyState title="No conditions recorded" />
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
          <Table caption="Medication history">
            <thead>
              <tr>
                <th>Medication</th>
                <th>Dose & frequency</th>
                <th>Route</th>
                <th>Period</th>
                <th>Status</th>
                <th>Prescriber</th>
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
                    {formatDate(p.startDate)} – {p.endDate ? formatDate(p.endDate) : 'ongoing'}
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
          <EmptyState title="No medications recorded" />
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
          <Table caption="Vital signs">
            <thead>
              <tr>
                <th>Date</th>
                <th className="num">Blood pressure</th>
                <th className="num">Heart rate</th>
                <th className="num">Temp.</th>
                <th className="num">SpO₂</th>
                <th className="num">Weight</th>
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
          <EmptyState title="No measurements recorded" />
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
        title="Medical history"
        subtitle="Visits, conditions and medications recorded by your doctors. Each entry shows who recorded it and where."
      />
      <Card>
        <Tabs
          label="Medical history sections"
          active={tab}
          onChange={setTab}
          tabs={[
            { id: 'visits', label: 'Visits' },
            { id: 'conditions', label: 'Conditions' },
            { id: 'medications', label: 'Medications' },
            { id: 'vitals', label: 'Measurements' },
          ]}
        />
        <TabPanel id={tab}>
          {tab === 'visits' && <Visits />}
          {tab === 'conditions' && <Conditions />}
          {tab === 'medications' && <Medications />}
          {tab === 'vitals' && <VitalsTab />}
        </TabPanel>
      </Card>
    </>
  );
}
