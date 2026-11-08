import { useState, type FormEvent } from 'react';
import {
  kindLabel,
  READING_KINDS,
  readingValue,
  useMyMonitoring,
  useSubmitReading,
  type ReadingKind,
  type SubmitResult,
} from '../../api/remote';
import {
  Alert,
  Button,
  Card,
  DefinitionList,
  EmptyState,
  ErrorAlert,
  PageHeader,
  QueryView,
  SelectField,
  Table,
  TextField,
} from '../../components/ui';
import { formatDate, formatDateTime } from '../../format';
import { t } from '../../i18n';
import {
  AdviceAlert,
  FlagBadge,
  MeasuredAtField,
  ReadingFields,
  readValues,
  TrendChart,
} from './RemoteComponents';

/**
 * Portal: the patient's (or child's) home monitoring plan, a form to enter readings with
 * immediate advice, and their recent readings with trends.
 */
export function PortalReadingsPage() {
  const mine = useMyMonitoring();
  const submit = useSubmitReading();
  const [kind, setKind] = useState<ReadingKind | ''>('');
  const [result, setResult] = useState<SubmitResult | null>(null);
  const [formKey, setFormKey] = useState(0);

  return (
    <>
      <PageHeader
        title={t('My home readings')}
        subtitle={t('Measurements you take at home, shared with your care team.')}
      />
      <QueryView query={mine}>
        {(data) => {
          const kinds: ReadingKind[] = data.plan?.kinds.length ? data.plan.kinds : READING_KINDS;
          const current: ReadingKind = kind && kinds.includes(kind) ? kind : kinds[0]!;
          function onSubmit(e: FormEvent<HTMLFormElement>) {
            e.preventDefault();
            const form = new FormData(e.currentTarget);
            const at = String(form.get('measuredAt') ?? '');
            const note = String(form.get('note') ?? '').trim();
            setResult(null);
            submit.mutate(
              {
                kind: current,
                values: readValues(current, form),
                measuredAt: at ? new Date(at).toISOString() : undefined,
                note: note || undefined,
              },
              {
                onSuccess: (r) => {
                  setResult(r);
                  setFormKey((k) => k + 1);
                },
              },
            );
          }
          return (
            <div className="stack">
              {result && (
                <div aria-live="assertive">
                  <AdviceAlert advice={result.advice} />
                </div>
              )}
              {data.plan ? (
                <Card title={t('My monitoring plan')}>
                  <DefinitionList
                    items={[
                      [t('Measurements'), data.plan.kinds.map(kindLabel).join(', ')],
                      [t('How often'), data.plan.frequency],
                      [t('Set up by'), data.plan.enrolledBy],
                      [t('Since'), formatDate(data.plan.createdAt)],
                    ]}
                  />
                  {data.plan.instructions && (
                    <p style={{ whiteSpace: 'pre-line' }}>{data.plan.instructions}</p>
                  )}
                </Card>
              ) : (
                <Alert tone="info" title={t('No home monitoring plan yet')}>
                  {t(
                    'You can still enter readings and your care team will see them. Ask your family doctor whether regular home measurements would help you.',
                  )}
                </Alert>
              )}
              <Card title={t('Enter a reading')}>
                <form key={formKey} className="stack" onSubmit={onSubmit}>
                  <div className="form-grid">
                    <SelectField
                      label={t('Measurement')}
                      value={current}
                      onChange={(e) => {
                        setKind(e.currentTarget.value as ReadingKind);
                        setResult(null);
                      }}
                      options={kinds.map((k) => ({ value: k, label: kindLabel(k) }))}
                    />
                    <ReadingFields kind={current} />
                    <MeasuredAtField />
                    <TextField
                      name="note"
                      label={t('Note (optional)')}
                      maxLength={300}
                      placeholder={t('e.g. headache, after exercise, missed a dose')}
                    />
                  </div>
                  <ErrorAlert error={submit.error} />
                  <div className="row">
                    <Button type="submit" loading={submit.isPending}>
                      {t('Save reading')}
                    </Button>
                  </div>
                  <p className="muted">
                    {t(
                      'Readings are not watched around the clock. If you feel unwell, do not wait for a reply: call 112 or your doctor.',
                    )}
                  </p>
                </form>
              </Card>
              {kinds
                .filter((k) => data.readings.some((r) => r.kind === k))
                .map((k) => (
                  <Card key={k} title={kindLabel(k)}>
                    <TrendChart
                      kind={k}
                      readings={data.readings}
                      limits={data.plan?.limits ?? {}}
                    />
                  </Card>
                ))}
              <Card title={t('Recent readings')}>
                {data.readings.length === 0 ? (
                  <EmptyState title={t('No readings yet')} />
                ) : (
                  <Table caption={t('Recent readings')}>
                    <thead>
                      <tr>
                        <th>{t('Measured')}</th>
                        <th>{t('Measurement')}</th>
                        <th>{t('Value')}</th>
                        <th>{t('Result|reading')}</th>
                        <th>{t('Seen by the care team')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.readings.slice(0, 60).map((r) => (
                        <tr key={r.id}>
                          <td>{formatDateTime(r.measuredAt)}</td>
                          <td>{kindLabel(r.kind)}</td>
                          <td>
                            {readingValue(r.kind, r.values)}
                            {r.note && <div className="muted">{r.note}</div>}
                          </td>
                          <td>
                            <FlagBadge flag={r.flag} />
                          </td>
                          <td>
                            {r.reviewedAt
                              ? t('Yes, {date}', { date: formatDateTime(r.reviewedAt) })
                              : r.flag === 'NORMAL'
                                ? '—'
                                : t('Not yet')}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                )}
              </Card>
            </div>
          );
        }}
      </QueryView>
    </>
  );
}
