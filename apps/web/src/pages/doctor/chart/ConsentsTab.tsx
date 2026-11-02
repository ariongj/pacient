import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api } from '../../../api/client';
import {
  CONSENT_LABELS,
  DECISION_LABELS,
  decisionTone,
  METHOD_LABELS,
  useConsents,
  useRecordConsent,
  type ConsentMethod,
  type ConsentType,
  type CurrentConsent,
} from '../../../api/consent';
import {
  Alert,
  Badge,
  Button,
  Card,
  Dialog,
  EmptyState,
  ErrorAlert,
  formValues,
  Grid,
  QueryView,
  SelectField,
  Table,
  TextAreaField,
  TextField,
} from '../../../components/ui';
import { formatDate, formatDateTime, humanize } from '../../../format';
import { useChartRole } from './shared';
import { t } from '../../../i18n';

interface DocumentSummary {
  id: string;
  title: string;
  category: string;
  status: string;
  createdAt?: string;
}

function recordedLine(c: CurrentConsent) {
  if (c.isDefault) return t('No decision recorded – default applies');
  return `${METHOD_LABELS[c.method!]} · ${c.recordedBy ?? t('unknown')}${
    c.recordedByRole ? ` (${humanize(c.recordedByRole)})` : ''
  } · ${formatDateTime(c.recordedAt)}`;
}

/** Consent decisions on the chart: current state, treatment consents and the full history. */
export function ConsentsTab({ patientId }: { patientId: string }) {
  const q = useConsents(patientId);
  const { isDoctor } = useChartRole();
  const [open, setOpen] = useState(false);

  return (
    <div className="stack">
      <QueryView query={q}>
        {(d) => {
          const sharing = d.current.find((c) => c.type === 'CROSS_FACILITY_SHARING');
          return (
            <>
              {sharing && sharing.decision !== 'GRANTED' && (
                <Alert tone="warning" title={t('Sharing with other facilities is withdrawn')}>
                  {t(
                    'Before referring this patient to another facility, discuss it with them and record their agreement. Care within this facility and emergency access are not affected.',
                  )}
                </Alert>
              )}
              <Card
                title={t('Consent')}
                actions={
                  isDoctor ? (
                    <Button size="sm" onClick={() => setOpen(true)}>
                      {t('Record consent')}
                    </Button>
                  ) : undefined
                }
              >
                <Grid min={260}>
                  {d.current.map((c) => {
                    const text = d.texts.find((tx) => tx.type === c.type);
                    return (
                      <div key={c.type} className="card" style={{ margin: 0 }}>
                        <div className="row-between">
                          <strong>{CONSENT_LABELS[c.type]}</strong>
                          <Badge tone={decisionTone(c.decision)}>
                            {DECISION_LABELS[c.decision]}
                            {c.isDefault ? ` ${t('(default)')}` : ''}
                          </Badge>
                        </div>
                        {text && <p className="muted">{t(text.summary)}</p>}
                        <small className="muted">{recordedLine(c)}</small>
                      </div>
                    );
                  })}
                </Grid>
              </Card>
              <Card title={t('Treatment and procedure consent')}>
                {d.treatment.length === 0 ? (
                  <EmptyState title={t('No treatment consent recorded')} />
                ) : (
                  <Table caption={t('Treatment consents')}>
                    <thead>
                      <tr>
                        <th>{t('Procedure')}</th>
                        <th>{t('Decision')}</th>
                        <th>{t('How')}</th>
                        <th>{t('Recorded')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.treatment.map((tc) => (
                        <tr key={tc.id}>
                          <td>
                            <strong>{tc.procedure}</strong>
                            {tc.expiresAt && (
                              <div className="muted">
                                {t('Valid until {date}', { date: formatDate(tc.expiresAt) })}
                              </div>
                            )}
                          </td>
                          <td>
                            <Badge tone={decisionTone(tc.decision)}>
                              {DECISION_LABELS[tc.decision]}
                            </Badge>
                          </td>
                          <td>{tc.method ? METHOD_LABELS[tc.method] : '—'}</td>
                          <td>
                            {formatDateTime(tc.recordedAt)}
                            <div className="muted">{tc.recordedBy}</div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                )}
              </Card>
              <Card title={t('History')}>
                <p className="muted">
                  {t(
                    'Every decision is kept; nothing is overwritten. The wording version shows which explanation the patient was given.',
                  )}
                </p>
                {d.history.length === 0 ? (
                  <EmptyState title={t('No decisions recorded yet')} />
                ) : (
                  <Table caption={t('Consent history')}>
                    <thead>
                      <tr>
                        <th>{t('When')}</th>
                        <th>{t('Consent')}</th>
                        <th>{t('Decision')}</th>
                        <th>{t('How')}</th>
                        <th>{t('Recorded by')}</th>
                        <th>{t('Note')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.history.map((h) => (
                        <tr key={h.id}>
                          <td>{formatDateTime(h.createdAt)}</td>
                          <td>
                            {CONSENT_LABELS[h.type]}
                            {h.procedure && <div className="muted">{h.procedure}</div>}
                            <div className="muted">
                              {t('Wording {version}', { version: h.wordingVersion })}
                            </div>
                          </td>
                          <td>
                            <Badge tone={decisionTone(h.decision)}>
                              {DECISION_LABELS[h.decision]}
                            </Badge>
                          </td>
                          <td>
                            {METHOD_LABELS[h.method]}
                            {h.onBehalfGuardianshipId && (
                              <div className="muted">{t('by guardian')}</div>
                            )}
                          </td>
                          <td>
                            {h.recordedBy}
                            <div className="muted">{humanize(h.recordedByRole)}</div>
                          </td>
                          <td>{h.note ?? '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                )}
              </Card>
            </>
          );
        }}
      </QueryView>
      {isDoctor && (
        <RecordConsentDialog patientId={patientId} open={open} onClose={() => setOpen(false)} />
      )}
    </div>
  );
}

function RecordConsentDialog({
  patientId,
  open,
  onClose,
}: {
  patientId: string;
  open: boolean;
  onClose: () => void;
}) {
  const [type, setType] = useState<ConsentType>('TREATMENT');
  const [method, setMethod] = useState<Exclude<ConsentMethod, 'PORTAL'>>('IN_PERSON');
  const record = useRecordConsent(patientId, onClose);
  const documents = useQuery({
    queryKey: ['patient', patientId, 'documents'],
    queryFn: () =>
      api<{ items: DocumentSummary[] }>(`/patients/${patientId}/documents`).then((r) => r.items),
    enabled: open && method === 'WRITTEN',
    retry: false,
  });
  const forms = (documents.data ?? []).filter(
    (doc) => doc.category === 'CONSENT_FORM' && doc.status === 'CURRENT',
  );

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const v = formValues(e.currentTarget);
    record.mutate({
      type,
      method,
      decision: v.decision,
      procedure: type === 'TREATMENT' ? v.procedure : undefined,
      note: v.note || undefined,
      documentId: method === 'WRITTEN' ? v.documentId : undefined,
    });
  }

  return (
    <Dialog open={open} onClose={onClose} title={t('Record consent')} wide>
      <form onSubmit={onSubmit}>
        <div className="form-grid">
          <SelectField
            label={t('Consent')}
            name="type"
            required
            value={type}
            onChange={(e) => setType(e.currentTarget.value as ConsentType)}
            options={(['TREATMENT', 'CROSS_FACILITY_SHARING', 'RESEARCH'] as const).map((ct) => ({
              value: ct,
              label: CONSENT_LABELS[ct],
            }))}
          />
          <SelectField
            label={t('Decision')}
            name="decision"
            required
            defaultValue="GRANTED"
            options={[
              { value: 'GRANTED', label: t('Agreed') },
              { value: 'REFUSED', label: t('Refused') },
              { value: 'WITHDRAWN', label: t('Withdrawn') },
            ]}
          />
          <SelectField
            label={t('How was it given?')}
            name="method"
            required
            value={method}
            onChange={(e) => setMethod(e.currentTarget.value as 'IN_PERSON' | 'WRITTEN')}
            options={[
              { value: 'IN_PERSON', label: t('In person (verbal)') },
              { value: 'WRITTEN', label: t('Signed form') },
            ]}
          />
        </div>
        {type === 'TREATMENT' && (
          <TextField
            label={t('Treatment or procedure')}
            name="procedure"
            required
            minLength={2}
            maxLength={200}
            placeholder={t('e.g. Minor skin excision')}
          />
        )}
        {method === 'WRITTEN' && (
          <>
            {documents.isError ? (
              <Alert tone="warning">{t('Documents could not be loaded. Try again later.')}</Alert>
            ) : (
              <SelectField
                label={t('Signed consent form')}
                name="documentId"
                required
                placeholder={
                  documents.isLoading
                    ? t('Loading documents…')
                    : forms.length
                      ? t('Choose the signed form')
                      : t('No consent forms uploaded')
                }
                options={forms.map((f) => ({
                  value: f.id,
                  label: `${f.title}${f.createdAt ? ` · ${formatDate(f.createdAt)}` : ''}`,
                }))}
                hint={t('Upload the scanned form under Documents (category: consent form) first.')}
              />
            )}
          </>
        )}
        <TextAreaField
          label={t('What was discussed')}
          name="note"
          maxLength={1000}
          rows={3}
          hint={t('Benefits, risks, alternatives and the patient’s questions.')}
        />
        <ErrorAlert error={record.error} />
        <div className="form-actions">
          <Button variant="secondary" onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button type="submit" loading={record.isPending}>
            {t('Record decision')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
