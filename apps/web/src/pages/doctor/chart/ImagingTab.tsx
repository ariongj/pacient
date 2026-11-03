import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../../api/client';
import {
  bodyPartPresets,
  modalityLabel,
  MODALITIES,
  safetyQuestions,
  safetySummary,
  useImagingAction,
  yesNoUnknownOptions,
  type ImagingOrder,
  type Modality,
  type SafetyChecks,
} from '../../../api/imaging';
import {
  Badge,
  Button,
  Card,
  DefinitionList,
  Dialog,
  EmptyState,
  ErrorAlert,
  QueryView,
  SelectField,
  StatusBadge,
  Table,
  TextAreaField,
  TextField,
} from '../../../components/ui';
import { age, formatDateTime } from '../../../format';
import { t } from '../../../i18n';
import { useChartRole } from './shared';

interface Demographics {
  sex: string;
  dateOfBirth: string;
}

export function ImagingTab({ patientId }: { patientId: string }) {
  const { isDoctor } = useChartRole();
  const orders = useQuery({
    queryKey: ['imaging', 'patient', patientId],
    queryFn: () =>
      api<{ items: ImagingOrder[] }>(`/imaging/patients/${patientId}/orders`).then((r) => r.items),
  });
  const [ordering, setOrdering] = useState(false);
  const [viewing, setViewing] = useState<ImagingOrder | null>(null);
  const [cancelling, setCancelling] = useState<ImagingOrder | null>(null);
  const acknowledge = useImagingAction((id: string) => ({ path: `/orders/${id}/acknowledge` }));
  const release = useImagingAction((id: string) => ({ path: `/orders/${id}/release` }));

  return (
    <Card
      title={t('Imaging')}
      actions={
        isDoctor ? (
          <Button size="sm" onClick={() => setOrdering(true)}>
            {t('Order imaging')}
          </Button>
        ) : undefined
      }
    >
      <p className="muted">
        {t(
          'Requests go to the radiology unit of your facility. A signed report cannot be changed; acknowledge it, then release it to the patient.',
        )}
      </p>
      <ErrorAlert error={acknowledge.error ?? release.error} />
      <QueryView query={orders}>
        {(items) =>
          items.length === 0 ? (
            <EmptyState title={t('No imaging examinations')} />
          ) : (
            <Table caption={t('Imaging examinations')}>
              <thead>
                <tr>
                  <th>{t('Examination')}</th>
                  <th>{t('Priority')}</th>
                  <th>{t('Status')}</th>
                  <th>{t('Report')}</th>
                  <th>{t('Requested')}</th>
                  <th>
                    <span className="sr-only">{t('Actions')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((o) => (
                  <tr key={o.id}>
                    <td>
                      <strong>
                        {modalityLabel(o.modality)} · {o.bodyPart}
                      </strong>
                      <div className="muted">
                        <span className="mono">{o.accessionNumber}</span>
                      </div>
                      <div className="muted">“{o.clinicalQuestion}”</div>
                    </td>
                    <td>
                      <StatusBadge value={o.priority} />
                    </td>
                    <td>
                      <StatusBadge value={o.status} />
                    </td>
                    <td>
                      {o.status === 'REPORTED' ? (
                        <div className="stack" style={{ gap: '0.25rem' }}>
                          {o.critical && <Badge tone="danger">{t('Critical finding')}</Badge>}
                          <span>{o.impression}</span>
                          <Button size="sm" variant="ghost" onClick={() => setViewing(o)}>
                            {t('Full report')}
                          </Button>
                        </div>
                      ) : o.status === 'CANCELLED' ? (
                        <span className="muted">{o.cancelReason}</span>
                      ) : (
                        <span className="muted">{t('Awaiting report')}</span>
                      )}
                    </td>
                    <td>
                      {formatDateTime(o.createdAt)}
                      <div className="muted">{o.orderedBy}</div>
                    </td>
                    <td>
                      {isDoctor && (
                        <div className="stack" style={{ gap: '0.35rem' }}>
                          {o.status === 'REPORTED' && !o.acknowledgedAt && (
                            <Button
                              size="sm"
                              loading={acknowledge.isPending && acknowledge.variables === o.id}
                              onClick={() => acknowledge.mutate(o.id)}
                            >
                              {t('Acknowledge')}
                            </Button>
                          )}
                          {o.acknowledgedAt && !o.releasedAt && (
                            <Button
                              size="sm"
                              variant="secondary"
                              loading={release.isPending && release.variables === o.id}
                              onClick={() => release.mutate(o.id)}
                            >
                              {t('Release to patient')}
                            </Button>
                          )}
                          {o.acknowledgedAt && (
                            <Badge tone="success">
                              {t('Reviewed {date}', { date: formatDateTime(o.acknowledgedAt) })}
                            </Badge>
                          )}
                          {o.releasedAt && <Badge tone="info">{t('Released to patient')}</Badge>}
                          {(o.status === 'ORDERED' || o.status === 'SCHEDULED') && (
                            <Button size="sm" variant="secondary" onClick={() => setCancelling(o)}>
                              {t('Cancel')}
                            </Button>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )
        }
      </QueryView>
      {ordering && <OrderImagingDialog patientId={patientId} onClose={() => setOrdering(false)} />}
      {viewing && <ReportDialog order={viewing} onClose={() => setViewing(null)} />}
      {cancelling && <CancelDialog order={cancelling} onClose={() => setCancelling(null)} />}
    </Card>
  );
}

export function ReportDialog({ order, onClose }: { order: ImagingOrder; onClose: () => void }) {
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('{modality} · {bodyPart}', {
        modality: modalityLabel(order.modality),
        bodyPart: order.bodyPart,
      })}
      wide
    >
      {order.critical && <Badge tone="danger">{t('Critical finding')}</Badge>}
      <DefinitionList
        items={[
          [t('Accession number'), <span className="mono">{order.accessionNumber}</span>],
          [t('Clinical question'), order.clinicalQuestion],
          [t('Performed'), order.performedAt ? formatDateTime(order.performedAt) : null],
          [
            t('Reported by'),
            order.reportedBy ? `${order.reportedBy} · ${formatDateTime(order.reportedAt)}` : null,
          ],
        ]}
      />
      <h3>{t('Impression')}</h3>
      <p>
        <strong>{order.impression}</strong>
      </p>
      <h3>{t('Findings')}</h3>
      <p style={{ whiteSpace: 'pre-wrap' }}>{order.findings}</p>
      <div className="form-actions">
        <Button variant="secondary" onClick={onClose}>
          {t('Close')}
        </Button>
      </div>
    </Dialog>
  );
}

function CancelDialog({ order, onClose }: { order: ImagingOrder; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const cancel = useImagingAction(
    () => ({ path: `/orders/${order.id}/cancel`, body: { reason } }),
    onClose,
  );
  return (
    <Dialog open onClose={onClose} title={t('Cancel imaging request')}>
      <TextAreaField
        label={t('Reason')}
        required
        minLength={5}
        maxLength={300}
        value={reason}
        onChange={(e) => setReason(e.currentTarget.value)}
      />
      <ErrorAlert error={cancel.error} />
      <div className="form-actions">
        <Button variant="secondary" onClick={onClose}>
          {t('Back')}
        </Button>
        <Button
          variant="danger"
          disabled={reason.trim().length < 5}
          loading={cancel.isPending}
          onClick={() => cancel.mutate(undefined)}
        >
          {t('Cancel request')}
        </Button>
      </div>
    </Dialog>
  );
}

function OrderImagingDialog({ patientId, onClose }: { patientId: string; onClose: () => void }) {
  const demographics = useQuery({
    queryKey: ['patient', patientId, 'demographics'],
    queryFn: () => api<Demographics>(`/patients/${patientId}`),
  });
  const [modality, setModality] = useState<Modality>('XRAY');
  const [contrast, setContrast] = useState(false);
  const [implants, setImplants] = useState<'NO' | 'YES' | ''>('');
  const order = useImagingAction(
    (body: Record<string, unknown>) => ({ path: '/orders', body }),
    onClose,
  );
  const patient = demographics.data
    ? { sex: demographics.data.sex, age: age(demographics.data.dateOfBirth) }
    : null;
  const q = safetyQuestions(modality, patient);
  const listId = `body-parts-${patientId}`;

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const val = (k: string) => {
      const v = f.get(k);
      return typeof v === 'string' && v.trim() ? v.trim() : undefined;
    };
    const safetyChecks: SafetyChecks = {};
    if (q.pregnancy && val('pregnancy'))
      safetyChecks.pregnancy = val('pregnancy') as SafetyChecks['pregnancy'];
    if (q.contrast) {
      safetyChecks.contrast = contrast;
      if (contrast) {
        safetyChecks.contrastAllergy = val('contrastAllergy') as SafetyChecks['contrastAllergy'];
        safetyChecks.renalImpairment = val('renalImpairment') as SafetyChecks['renalImpairment'];
      }
    }
    if (q.implants && implants) {
      safetyChecks.implants = implants;
      if (implants === 'YES') safetyChecks.implantsNote = val('implantsNote');
    }
    if (val('safetyNote')) safetyChecks.note = val('safetyNote');
    order.mutate({
      patientId,
      modality,
      bodyPart: val('bodyPart'),
      clinicalQuestion: val('clinicalQuestion'),
      priority: val('priority') ?? 'ROUTINE',
      safetyChecks,
    });
  }

  return (
    <Dialog open onClose={onClose} title={t('Order imaging')} wide>
      <form onSubmit={onSubmit}>
        <div className="form-grid">
          <SelectField
            label={t('Modality')}
            required
            value={modality}
            onChange={(e) => setModality(e.currentTarget.value as Modality)}
            options={MODALITIES.map((m) => ({ value: m, label: modalityLabel(m) }))}
          />
          <SelectField
            label={t('Priority')}
            name="priority"
            required
            defaultValue="ROUTINE"
            options={[
              { value: 'ROUTINE', label: t('Routine') },
              { value: 'URGENT', label: t('Urgent') },
              { value: 'STAT', label: t('STAT (immediately)') },
            ]}
          />
        </div>
        <TextField
          label={t('Body part / examination')}
          name="bodyPart"
          required
          minLength={2}
          maxLength={120}
          list={listId}
          key={modality}
          hint={t('Choose a common examination or type your own.')}
        />
        <datalist id={listId}>
          {bodyPartPresets(modality).map((p) => (
            <option key={p} value={p} />
          ))}
        </datalist>
        <TextAreaField
          label={t('Clinical question')}
          name="clinicalQuestion"
          required
          minLength={5}
          maxLength={1000}
          rows={3}
          hint={t('What should radiology answer? Include relevant history.')}
        />
        <fieldset>
          <legend>{t('Safety screening')}</legend>
          {q.pregnancy && (
            <SelectField
              label={t('Could the patient be pregnant?')}
              name="pregnancy"
              required={q.pregnancyRequired}
              placeholder={t('Not asked')}
              options={yesNoUnknownOptions()}
              hint={
                q.pregnancyRequired
                  ? t('Required for examinations with radiation in women aged 12–55.')
                  : undefined
              }
            />
          )}
          {q.contrast && (
            <label className="checkbox">
              <input
                type="checkbox"
                checked={contrast}
                onChange={(e) => setContrast(e.currentTarget.checked)}
              />
              <span>{t('Contrast medium requested')}</span>
            </label>
          )}
          {q.contrast && contrast && (
            <div className="form-grid">
              <SelectField
                label={t('Known contrast allergy?')}
                name="contrastAllergy"
                required
                placeholder={t('Choose')}
                options={yesNoUnknownOptions()}
              />
              <SelectField
                label={t('Reduced kidney function?')}
                name="renalImpairment"
                required
                placeholder={t('Choose')}
                options={yesNoUnknownOptions()}
              />
            </div>
          )}
          {q.implants && (
            <SelectField
              label={t('Pacemaker, implant or metal in the body?')}
              required
              value={implants}
              onChange={(e) => setImplants(e.currentTarget.value as 'NO' | 'YES' | '')}
              placeholder={t('Choose')}
              options={[
                { value: 'NO', label: t('No') },
                { value: 'YES', label: t('Yes') },
              ]}
            />
          )}
          {q.implants && implants === 'YES' && (
            <TextField
              label={t('Describe the implant')}
              name="implantsNote"
              required
              minLength={5}
              maxLength={500}
              hint={t('Type and model if known, so radiology can check MRI safety.')}
            />
          )}
          <TextField label={t('Other safety information')} name="safetyNote" maxLength={500} />
        </fieldset>
        <ErrorAlert error={order.error ?? demographics.error} />
        <div className="form-actions">
          <Button variant="secondary" onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button type="submit" loading={order.isPending}>
            {t('Send request')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** Short safety line for lists. */
export function SafetyLine({ checks }: { checks: SafetyChecks | null }) {
  const lines = safetySummary(checks);
  return lines.length ? <div className="muted">{lines.join(' · ')}</div> : null;
}
