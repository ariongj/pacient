import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '../../../api/client';
import { useSafetyCheck, useStoredAlerts, type SafetyAlert } from '../../../api/safety';
import { SafetyAlertList, StoredAlertSummary } from '../../tools/SafetyAlerts';
import { itemName, type CatalogItem } from '../../../api/stock';
import { CatalogPicker } from '../../pharmacy/CatalogPicker';
import type { Allergy, Encounter, Prescription } from '../../../api/types';
import {
  Alert,
  Button,
  Card,
  compact,
  Dialog,
  EmptyState,
  ErrorAlert,
  formValues,
  QueryView,
  StatusBadge,
  Table,
  TextAreaField,
  TextField,
} from '../../../components/ui';
import { formatDate } from '../../../format';
import { EncounterSelect, useChartMutation, useChartRole } from './shared';
import { useSection } from './useSection';
import { t } from '../../../i18n';

/** The value after it has stopped changing for `ms` (avoids a safety check per keystroke). */
function useDebounced<T>(value: T, ms = 400): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

export function MedicationsTab({
  patientId,
  encounters,
  allergies,
}: {
  patientId: string;
  encounters: Encounter[];
  allergies: Allergy[];
}) {
  const list = useSection<Prescription>(patientId, 'prescriptions');
  const [open, setOpen] = useState(false);
  /** Optional national catalogue item: fills the medication name and lets the pharmacy track stock. */
  const [catalogItem, setCatalogItem] = useState<CatalogItem | null>(null);
  const [medication, setMedication] = useState('');
  /** Reasons to proceed despite blocking safety alerts, by alert code. */
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const create = useChartMutation(
    patientId,
    (body: Record<string, unknown>) => ({ path: '/prescriptions', method: 'POST', body }),
    () => {
      setOpen(false);
      setCatalogItem(null);
      setMedication('');
      setReasons({});
    },
  );
  const update = useChartMutation(patientId, ({ id, status }: { id: string; status: string }) => ({
    path: `/prescriptions/${id}`,
    method: 'PATCH',
    body: { status },
  }));
  const { isDoctor, isNurse } = useChartRole();
  const debouncedMedication = useDebounced(medication);
  const check = useSafetyCheck(
    patientId,
    debouncedMedication,
    catalogItem?.id ?? null,
    open && isDoctor,
  );
  const stored = useStoredAlerts(patientId, isDoctor || isNurse);
  // If the server found blocking alerts the live check had not shown yet, use its list.
  const blockedByServer =
    create.error instanceof ApiError && create.error.code === 'SAFETY_ALERTS'
      ? ((create.error.details as { alerts?: SafetyAlert[] } | undefined)?.alerts ?? null)
      : null;
  const alerts = blockedByServer ?? check.data?.alerts ?? [];
  const [resubmitting, setResubmitting] = useState<Prescription | null>(null);
  const resubmit = useChartMutation(
    patientId,
    ({ id, body }: { id: string; body: Record<string, unknown> }) => ({
      path: `/prescriptions/${id}/resubmit`,
      method: 'POST',
      body,
    }),
    () => setResubmitting(null),
  );
  const activeAllergies = allergies.filter(
    (a) => a.verificationStatus === 'CONFIRMED' || a.verificationStatus === 'UNCONFIRMED',
  );

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const overrides = alerts
      .filter((a) => a.blocking && (reasons[a.code] ?? '').trim().length >= 10)
      .map((a) => ({ code: a.code, reason: reasons[a.code]!.trim() }));
    create.mutate({
      ...compact({ ...formValues(e.currentTarget), catalogItemId: catalogItem?.id ?? undefined }),
      ...(overrides.length ? { overrides } : {}),
    });
  }

  return (
    <Card
      title={t('Medications')}
      actions={
        <span className="row">
          <Link to={`/tools/interactions?patient=${patientId}`}>{t('Interaction checker')}</Link>
          {isDoctor && (
            <Button size="sm" onClick={() => setOpen(true)}>
              {t('Prescribe')}
            </Button>
          )}
        </span>
      }
    >
      <p className="muted">
        {t(
          'New prescriptions go to the pharmacy for verification before they can be dispensed or administered.',
        )}
      </p>
      <ErrorAlert error={update.error} />
      <QueryView query={list}>
        {(items) =>
          items.length === 0 ? (
            <EmptyState title={t('No prescriptions')} />
          ) : (
            <Table caption={t('Prescriptions')}>
              <thead>
                <tr>
                  <th>{t('Medication')}</th>
                  <th>{t('Dose & frequency')}</th>
                  <th>{t('Period')}</th>
                  <th>{t('Prescriber')}</th>
                  <th>{t('Status')}</th>
                  <th>{t('Pharmacy')}</th>
                  {isDoctor && (
                    <th>
                      <span className="sr-only">{t('Actions')}</span>
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {items.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <strong>{p.medication}</strong>
                      <div className="muted">{p.route}</div>
                      {p.instructions && <div className="muted">{p.instructions}</div>}
                      <StoredAlertSummary alerts={stored.data?.[p.id]} />
                    </td>
                    <td>
                      {p.dosage} · {p.frequency}
                    </td>
                    <td>
                      {formatDate(p.startDate)} – {p.endDate ? formatDate(p.endDate) : 'ongoing'}
                    </td>
                    <td>{p.doctorName}</td>
                    <td>
                      <StatusBadge value={p.status} />
                    </td>
                    <td>
                      {p.pharmacyStatus && <StatusBadge value={p.pharmacyStatus} />}
                      {p.pharmacistNote && (
                        <div className="muted" style={{ maxWidth: '22rem' }}>
                          {t('Pharmacist: {note}', { note: p.pharmacistNote })}
                        </div>
                      )}
                    </td>
                    {isDoctor && (
                      <td>
                        {p.status === 'ACTIVE' && (
                          <div className="row">
                            {p.pharmacyStatus === 'RETURNED' && (
                              <Button size="sm" onClick={() => setResubmitting(p)}>
                                {t('Resubmit')}
                              </Button>
                            )}
                            <Button
                              size="sm"
                              variant="secondary"
                              disabled={update.isPending}
                              onClick={() => update.mutate({ id: p.id, status: 'COMPLETED' })}
                            >
                              {t('Complete')}
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={update.isPending}
                              onClick={() => update.mutate({ id: p.id, status: 'CANCELLED' })}
                            >
                              {t('Stop')}
                            </Button>
                          </div>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </Table>
          )
        }
      </QueryView>
      <Dialog
        open={resubmitting !== null}
        onClose={() => setResubmitting(null)}
        title={t('Resubmit to pharmacy')}
        wide
      >
        {resubmitting && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              resubmit.mutate({
                id: resubmitting.id,
                body: compact(formValues(e.currentTarget)),
              });
            }}
          >
            <Alert
              tone="warning"
              title={t('Returned: {medication}', { medication: resubmitting.medication })}
            >
              {resubmitting.pharmacistNote ?? t('The pharmacy returned this prescription.')}
            </Alert>
            <p className="muted">
              {t(
                'Adjust the plan if needed and explain how the pharmacist’s concern was addressed. If the medicine is no longer appropriate, stop the prescription instead.',
              )}
            </p>
            <div className="form-grid">
              <TextField
                label={t('Dosage')}
                name="dosage"
                defaultValue={resubmitting.dosage}
                maxLength={100}
              />
              <TextField
                label={t('Frequency')}
                name="frequency"
                defaultValue={resubmitting.frequency}
                maxLength={100}
              />
            </div>
            <TextAreaField
              label={t('Instructions for the patient')}
              name="instructions"
              defaultValue={resubmitting.instructions ?? ''}
              maxLength={2000}
              rows={2}
            />
            <TextAreaField
              label={t('Note to the pharmacist')}
              name="note"
              required
              minLength={3}
              maxLength={1000}
              rows={3}
            />
            <ErrorAlert error={resubmit.error} />
            <div className="form-actions">
              <Button variant="secondary" onClick={() => setResubmitting(null)}>
                {t('Cancel')}
              </Button>
              <Button type="submit" loading={resubmit.isPending}>
                {t('Resubmit')}
              </Button>
            </div>
          </form>
        )}
      </Dialog>
      <Dialog open={open} onClose={() => setOpen(false)} title={t('New prescription')} wide>
        <form onSubmit={onSubmit}>
          {activeAllergies.length > 0 && (
            <Alert tone="danger" title={t('Recorded allergies')}>
              {activeAllergies
                .map((a) => `${a.substance} (${a.severity.toLowerCase().replace('_', ' ')})`)
                .join(', ')}
            </Alert>
          )}
          <CatalogPicker
            label={t('Medicine from the national catalogue (optional)')}
            value={catalogItem}
            onChange={(item) => {
              setCatalogItem(item);
              if (item) setMedication(itemName(item));
            }}
            hint={t('Choosing a catalogue item lets the pharmacy dispense it from stock.')}
          />
          <div className="form-grid">
            <TextField
              label={t('Medication')}
              name="medication"
              required
              minLength={2}
              maxLength={200}
              value={medication}
              onChange={(e) => setMedication(e.target.value)}
            />
            <TextField
              label={t('Dosage')}
              name="dosage"
              required
              maxLength={100}
              hint={t('e.g. 5 mg')}
            />
            <TextField
              label={t('Frequency')}
              name="frequency"
              required
              maxLength={100}
              hint={t('e.g. once daily')}
            />
            <TextField label={t('Route')} name="route" defaultValue="oral" maxLength={50} />
            <TextField
              label={t('Start date')}
              name="startDate"
              type="date"
              required
              defaultValue={new Date().toISOString().slice(0, 10)}
            />
            <TextField label={t('End date')} name="endDate" type="date" />
          </div>
          <EncounterSelect encounters={encounters} />
          <TextAreaField
            label={t('Instructions for the patient')}
            name="instructions"
            maxLength={2000}
            rows={3}
          />
          <section aria-live="polite">
            {check.isFetching && <p className="muted">{t('Checking medication safety…')}</p>}
            {alerts.length > 0 && (
              <>
                <h3>{t('Medication safety')}</h3>
                {alerts.some((a) => a.blocking) && (
                  <Alert tone="danger" title={t('Serious safety alerts')}>
                    {t(
                      'Choose another medicine, or record for each serious alert why it is safe to proceed.',
                    )}
                  </Alert>
                )}
                <SafetyAlertList
                  alerts={alerts}
                  reasons={reasons}
                  onReason={(code, reason) => setReasons((r) => ({ ...r, [code]: reason }))}
                />
              </>
            )}
            {!check.isFetching &&
              check.data &&
              alerts.length === 0 &&
              debouncedMedication.trim().length >= 3 && (
                <p className="muted">{t('No safety alerts found by the automated checks.')}</p>
              )}
          </section>
          {!blockedByServer && <ErrorAlert error={create.error} />}
          <div className="form-actions">
            <Button variant="secondary" onClick={() => setOpen(false)}>
              {t('Cancel')}
            </Button>
            <Button type="submit" loading={create.isPending}>
              {t('Prescribe')}
            </Button>
          </div>
        </form>
      </Dialog>
    </Card>
  );
}
