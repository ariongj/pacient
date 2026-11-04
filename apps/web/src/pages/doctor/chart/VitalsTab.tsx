import { useState, type FormEvent } from 'react';
import type { Encounter } from '../../../api/types';
import {
  consciousnessLabel,
  usePatientNews,
  useSetSpo2Scale,
  type NewsScore,
  type VitalsWithNews,
} from '../../../api/news';
import { NewsBreakdown, NewsChip, NewsSparkline } from '../../hospital/EarlyWarningBoard';
import {
  Alert,
  Button,
  Card,
  Dialog,
  EmptyState,
  ErrorAlert,
  formValues,
  QueryView,
  SelectField,
  Table,
  TextAreaField,
  TextField,
} from '../../../components/ui';
import { formatDateTime } from '../../../format';
import { EncounterSelect, numbers, useChartMutation, useChartRole } from './shared';
import { useSection } from './useSection';
import { t } from '../../../i18n';

const FIELDS = [
  'systolic',
  'diastolic',
  'heartRate',
  'temperatureC',
  'respiratoryRate',
  'oxygenSaturation',
  'weightKg',
  'heightCm',
  'painScore',
];

const ACVPU = ['A', 'C', 'V', 'P', 'U'] as const;

/** Switch a patient to SpO2 scale 2 (hypercapnic respiratory failure) – doctors only. */
function Spo2ScaleControl({ patientId, scale }: { patientId: string; scale: 1 | 2 }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const set = useSetSpo2Scale(patientId);
  const next = scale === 1 ? 2 : 1;
  return (
    <>
      <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
        {scale === 1 ? t('Use SpO₂ scale 2') : t('Back to SpO₂ scale 1')}
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} title={t('SpO₂ scale for NEWS2')}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            set.mutate({ scale: next, reason }, { onSuccess: () => setOpen(false) });
          }}
        >
          <p className="muted">
            {t(
              'Scale 2 is only for patients with confirmed hypercapnic respiratory failure and a prescribed target saturation of 88–92 %. The latest observations are re-scored immediately.',
            )}
          </p>
          <TextAreaField
            label={t('Reason')}
            required
            minLength={5}
            maxLength={300}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <ErrorAlert error={set.error} />
          <div className="form-actions">
            <Button variant="secondary" onClick={() => setOpen(false)}>
              {t('Cancel')}
            </Button>
            <Button type="submit" loading={set.isPending}>
              {next === 2 ? t('Use SpO₂ scale 2') : t('Back to SpO₂ scale 1')}
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}

function NewsCell({ score }: { score: NewsScore | undefined }) {
  if (!score) return <span className="muted">—</span>;
  return (
    <details className="news-details">
      <summary>
        <NewsChip score={score.score} risk={score.risk} complete={score.complete} compact />
      </summary>
      <NewsBreakdown components={score.components} />
    </details>
  );
}

export function VitalsTab({
  patientId,
  encounters,
}: {
  patientId: string;
  encounters: Encounter[];
}) {
  const list = useSection<VitalsWithNews>(patientId, 'vitals');
  const news = usePatientNews(patientId);
  const { isDoctor } = useChartRole();
  const byVitals = new Map((news.data?.items ?? []).map((s) => [s.vitalSignId, s]));
  const latestScore = news.data?.items[0];
  const trend = (news.data?.items ?? [])
    .slice(0, 12)
    .reverse()
    .map((s) => s.score);
  const [open, setOpen] = useState(false);
  const create = useChartMutation(
    patientId,
    (body: Record<string, unknown>) => ({ path: '/vitals', method: 'POST', body }),
    () => setOpen(false),
  );

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const v = formValues(e.currentTarget);
    create.mutate({
      ...numbers(v, FIELDS),
      ...(v.consciousness ? { consciousness: v.consciousness } : {}),
      ...(v.onSupplementalOxygen
        ? { onSupplementalOxygen: v.onSupplementalOxygen === 'true' }
        : {}),
      ...(v.encounterId ? { encounterId: v.encounterId } : {}),
    });
  }

  return (
    <Card
      title={t('Vital signs')}
      actions={
        <span className="row" style={{ gap: '0.5rem' }}>
          {isDoctor && latestScore && (
            <Spo2ScaleControl patientId={patientId} scale={news.data?.spo2Scale ?? 1} />
          )}
          <Button size="sm" onClick={() => setOpen(true)}>
            {t('Record vitals')}
          </Button>
        </span>
      }
    >
      {latestScore && (
        <div
          className="row"
          style={{ gap: '0.75rem', alignItems: 'center', marginBottom: '0.75rem' }}
        >
          <span>{t('Latest NEWS2')}</span>
          <NewsChip
            score={latestScore.score}
            risk={latestScore.risk}
            complete={latestScore.complete}
          />
          <NewsSparkline scores={trend} width={120} />
          {news.data?.spo2Scale === 2 && <span className="muted">{t('SpO₂ scale 2')}</span>}
        </div>
      )}
      {latestScore && !latestScore.complete && (
        <Alert tone="info">
          {t(
            'The latest set is incomplete: NEWS2 needs respiration, SpO₂, air or oxygen, blood pressure, pulse, consciousness and temperature.',
          )}
        </Alert>
      )}
      <QueryView query={list}>
        {(items) =>
          items.length === 0 ? (
            <EmptyState title={t('No vital signs recorded')} />
          ) : (
            <Table caption={t('Vital signs')}>
              <thead>
                <tr>
                  <th>{t('Recorded')}</th>
                  <th className="num">{t('BP (mmHg)')}</th>
                  <th className="num">{t('HR (bpm)')}</th>
                  <th className="num">{t('Temp (°C)')}</th>
                  <th className="num">{t('RR')}</th>
                  <th className="num">{t('SpO₂ (%)')}</th>
                  <th>{t('O₂ / ACVPU')}</th>
                  <th>{t('NEWS2')}</th>
                  <th className="num">{t('Weight (kg)')}</th>
                  <th className="num">{t('Height (cm)')}</th>
                </tr>
              </thead>
              <tbody>
                {items.map((v) => (
                  <tr key={v.id}>
                    <td>
                      {formatDateTime(v.recordedAt)}
                      <div className="muted">{v.recordedBy}</div>
                    </td>
                    <td className="num">
                      {v.systolic ? `${v.systolic}/${v.diastolic ?? '—'}` : '—'}
                    </td>
                    <td className="num">{v.heartRate ?? '—'}</td>
                    <td className="num">{v.temperatureC ?? '—'}</td>
                    <td className="num">{v.respiratoryRate ?? '—'}</td>
                    <td className="num">{v.oxygenSaturation ?? '—'}</td>
                    <td>
                      {v.onSupplementalOxygen === true
                        ? t('Oxygen')
                        : v.onSupplementalOxygen === false
                          ? t('Air')
                          : '—'}
                      {v.consciousness && (
                        <div className="muted">{consciousnessLabel(v.consciousness)}</div>
                      )}
                      {v.painScore !== null && v.painScore !== undefined && (
                        <div className="muted">{t('Pain {score}/10', { score: v.painScore })}</div>
                      )}
                    </td>
                    <td>
                      <NewsCell score={byVitals.get(v.id)} />
                    </td>
                    <td className="num">{v.weightKg ?? '—'}</td>
                    <td className="num">{v.heightCm ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )
        }
      </QueryView>
      <Dialog open={open} onClose={() => setOpen(false)} title={t('Record vital signs')} wide>
        <form onSubmit={onSubmit}>
          <p className="muted">{t('Enter at least one measurement.')}</p>
          <div className="form-grid">
            <TextField
              label={t('Systolic (mmHg)')}
              name="systolic"
              type="number"
              min={40}
              max={300}
            />
            <TextField
              label={t('Diastolic (mmHg)')}
              name="diastolic"
              type="number"
              min={20}
              max={200}
            />
            <TextField
              label={t('Heart rate (bpm)')}
              name="heartRate"
              type="number"
              min={20}
              max={300}
            />
            <TextField
              label={t('Temperature (°C)')}
              name="temperatureC"
              type="number"
              step="0.1"
              min={25}
              max={45}
            />
            <TextField
              label={t('Respiratory rate')}
              name="respiratoryRate"
              type="number"
              min={4}
              max={80}
            />
            <TextField
              label={t('SpO₂ (%)')}
              name="oxygenSaturation"
              type="number"
              min={30}
              max={100}
            />
            <SelectField
              label={t('Air or oxygen')}
              name="onSupplementalOxygen"
              placeholder={t('Not recorded')}
              options={[
                { value: 'false', label: t('Air') },
                { value: 'true', label: t('Supplemental oxygen') },
              ]}
            />
            <SelectField
              label={t('Consciousness (ACVPU)')}
              name="consciousness"
              placeholder={t('Not recorded')}
              options={ACVPU.map((l) => ({ value: l, label: `${l} – ${consciousnessLabel(l)}` }))}
            />
            <TextField label={t('Pain (0–10)')} name="painScore" type="number" min={0} max={10} />
            <TextField
              label={t('Weight (kg)')}
              name="weightKg"
              type="number"
              step="0.1"
              min={0.3}
              max={500}
            />
            <TextField
              label={t('Height (cm)')}
              name="heightCm"
              type="number"
              step="0.1"
              min={20}
              max={260}
            />
          </div>
          <EncounterSelect encounters={encounters} />
          <ErrorAlert error={create.error} />
          <div className="form-actions">
            <Button variant="secondary" onClick={() => setOpen(false)}>
              {t('Cancel')}
            </Button>
            <Button type="submit" loading={create.isPending}>
              {t('Save')}
            </Button>
          </div>
        </form>
      </Dialog>
    </Card>
  );
}
