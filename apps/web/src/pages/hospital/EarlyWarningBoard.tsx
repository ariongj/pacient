import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ageBandLabel,
  intervalLabel,
  NEWS_PARAMETERS,
  notRecordedLabel,
  parameterLabel,
  riskLabel,
  riskShort,
  useAcknowledgeScore,
  useNewsBoard,
  type EarlyWarningScale,
  type NewsBoardItem,
  type NewsComponents,
  type NewsRisk,
} from '../../api/news';
import { useUser } from '../../auth/AuthContext';
import {
  Badge,
  Button,
  Card,
  Dialog,
  EmptyState,
  ErrorAlert,
  Grid,
  PageHeader,
  QueryView,
  Stat,
  Tabs,
  TextAreaField,
} from '../../components/ui';
import { formatDateTime, formatTime, fullName } from '../../format';
import { t } from '../../i18n';
import './news.css';

/**
 * Colour-coded early warning score with the scale, the number and the risk in words: "NEWS2 5"
 * for adults, "PEWS 5" for children – the two are not comparable, so the scale is always shown.
 */
export function NewsChip({
  scale = 'NEWS2',
  score,
  risk,
  complete = true,
  compact = false,
}: {
  scale?: EarlyWarningScale;
  score: number;
  risk: NewsRisk;
  complete?: boolean;
  compact?: boolean;
}) {
  const label = t('{scale} {score} – {risk}', { scale, score, risk: riskLabel(risk) });
  return (
    <span className={`news-chip news-${risk}`} title={label} aria-label={label} role="img">
      <span aria-hidden="true">
        {scale} <span className="news-chip-score">{score}</span>
        {!compact && <> · {riskShort(risk)}</>}
        {!complete && <span className="news-incomplete"> · {t('incomplete')}</span>}
      </span>
    </span>
  );
}

/** Tiny trend line of the last scores (oldest → newest). */
export function NewsSparkline({ scores, width = 64 }: { scores: number[]; width?: number }) {
  if (scores.length < 2) return null;
  const h = 18;
  const max = Math.max(7, ...scores);
  const step = width / (scores.length - 1);
  const pts = scores
    .map((s, i) => `${Math.round(i * step)},${Math.round(h - (s / max) * (h - 2) - 1)}`)
    .join(' ');
  const first = scores[0]!;
  const last = scores[scores.length - 1]!;
  const direction = last > first ? t('rising') : last < first ? t('falling') : t('unchanged');
  return (
    <svg
      className="news-spark"
      width={width}
      height={h}
      viewBox={`0 0 ${width} ${h}`}
      role="img"
      aria-label={t('Trend: {direction} ({scores})', { direction, scores: scores.join(' → ') })}
    >
      <polyline points={pts} fill="none" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}

/** Points per parameter, for a popover/details element. */
export function NewsBreakdown({ components }: { components: NewsComponents }) {
  const pews = components.scale === 'PEWS';
  return (
    <dl className="news-components">
      <dt>{t('Scale')}</dt>
      <dd>{pews ? t('PEWS (paediatric)') : 'NEWS2'}</dd>
      {pews && components.ageBand && (
        <>
          <dt>{t('Age band')}</dt>
          <dd>{ageBandLabel(components.ageBand)}</dd>
        </>
      )}
      {NEWS_PARAMETERS.map((p) => (
        <div key={p} style={{ display: 'contents' }}>
          <dt>{parameterLabel(p)}</dt>
          <dd>{components[p] ?? t('not measured')}</dd>
        </div>
      ))}
      {pews &&
        (['capillaryRefill', 'respiratoryEffort'] as const).map((p) =>
          components[p] === null || components[p] === undefined ? null : (
            <div key={p} style={{ display: 'contents' }}>
              <dt>{notRecordedLabel(p)}</dt>
              <dd>{components[p]}</dd>
            </div>
          ),
        )}
      {!pews && components.spo2Scale === 2 && (
        <>
          <dt>{t('SpO₂ scale')}</dt>
          <dd>2</dd>
        </>
      )}
      {pews && components.notRecorded && components.notRecorded.length > 0 && (
        <>
          <dt>{t('Not recorded')}</dt>
          <dd>{components.notRecorded.map(notRecordedLabel).join(', ')}</dd>
        </>
      )}
    </dl>
  );
}

/** Scores of the same scale as the latest one (a NEWS2 and a PEWS score are not comparable). */
function sameScaleTrend(item: NewsBoardItem) {
  const scale = item.trend[0]?.scale;
  return item.trend.filter((s) => s.scale === scale);
}

function trendArrow(item: NewsBoardItem) {
  const [latest, previous] = sameScaleTrend(item);
  if (!latest || !previous) return null;
  if (latest.score > previous.score) return <span aria-label={t('worse than before')}>▲</span>;
  if (latest.score < previous.score) return <span aria-label={t('better than before')}>▼</span>;
  return <span aria-label={t('unchanged')}>▬</span>;
}

function BoardRow({
  item,
  base,
  onAcknowledge,
}: {
  item: NewsBoardItem;
  base: string;
  onAcknowledge: (item: NewsBoardItem) => void;
}) {
  const latest = item.latest;
  const needsAck =
    latest &&
    (latest.risk === 'HIGH' || latest.risk === 'MEDIUM' || latest.risk === 'LOW_MEDIUM') &&
    !latest.acknowledgedAt;
  return (
    <div className={`news-board-row ${latest ? `news-row-${latest.risk}` : ''}`}>
      <div>
        <Link to={`${base}/patients/${item.patientId}?tab=vitals`}>
          <strong>{fullName(item)}</strong>
        </Link>
        <div className="news-meta">
          {item.unitName}
          {item.bedLabel ? ` · ${t('Bed {bed}', { bed: item.bedLabel })}` : ''} ·{' '}
          {item.attendingDoctorName}
        </div>
      </div>
      <div className="row" style={{ gap: '0.4rem', alignItems: 'center' }}>
        {latest ? (
          <>
            <details className="news-details">
              <summary>
                <NewsChip
                  scale={latest.scale}
                  score={latest.score}
                  risk={latest.risk}
                  complete={latest.complete}
                />
              </summary>
              <NewsBreakdown components={latest.components} />
            </details>
            {trendArrow(item)}
            <NewsSparkline
              scores={sameScaleTrend(item)
                .reverse()
                .map((s) => s.score)}
            />
          </>
        ) : (
          <span className="muted">{t('No score yet')}</span>
        )}
      </div>
      <div className="news-meta">
        {item.lastObservationAt
          ? t('Last observations {time}', { time: formatDateTime(item.lastObservationAt) })
          : t('No observations since admission')}
        <div>
          {t('Next set due {interval}', {
            interval: intervalLabel(item.observationIntervalMinutes),
          })}
          {item.overdue && (
            <>
              {' '}
              <Badge tone="danger">{t('Observations overdue')}</Badge>
            </>
          )}
        </div>
        {latest?.acknowledgedAt && (
          <div>{t('Acknowledged {time}', { time: formatTime(latest.acknowledgedAt) })}</div>
        )}
      </div>
      <div>
        {needsAck && (
          <Button size="sm" variant="secondary" onClick={() => onAcknowledge(item)}>
            {t('Acknowledge')}
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * Ward early-warning board: inpatients by risk (NEWS2 for adults, PEWS for children), with
 * overdue observations.
 */
export function EarlyWarningBoard() {
  const user = useUser();
  const base = user.role === 'DOCTOR' ? '/doctor' : '/nurse';
  const board = useNewsBoard();
  const [tab, setTab] = useState('all');
  const [ack, setAck] = useState<NewsBoardItem | null>(null);
  const [note, setNote] = useState('');
  const acknowledge = useAcknowledgeScore(ack?.patientId);

  return (
    <>
      <PageHeader
        title={t('Early warning (NEWS2 / PEWS)')}
        subtitle={t(
          'National Early Warning Score 2 of every adult inpatient and the Paediatric Early Warning Score of every child, highest risk first. Scores are calculated from each set of observations; medium and high scores alert the ward team automatically.',
        )}
      />
      <QueryView query={board}>
        {(data) => {
          const units = [...new Map(data.items.map((i) => [i.unitId, i.unitName])).entries()];
          const items = tab === 'all' ? data.items : data.items.filter((i) => i.unitId === tab);
          return (
            <>
              <Grid min={150}>
                <Stat
                  label={t('High risk')}
                  value={data.counts.HIGH}
                  tone={data.counts.HIGH ? 'danger' : undefined}
                />
                <Stat
                  label={t('Medium risk')}
                  value={data.counts.MEDIUM}
                  tone={data.counts.MEDIUM ? 'warning' : undefined}
                />
                <Stat label={t('Single parameter 3')} value={data.counts.LOW_MEDIUM} />
                <Stat
                  label={t('Observations overdue')}
                  value={data.counts.overdue}
                  tone={data.counts.overdue ? 'warning' : undefined}
                />
                <Stat label={t('Inpatients')} value={data.counts.total} />
              </Grid>
              <Card>
                {units.length > 1 && (
                  <Tabs
                    withPanels={false}
                    label={t('Wards')}
                    active={tab}
                    onChange={setTab}
                    tabs={[
                      { id: 'all', label: t('All wards') },
                      ...units.map(([id, name]) => ({ id, label: name })),
                    ]}
                  />
                )}
                {items.length === 0 ? (
                  <EmptyState title={t('No inpatients')} />
                ) : (
                  <div>
                    {items.map((item) => (
                      <BoardRow
                        key={item.admissionId}
                        item={item}
                        base={base}
                        onAcknowledge={(i) => {
                          setNote('');
                          setAck(i);
                        }}
                      />
                    ))}
                  </div>
                )}
                <p className="muted" style={{ marginTop: '1rem' }}>
                  {t(
                    'Response: 0–4 ward-based care; a single parameter of 3 – urgent ward review; 5–6 urgent review by a doctor; 7 or more emergency assessment and continuous monitoring. Clinical judgement always comes first.',
                  )}
                </p>
                {data.items.some((i) => i.latest?.scale === 'PEWS') && (
                  <p className="muted">
                    {t(
                      'PEWS (children under 18): 0–3 ward care; a single parameter of 3 – urgent bedside review; 4–6 urgent review by a paediatrician within the hour; 7 or more emergency assessment. The thresholds depend on the age band and are illustrative until the hospital adopts its approved paediatric chart.',
                    )}
                  </p>
                )}
              </Card>
            </>
          );
        }}
      </QueryView>
      <Dialog
        open={Boolean(ack)}
        onClose={() => setAck(null)}
        title={t('Acknowledge early warning score')}
      >
        {ack?.latest && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              acknowledge.mutate(
                { id: ack.latest!.id, note: note.trim() || undefined },
                { onSuccess: () => setAck(null) },
              );
            }}
          >
            <p>
              <strong>{fullName(ack)}</strong> –{' '}
              <NewsChip scale={ack.latest.scale} score={ack.latest.score} risk={ack.latest.risk} />
            </p>
            <p className="muted">
              {t(
                'Acknowledging confirms that the score was seen and acted on. Repeated reminders stop until the next higher score.',
              )}
            </p>
            <TextAreaField
              label={t('What was done (optional)')}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={500}
              rows={3}
            />
            <ErrorAlert error={acknowledge.error} />
            <div className="form-actions">
              <Button variant="secondary" onClick={() => setAck(null)}>
                {t('Cancel')}
              </Button>
              <Button type="submit" loading={acknowledge.isPending}>
                {t('Acknowledge')}
              </Button>
            </div>
          </form>
        )}
      </Dialog>
    </>
  );
}
