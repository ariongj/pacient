import QRCode from 'qrcode';
import { useState, type FormEvent } from 'react';
import {
  categoryLabel,
  criticalityLabel,
  equipmentStatusLabel,
  equipmentStatusTone,
  eventKindLabel,
  maintenanceLabel,
  maintenanceTone,
  useEquipmentItem,
  useRecordEquipmentEvent,
  useRetireEquipment,
  useSaveEquipment,
  type EquipmentDetail,
  type EquipmentItem,
  type EquipmentMeta,
  type EventKind,
} from '../../api/equipment';
import {
  Alert,
  Badge,
  Button,
  DefinitionList,
  Dialog,
  ErrorAlert,
  QueryView,
  SelectField,
  Table,
  TextAreaField,
  TextField,
  formValues,
} from '../../components/ui';
import { formatDate, formatDateTime } from '../../format';
import { t } from '../../i18n';
import { useUser } from '../../auth/AuthContext';

export function StatusBadge({ status }: { status: string }) {
  return <Badge tone={equipmentStatusTone(status)}>{equipmentStatusLabel(status)}</Badge>;
}

export function MaintenanceBadge({ item }: { item: Pick<EquipmentItem, 'maintenance'> }) {
  if (item.maintenance === 'NONE' || item.maintenance === 'OK') return null;
  return (
    <Badge tone={maintenanceTone(item.maintenance)}>{maintenanceLabel(item.maintenance)}</Badge>
  );
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Opens a print window with a 62 × 29 mm asset label: QR code (link to the item) and the tag. */
async function printLabel(item: EquipmentItem, facilityLabel: string) {
  const url = `${window.location.origin}/equipment?item=${item.id}`;
  const qr = await QRCode.toDataURL(url, { margin: 0, width: 240, errorCorrectionLevel: 'M' });
  const win = window.open('', '_blank', 'width=480,height=320');
  if (!win) return;
  win.document
    .write(`<!doctype html><html lang="${escapeHtml(document.documentElement.lang)}"><head>
<meta charset="utf-8"><title>${escapeHtml(item.assetTag)}</title>
<style>
  @page { size: 62mm 29mm; margin: 0; }
  body { margin: 0; font-family: Arial, Helvetica, sans-serif; color: #000; }
  .label { width: 62mm; height: 29mm; box-sizing: border-box; padding: 2mm; display: flex; gap: 2mm; align-items: center; }
  img { width: 24mm; height: 24mm; image-rendering: pixelated; }
  .tag { font-size: 13pt; font-weight: 700; letter-spacing: 0.03em; }
  .line { font-size: 7.5pt; line-height: 1.2; }
</style></head><body>
<div class="label">
  <img src="${qr}" alt="">
  <div>
    <div class="tag">${escapeHtml(item.assetTag)}</div>
    <div class="line">${escapeHtml(item.name)}</div>
    <div class="line">${escapeHtml(item.unitName ?? '')}</div>
    <div class="line">${escapeHtml(facilityLabel)}</div>
  </div>
</div>
<script>window.onload = () => { window.print(); };</script>
</body></html>`);
  win.document.close();
}

/** Item details with its history and the actions the user may take. */
export function ItemDialog({
  id,
  meta,
  onClose,
  onEdit,
}: {
  id: string | null;
  meta: EquipmentMeta;
  onClose: () => void;
  onEdit: (item: EquipmentItem) => void;
}) {
  const item = useEquipmentItem(id);
  const [recording, setRecording] = useState<EventKind | null>(null);
  const [retiring, setRetiring] = useState(false);
  return (
    <Dialog open={Boolean(id)} onClose={onClose} title={t('Medical equipment')} wide>
      <QueryView query={item}>
        {(d) =>
          recording ? (
            <EventForm
              item={d}
              kind={recording}
              canManage={meta.canManage}
              onDone={() => setRecording(null)}
            />
          ) : retiring ? (
            <RetireForm item={d} onDone={() => setRetiring(false)} />
          ) : (
            <ItemDetail
              d={d}
              meta={meta}
              onRecord={setRecording}
              onRetire={() => setRetiring(true)}
              onEdit={() => onEdit(d)}
            />
          )
        }
      </QueryView>
    </Dialog>
  );
}

function ItemDetail({
  d,
  meta,
  onRecord,
  onRetire,
  onEdit,
}: {
  d: EquipmentDetail;
  meta: EquipmentMeta;
  onRecord: (k: EventKind) => void;
  onRetire: () => void;
  onEdit: () => void;
}) {
  const retired = d.status === 'RETIRED';
  const user = useUser();
  return (
    <div className="stack">
      <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
        <StatusBadge status={d.status} />
        <MaintenanceBadge item={d} />
        {d.criticality === 'HIGH' && <Badge tone="info">{criticalityLabel('HIGH')}</Badge>}
      </div>
      <DefinitionList
        items={[
          [t('Asset tag|equipment'), <code key="tag">{d.assetTag}</code>],
          [t('Name|equipment'), d.name],
          [t('Category'), categoryLabel(d.category)],
          [
            t('Manufacturer and model'),
            [d.manufacturer, d.model].filter(Boolean).join(' · ') || '—',
          ],
          [t('Serial number|equipment'), d.serialNumber ?? '—'],
          [t('Ward or unit'), d.unitName ?? t('Not assigned to a ward')],
          [t('Criticality|equipment'), criticalityLabel(d.criticality)],
          [
            t('Service interval'),
            d.serviceIntervalDays
              ? t('Every {days} days', { days: d.serviceIntervalDays })
              : t('No service schedule'),
          ],
          [t('Last service|equipment'), d.lastServiceAt ? formatDate(d.lastServiceAt) : '—'],
          [t('Next service due'), d.nextServiceDue ? formatDate(d.nextServiceDue) : '—'],
          [t('In use since'), d.commissionedOn ? formatDate(d.commissionedOn) : '—'],
        ]}
      />
      {!retired && (
        <div className="form-actions" style={{ justifyContent: 'flex-start', flexWrap: 'wrap' }}>
          {meta.canReportFault && (
            <Button variant="danger" onClick={() => onRecord('FAULT')}>
              {t('Report a fault')}
            </Button>
          )}
          {meta.canManage && (
            <>
              <Button variant="secondary" onClick={() => onRecord('SERVICE')}>
                {t('Record a service')}
              </Button>
              <Button variant="secondary" onClick={() => onRecord('REPAIR')}>
                {t('Record a repair')}
              </Button>
              <Button variant="secondary" onClick={() => onRecord('STATUS')}>
                {t('Change status')}
              </Button>
              <Button variant="secondary" onClick={onEdit}>
                {t('Edit')}
              </Button>
              <Button variant="ghost" onClick={onRetire}>
                {t('Retire|equipment')}
              </Button>
            </>
          )}
          <Button variant="ghost" onClick={() => void printLabel(d, user.facility?.name ?? '')}>
            {t('Print asset label')}
          </Button>
        </div>
      )}
      <h3>{t('History')}</h3>
      {d.events.length === 0 ? (
        <p className="muted">{t('Nothing recorded yet.')}</p>
      ) : (
        <Table caption={t('Equipment history')}>
          <thead>
            <tr>
              <th scope="col">{t('Date')}</th>
              <th scope="col">{t('Event')}</th>
              <th scope="col">{t('Description')}</th>
              <th scope="col">{t('Status afterwards')}</th>
              <th scope="col">{t('Recorded by')}</th>
            </tr>
          </thead>
          <tbody>
            {d.events.map((e) => (
              <tr key={e.id}>
                <td>{formatDateTime(e.occurredAt)}</td>
                <td>
                  {e.kind === 'FAULT' ? (
                    <Badge tone="danger">{eventKindLabel(e.kind)}</Badge>
                  ) : (
                    eventKindLabel(e.kind)
                  )}
                </td>
                <td>
                  {e.description}
                  {e.incidentReference && (
                    <div className="muted">
                      {t('Safety incident {reference}', { reference: e.incidentReference })}
                    </div>
                  )}
                </td>
                <td>{e.status ? equipmentStatusLabel(e.status) : '—'}</td>
                <td>{e.recordedBy}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}

const nowLocal = () => {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
};

function EventForm({
  item,
  kind,
  canManage,
  onDone,
}: {
  item: EquipmentItem;
  kind: EventKind;
  canManage: boolean;
  onDone: () => void;
}) {
  const record = useRecordEquipmentEvent();
  const [harm, setHarm] = useState(false);
  const lifeSupport = item.criticality === 'HIGH';
  const title =
    kind === 'FAULT'
      ? t('Report a fault')
      : kind === 'SERVICE'
        ? t('Record a service')
        : kind === 'REPAIR'
          ? t('Record a repair')
          : t('Change status');

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const v = formValues(e.currentTarget);
    record.mutate(
      {
        id: item.id,
        body: {
          kind,
          description: v.description!,
          occurredAt: v.occurredAt ? new Date(v.occurredAt).toISOString() : undefined,
          status: (v.status || undefined) as never,
          incidentReference: v.incidentReference || undefined,
        },
      },
      { onSuccess: onDone },
    );
  }

  return (
    <form className="stack" onSubmit={onSubmit}>
      <h3>
        {title}: {item.assetTag} · {item.name}
      </h3>
      {kind === 'FAULT' && lifeSupport && (
        <Alert tone="warning" title={t('Life-support equipment')}>
          {t(
            'A fault takes this equipment out of service until a repair is recorded. Use the reserve equipment and tell the nurse in charge.',
          )}
        </Alert>
      )}
      <TextAreaField
        label={kind === 'FAULT' ? t('What is wrong?') : t('What was done?')}
        name="description"
        required
        minLength={5}
        maxLength={500}
        rows={3}
      />
      {canManage && kind !== 'FAULT' && (
        <TextField
          label={t('Date and time')}
          name="occurredAt"
          type="datetime-local"
          defaultValue={nowLocal()}
          max={nowLocal()}
        />
      )}
      {kind === 'FAULT' && !lifeSupport && (
        <SelectField
          label={t('Can it still be used safely?')}
          name="status"
          defaultValue="OUT_OF_SERVICE"
          options={[
            { value: 'OUT_OF_SERVICE', label: t('No – take it out of service') },
            { value: '', label: t('Yes – keep using it, but have it checked') },
          ]}
        />
      )}
      {(kind === 'STATUS' || kind === 'REPAIR') && (
        <SelectField
          label={t('Status afterwards')}
          name="status"
          required={kind === 'STATUS'}
          defaultValue={kind === 'REPAIR' ? 'IN_SERVICE' : ''}
          placeholder={kind === 'STATUS' ? t('Choose…') : undefined}
          options={(['IN_SERVICE', 'OUT_OF_SERVICE', 'IN_MAINTENANCE'] as const).map((s) => ({
            value: s,
            label: equipmentStatusLabel(s),
          }))}
        />
      )}
      {kind === 'FAULT' && (
        <fieldset className="stack">
          <label className="checkbox">
            <input type="checkbox" checked={harm} onChange={(e) => setHarm(e.target.checked)} />{' '}
            {t('A patient was harmed or could have been harmed')}
          </label>
          {harm && (
            <>
              <p className="muted">
                {t(
                  'Report it as a safety incident too (Report an incident, category Medical equipment), then enter the incident reference here so both records are linked.',
                )}
              </p>
              <TextField
                label={t('Safety incident reference')}
                name="incidentReference"
                placeholder="INC-2026-00042"
                maxLength={30}
              />
            </>
          )}
        </fieldset>
      )}
      <ErrorAlert error={record.error} />
      <div className="form-actions">
        <Button variant="secondary" onClick={onDone}>
          {t('Back')}
        </Button>
        <Button
          type="submit"
          variant={kind === 'FAULT' ? 'danger' : 'primary'}
          loading={record.isPending}
        >
          {t('Save')}
        </Button>
      </div>
    </form>
  );
}

function RetireForm({ item, onDone }: { item: EquipmentItem; onDone: () => void }) {
  const retire = useRetireEquipment();
  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        retire.mutate(
          { id: item.id, reason: formValues(e.currentTarget).reason! },
          { onSuccess: onDone },
        );
      }}
    >
      <h3>
        {t('Retire|equipment')}: {item.assetTag} · {item.name}
      </h3>
      <p className="muted">
        {t(
          'Retired equipment stays in the register with its history but is no longer listed or scheduled for service.',
        )}
      </p>
      <TextAreaField
        label={t('Reason')}
        name="reason"
        required
        minLength={5}
        maxLength={500}
        rows={2}
      />
      <ErrorAlert error={retire.error} />
      <div className="form-actions">
        <Button variant="secondary" onClick={onDone}>
          {t('Back')}
        </Button>
        <Button type="submit" variant="danger" loading={retire.isPending}>
          {t('Retire|equipment')}
        </Button>
      </div>
    </form>
  );
}

/** Add or edit an item (director). */
export function ItemFormDialog({
  open,
  item,
  meta,
  onClose,
}: {
  open: boolean;
  item: EquipmentItem | null;
  meta: EquipmentMeta;
  onClose: () => void;
}) {
  const save = useSaveEquipment();
  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const v = formValues(e.currentTarget);
    const body = {
      assetTag: v.assetTag,
      category: v.category as EquipmentItem['category'],
      name: v.name,
      manufacturer: v.manufacturer || null,
      model: v.model || null,
      serialNumber: v.serialNumber || null,
      unitId: v.unitId || null,
      criticality: v.criticality as EquipmentItem['criticality'],
      serviceIntervalDays: v.serviceIntervalDays ? Number(v.serviceIntervalDays) : null,
      commissionedOn: v.commissionedOn || null,
      ...(item ? {} : { lastServiceAt: v.lastServiceAt || null }),
    };
    save.mutate({ id: item?.id, body }, { onSuccess: onClose });
  }
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={item ? t('Edit equipment') : t('Add equipment')}
      wide
    >
      <form className="stack" onSubmit={onSubmit} key={item?.id ?? 'new'}>
        <div className="form-grid">
          <TextField
            label={t('Asset tag|equipment')}
            name="assetTag"
            required
            defaultValue={item?.assetTag}
            pattern="[A-Za-z0-9][A-Za-z0-9\-]{1,39}"
            hint={t('Letters, digits and dashes, as on the label')}
          />
          <TextField
            label={t('Name|equipment')}
            name="name"
            required
            minLength={2}
            maxLength={200}
            defaultValue={item?.name}
          />
          <SelectField
            label={t('Category')}
            name="category"
            required
            defaultValue={item?.category ?? ''}
            placeholder={t('Choose…')}
            options={meta.categories.map((c) => ({ value: c, label: categoryLabel(c) }))}
          />
          <SelectField
            label={t('Criticality|equipment')}
            name="criticality"
            required
            defaultValue={item?.criticality ?? ''}
            placeholder={t('Choose…')}
            options={meta.criticalities.map((c) => ({ value: c, label: criticalityLabel(c) }))}
          />
          <SelectField
            label={t('Ward or unit')}
            name="unitId"
            defaultValue={item?.unitId ?? ''}
            placeholder={t('Not assigned to a ward')}
            options={meta.units.map((u) => ({ value: u.id, label: u.name }))}
          />
          <TextField
            label={t('Manufacturer|equipment')}
            name="manufacturer"
            maxLength={120}
            defaultValue={item?.manufacturer ?? ''}
          />
          <TextField
            label={t('Model|equipment')}
            name="model"
            maxLength={120}
            defaultValue={item?.model ?? ''}
          />
          <TextField
            label={t('Serial number|equipment')}
            name="serialNumber"
            maxLength={120}
            defaultValue={item?.serialNumber ?? ''}
          />
          <TextField
            label={t('Service interval (days)')}
            name="serviceIntervalDays"
            type="number"
            min={1}
            max={3650}
            defaultValue={item?.serviceIntervalDays ?? ''}
          />
          <TextField
            label={t('In use since')}
            name="commissionedOn"
            type="date"
            defaultValue={item?.commissionedOn ?? ''}
          />
          {!item && (
            <TextField label={t('Last service|equipment')} name="lastServiceAt" type="date" />
          )}
        </div>
        <ErrorAlert error={save.error} />
        <div className="form-actions">
          <Button variant="secondary" onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button type="submit" loading={save.isPending}>
            {t('Save')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
