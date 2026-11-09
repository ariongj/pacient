import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  instrumentName,
  useInstruments,
  usePromStats,
  useReviewList,
  type Instrument,
  type InstrumentCode,
  type ReviewItem,
} from '../../api/proms';
import { useUser } from '../../auth/AuthContext';
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  Grid,
  PageHeader,
  Pagination,
  QueryView,
  SelectField,
  Stat,
  Table,
} from '../../components/ui';
import { formatDate, formatDateTime, formatNumber, fullName } from '../../format';
import { t } from '../../i18n';
import { ReviewDialog, scoreText, SeverityBadge, TranslationNote } from './PromsComponents';

const INSTRUMENTS: InstrumentCode[] = ['PHQ9', 'GAD7', 'WHO5', 'AUDITC'];

/**
 * Questionnaires: the care team's review list (answers that need attention today first), or for
 * a director the completion figures of the facility (counts only).
 */
export function PromsPage() {
  const user = useUser();
  return (
    <>
      <PageHeader
        title={t('Questionnaires')}
        subtitle={
          user.role === 'DIRECTOR'
            ? t('How many patients answer the questionnaires their care team asks for.')
            : t('Answers of patients in your care, those that need attention today first.')
        }
      />
      {user.role === 'DIRECTOR' ? <StatsView /> : <ReviewView />}
    </>
  );
}

function ReviewView() {
  const user = useUser();
  const chartBase = user.role === 'NURSE' ? '/nurse/patients' : '/doctor/patients';
  const [params] = useSearchParams();
  const highlight = params.get('response');
  const [show, setShow] = useState<'UNREVIEWED' | 'FLAGGED' | 'ALL'>('UNREVIEWED');
  const [instrument, setInstrument] = useState('');
  const [page, setPage] = useState(1);
  const [reviewing, setReviewing] = useState<ReviewItem | null>(null);
  const list = useReviewList({ show, instrument: instrument || undefined, page });
  const defs = useInstruments();
  const byCode = new Map<string, Instrument>(
    (defs.data?.instruments ?? []).map((i) => [i.code, i]),
  );
  return (
    <div className="stack">
      <Card>
        <div className="form-grid">
          <SelectField
            label={t('Show')}
            value={show}
            onChange={(e) => {
              setShow(e.currentTarget.value as typeof show);
              setPage(1);
            }}
            options={[
              { value: 'UNREVIEWED', label: t('Not reviewed yet') },
              { value: 'FLAGGED', label: t('Needing attention today') },
              { value: 'ALL', label: t('All answers') },
            ]}
          />
          <SelectField
            label={t('Questionnaire')}
            value={instrument}
            onChange={(e) => {
              setInstrument(e.currentTarget.value);
              setPage(1);
            }}
            options={[
              { value: '', label: t('All questionnaires') },
              ...INSTRUMENTS.map((c) => ({ value: c, label: instrumentName(c) })),
            ]}
          />
        </div>
      </Card>
      <QueryView query={list}>
        {(data) => (
          <>
            <Grid min={200}>
              <Stat
                label={t('Needing attention today')}
                value={formatNumber(data.counts.flagged)}
                tone={data.counts.flagged ? 'danger' : undefined}
              />
            </Grid>
            {data.counts.flagged > 0 && (
              <Alert tone="warning">
                {t(
                  'Answers with a safety flag (thoughts of self-harm or a severe depression score): contact the patient today and follow the local protocol for suicide risk assessment.',
                )}
              </Alert>
            )}
            <Card>
              {data.items.length === 0 ? (
                <EmptyState title={t('Nothing to review')}>
                  {t('Questionnaire answers of patients in your care appear here.')}
                </EmptyState>
              ) : (
                <Table caption={t('Questionnaire answers to review')}>
                  <thead>
                    <tr>
                      <th>{t('Patient')}</th>
                      <th>{t('Questionnaire')}</th>
                      <th>{t('Score')}</th>
                      <th>{t('Change')}</th>
                      <th>{t('Answered')}</th>
                      <th>
                        <span className="sr-only">{t('Actions')}</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.items.map((r) => {
                      const inst = byCode.get(r.instrument);
                      return (
                        <tr
                          key={r.id}
                          style={
                            r.id === highlight
                              ? { outline: '2px solid var(--danger)', outlineOffset: -2 }
                              : undefined
                          }
                        >
                          <td>
                            <Link to={`${chartBase}/${r.patient.id}?tab=proms`}>
                              {fullName(r.patient)}
                            </Link>
                            <div className="muted mono">{r.patient.nationalId}</div>
                            {r.patient.phone && <div className="muted">{r.patient.phone}</div>}
                          </td>
                          <td>
                            {instrumentName(r.instrument)}
                            {r.safetyFlag && !r.reviewedAt && (
                              <div>
                                <Badge tone="danger">{t('Needs attention today')}</Badge>
                              </div>
                            )}
                          </td>
                          <td>
                            {scoreText(inst, r.score)} <SeverityBadge severity={r.severity} />
                          </td>
                          <td>
                            {r.difference === null ? (
                              <span className="muted">{t('First answer')}</span>
                            ) : (
                              <>
                                {r.difference > 0 ? '+' : r.difference < 0 ? '−' : '±'}
                                {formatNumber(Math.abs(r.difference))}
                                {r.meaningful && (
                                  <div className="muted">{t('Clinically meaningful')}</div>
                                )}
                              </>
                            )}
                          </td>
                          <td>{formatDateTime(r.submittedAt)}</td>
                          <td>
                            {r.reviewedAt ? (
                              <span className="muted">
                                {t('Reviewed {date}', { date: formatDate(r.reviewedAt) })}
                              </span>
                            ) : (
                              <Button
                                size="sm"
                                variant={r.safetyFlag ? 'danger' : 'primary'}
                                onClick={() => setReviewing(r)}
                              >
                                {t('Review')}
                              </Button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </Table>
              )}
              <Pagination page={data.page} totalPages={data.totalPages} onChange={setPage} />
            </Card>
          </>
        )}
      </QueryView>
      <TranslationNote />
      <ReviewDialog
        item={reviewing}
        patientName={reviewing ? fullName(reviewing.patient) : undefined}
        instrument={reviewing ? byCode.get(reviewing.instrument) : undefined}
        onClose={() => setReviewing(null)}
      />
    </div>
  );
}

function StatsView() {
  const stats = usePromStats();
  const n = (v: number | null) => (v === null ? t('Hidden|small numbers') : formatNumber(v));
  const pct = (v: number | null) => (v === null ? '—' : `${formatNumber(v)} %`);
  return (
    <QueryView query={stats}>
      {(s) => (
        <div className="stack">
          <Card title={t('Completion in the last 90 days')}>
            <Table caption={t('Completion in the last 90 days')}>
              <thead>
                <tr>
                  <th>{t('Questionnaire')}</th>
                  <th className="num">{t('Patients asked')}</th>
                  <th className="num">{t('Answered at least once')}</th>
                  <th className="num">{t('Completion')}</th>
                  <th className="num">{t('Answers')}</th>
                  <th className="num">{t('Safety flags')}</th>
                  <th className="num">{t('Safety flags reviewed within 24 hours')}</th>
                </tr>
              </thead>
              <tbody>
                {s.items.map((i) => (
                  <tr key={i.instrument}>
                    <th scope="row">{instrumentName(i.instrument)}</th>
                    <td className="num">{n(i.asked)}</td>
                    <td className="num">{n(i.answered)}</td>
                    <td className="num">{pct(i.completionPct)}</td>
                    <td className="num">{n(i.responses)}</td>
                    <td className="num">{n(i.safetyFlags)}</td>
                    <td className="num">{pct(i.flagsReviewedWithin24hPct)}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <p className="muted">
              {t(
                'Patients asked: requests made at least 14 days ago and active in the period. Counts below {n} are hidden, as are counts from which a hidden one could be worked out. No names or scores are shown.',
                { n: s.smallCellThreshold },
              )}
            </p>
          </Card>
        </div>
      )}
    </QueryView>
  );
}
