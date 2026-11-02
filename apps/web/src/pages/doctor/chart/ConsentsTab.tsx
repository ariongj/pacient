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

interface DocumentSummary {
  id: string;
  title: string;
  category: string;
  status: string;
  createdAt?: string;
}

function recordedLine(c: CurrentConsent) {
  if (c.isDefault) return 'No decision recorded – default applies';
  return `${METHOD_LABELS[c.method!]} · ${c.recordedBy ?? 'unknown'}${
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
                <Alert tone="warning" title="Sharing with other facilities is withdrawn">
                  Before referring this patient to another facility, discuss it with them and record
                  their agreement. Care within this facility and emergency access are not affected.
                </Alert>
              )}
              <Card
                title="Consent"
                actions={
                  isDoctor ? (
                    <Button size="sm" onClick={() => setOpen(true)}>
                      Record consent
                    </Button>
                  ) : undefined
                }
              >
                <Grid min={260}>
                  {d.current.map((c) => {
                    const text = d.texts.find((t) => t.type === c.type);
                    return (
                      <div key={c.type} className="card" style={{ margin: 0 }}>
                        <div className="row-between">
                          <strong>{CONSENT_LABELS[c.type]}</strong>
                          <Badge tone={decisionTone(c.decision)}>
                            {DECISION_LABELS[c.decision]}
                            {c.isDefault ? ' (default)' : ''}
                          </Badge>
                        </div>
                        {text && <p className="muted">{text.summary}</p>}
                        <small className="muted">{recordedLine(c)}</small>
                      </div>
                    );
                  })}
                </Grid>
              </Card>
              <Card title="Treatment and procedure consent">
                {d.treatment.length === 0 ? (
                  <EmptyState title="No treatment consent recorded" />
                ) : (
                  <Table caption="Treatment consents">
                    <thead>
                      <tr>
                        <th>Procedure</th>
                        <th>Decision</th>
                        <th>How</th>
                        <th>Recorded</th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.treatment.map((t) => (
                        <tr key={t.id}>
                          <td>
                            <strong>{t.procedure}</strong>
                            {t.expiresAt && (
                              <div className="muted">Valid until {formatDate(t.expiresAt)}</div>
                            )}
                          </td>
                          <td>
                            <Badge tone={decisionTone(t.decision)}>
                              {DECISION_LABELS[t.decision]}
                            </Badge>
                          </td>
                          <td>{t.method ? METHOD_LABELS[t.method] : '—'}</td>
                          <td>
                            {formatDateTime(t.recordedAt)}
                            <div className="muted">{t.recordedBy}</div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                )}
              </Card>
              <Card title="History">
                <p className="muted">
                  Every decision is kept; nothing is overwritten. The wording version shows which
                  explanation the patient was given.
                </p>
                {d.history.length === 0 ? (
                  <EmptyState title="No decisions recorded yet" />
                ) : (
                  <Table caption="Consent history">
                    <thead>
                      <tr>
                        <th>When</th>
                        <th>Consent</th>
                        <th>Decision</th>
                        <th>How</th>
                        <th>Recorded by</th>
                        <th>Note</th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.history.map((h) => (
                        <tr key={h.id}>
                          <td>{formatDateTime(h.createdAt)}</td>
                          <td>
                            {CONSENT_LABELS[h.type]}
                            {h.procedure && <div className="muted">{h.procedure}</div>}
                            <div className="muted">Wording {h.wordingVersion}</div>
                          </td>
                          <td>
                            <Badge tone={decisionTone(h.decision)}>
                              {DECISION_LABELS[h.decision]}
                            </Badge>
                          </td>
                          <td>
                            {METHOD_LABELS[h.method]}
                            {h.onBehalfGuardianshipId && <div className="muted">by guardian</div>}
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
    <Dialog open={open} onClose={onClose} title="Record consent" wide>
      <form onSubmit={onSubmit}>
        <div className="form-grid">
          <SelectField
            label="Consent"
            name="type"
            required
            value={type}
            onChange={(e) => setType(e.currentTarget.value as ConsentType)}
            options={(['TREATMENT', 'CROSS_FACILITY_SHARING', 'RESEARCH'] as const).map((t) => ({
              value: t,
              label: CONSENT_LABELS[t],
            }))}
          />
          <SelectField
            label="Decision"
            name="decision"
            required
            defaultValue="GRANTED"
            options={[
              { value: 'GRANTED', label: 'Agreed' },
              { value: 'REFUSED', label: 'Refused' },
              { value: 'WITHDRAWN', label: 'Withdrawn' },
            ]}
          />
          <SelectField
            label="How was it given?"
            name="method"
            required
            value={method}
            onChange={(e) => setMethod(e.currentTarget.value as 'IN_PERSON' | 'WRITTEN')}
            options={[
              { value: 'IN_PERSON', label: 'In person (verbal)' },
              { value: 'WRITTEN', label: 'Signed form' },
            ]}
          />
        </div>
        {type === 'TREATMENT' && (
          <TextField
            label="Treatment or procedure"
            name="procedure"
            required
            minLength={2}
            maxLength={200}
            placeholder="e.g. Minor skin excision"
          />
        )}
        {method === 'WRITTEN' && (
          <>
            {documents.isError ? (
              <Alert tone="warning">Documents could not be loaded. Try again later.</Alert>
            ) : (
              <SelectField
                label="Signed consent form"
                name="documentId"
                required
                placeholder={
                  documents.isLoading
                    ? 'Loading documents…'
                    : forms.length
                      ? 'Choose the signed form'
                      : 'No consent forms uploaded'
                }
                options={forms.map((f) => ({
                  value: f.id,
                  label: `${f.title}${f.createdAt ? ` · ${formatDate(f.createdAt)}` : ''}`,
                }))}
                hint="Upload the scanned form under Documents (category: consent form) first."
              />
            )}
          </>
        )}
        <TextAreaField
          label="What was discussed"
          name="note"
          maxLength={1000}
          rows={3}
          hint="Benefits, risks, alternatives and the patient’s questions."
        />
        <ErrorAlert error={record.error} />
        <div className="form-actions">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={record.isPending}>
            Record decision
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
