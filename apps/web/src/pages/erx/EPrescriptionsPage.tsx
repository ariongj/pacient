import { Link } from 'react-router-dom';
import {
  atcGroupLabel,
  suppliesLabel,
  useErxStats,
  useMyEPrescriptions,
  type ErxStats,
  type Suppressible,
} from '../../api/erx';
import { useUser } from '../../auth/AuthContext';
import { RankedBars } from '../../components/charts';
import { Card, EmptyState, Grid, PageHeader, QueryView, Stat, Table } from '../../components/ui';
import { formatDate, formatMonth, formatNumber } from '../../format';
import { t } from '../../i18n';
import { ErxStatusBadge } from './ErxComponents';

/**
 * National e-prescriptions: the doctor's recently issued ones, how community pharmacies dispense
 * them (pharmacists), and facility (director) or national (Ministry) statistics.
 */
export function EPrescriptionsPage() {
  const user = useUser();
  return (
    <>
      <PageHeader
        title={t('E-prescriptions')}
        subtitle={t(
          'Prescriptions that any community pharmacy in Kosovo can dispense with the patient’s code and national ID.',
        )}
      />
      {user.role === 'DOCTOR' && <DoctorView />}
      {user.role === 'PHARMACIST' && <PharmacistView />}
      {(user.role === 'DIRECTOR' || user.role === 'MINISTRY') && <StatsView />}
    </>
  );
}

function DoctorView() {
  const list = useMyEPrescriptions();
  return (
    <Card title={t('My recent e-prescriptions')}>
      <p className="muted">
        {t(
          'Issue an e-prescription from the patient’s chart (Medications → Prescribe → “E-prescription for a community pharmacy”).',
        )}
      </p>
      <QueryView query={list}>
        {(items) =>
          items.length === 0 ? (
            <EmptyState title={t('No e-prescriptions yet')} />
          ) : (
            <Table caption={t('My recent e-prescriptions')}>
              <thead>
                <tr>
                  <th>{t('Patient')}</th>
                  <th>{t('Medication')}</th>
                  <th>{t('Issued')}</th>
                  <th>{t('Status')}</th>
                  <th>{t('Supplies')}</th>
                </tr>
              </thead>
              <tbody>
                {items.map((e) => (
                  <tr key={e.prescriptionId}>
                    <td>
                      <Link to={`/doctor/patients/${e.patientId}?tab=medications`}>
                        {e.patientName}
                      </Link>
                    </td>
                    <td>{e.medication}</td>
                    <td>{formatDate(e.issuedAt)}</td>
                    <td>
                      <ErxStatusBadge status={e.status} />
                    </td>
                    <td>{suppliesLabel(e)}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )
        }
      </QueryView>
    </Card>
  );
}

function PharmacistView() {
  return (
    <Card title={t('How community pharmacies dispense e-prescriptions')}>
      <ol>
        <li>{t('The patient shows the code (or its QR code) and their national ID card.')}</li>
        <li>
          {t(
            'The pharmacy’s own system looks the e-prescription up over the national partner API with both, and sees the medicine, how to take it, the supplies left and the patient’s allergies.',
          )}
        </li>
        <li>
          {t(
            'It records what was handed over (a generic substitute is allowed); the patient and the prescriber see it straight away.',
          )}
        </li>
      </ol>
      <p className="muted">
        {t(
          'Hospital prescriptions stay in your verification queue. Community pharmacies are connected by the Ministry under Partner systems (API).',
        )}
      </p>
    </Card>
  );
}

const num = (s: Suppressible) => (s.suppressed ? null : s.value);
const show = (s: Suppressible) =>
  s.suppressed ? t('Too few to show') : formatNumber(s.value ?? 0);

function StatsView() {
  const stats = useErxStats();
  return <QueryView query={stats}>{(s) => <Stats s={s} />}</QueryView>;
}

function Stats({ s }: { s: ErxStats }) {
  return (
    <>
      <p className="muted">
        {s.scope === 'NATIONAL'
          ? t('All facilities since {date}. Numbers below {n} are not shown.', {
              date: formatDate(s.since),
              n: s.smallCellThreshold,
            })
          : t(
              'E-prescriptions issued by doctors of your facility since {date}. Numbers below {n} are not shown.',
              {
                date: formatDate(s.since),
                n: s.smallCellThreshold,
              },
            )}
      </p>
      <Grid>
        <Stat label={t('Issued')} value={show(s.issued)} />
        <Stat
          label={t('Dispensed at least once')}
          value={show(s.dispensed)}
          hint={
            s.dispensedPct !== null
              ? t('{pct} %', { pct: formatNumber(s.dispensedPct) })
              : undefined
          }
        />
        <Stat label={t('Cancelled|e-prescription')} value={show(s.cancelled)} />
        <Stat
          label={t('Median time to first dispensing')}
          value={
            s.medianHoursToFirstDispensing === null
              ? '—'
              : t('{hours} h', { hours: formatNumber(s.medianHoursToFirstDispensing) })
          }
        />
      </Grid>
      <Card title={t('By month')}>
        {s.byMonth.length === 0 ? (
          <EmptyState title={t('No e-prescriptions in this period')} />
        ) : (
          <Table caption={t('E-prescriptions by month')}>
            <thead>
              <tr>
                <th>{t('Month')}</th>
                <th className="num">{t('Issued')}</th>
                <th className="num">{t('Dispensed at least once')}</th>
              </tr>
            </thead>
            <tbody>
              {s.byMonth.map((m) => (
                <tr key={m.month}>
                  <td>{formatMonth(m.month)}</td>
                  <td className="num">{show(m.issued)}</td>
                  <td className="num">{show(m.dispensed)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      <Grid min={320}>
        <Card title={t('Most prescribed medicines')}>
          <RankedBars
            label={t('Most prescribed medicines')}
            rows={s.topMedicines.map((m) => ({
              key: m.name,
              label: m.name,
              value: num(m.issued),
              suppressed: m.issued.suppressed,
            }))}
          />
        </Card>
        <Card title={t('By medicine group (ATC)')}>
          <RankedBars
            label={t('By medicine group (ATC)')}
            rows={s.byAtcGroup.map((g) => ({
              key: g.group ?? 'none',
              label: atcGroupLabel(g.group),
              value: num(g.issued),
              suppressed: g.issued.suppressed,
            }))}
          />
        </Card>
        {s.pharmacies && (
          <Card title={t('Supplies by pharmacy system')}>
            {s.pharmacies.length === 0 ? (
              <EmptyState title={t('No dispensings in this period')} />
            ) : (
              <RankedBars
                label={t('Supplies by pharmacy system')}
                rows={s.pharmacies.map((p) => ({
                  key: p.name,
                  label: p.name,
                  value: num(p.supplies),
                  suppressed: p.supplies.suppressed,
                }))}
              />
            )}
          </Card>
        )}
      </Grid>
    </>
  );
}
