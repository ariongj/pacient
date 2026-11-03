import { useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  itemName,
  movementLabel,
  STATUS_TONE,
  statusLabel,
  useItemBatches,
  useMovements,
  useStockLevels,
  useStockMutation,
  type CatalogItem,
  type MovementType,
  type StockBatch,
  type StockLevel,
} from '../../api/stock';
import {
  Alert,
  Badge,
  Button,
  Card,
  Dialog,
  EmptyState,
  ErrorAlert,
  Grid,
  PageHeader,
  Pagination,
  QueryView,
  SelectField,
  Stat,
  TabPanel,
  Table,
  Tabs,
  TextAreaField,
  TextField,
} from '../../components/ui';
import { formatDate, formatDateTime, formatNumber } from '../../format';
import { t, tn } from '../../i18n';
import { CatalogPicker } from './CatalogPicker';

type Tab = 'levels' | 'receive' | 'movements';
type StatusFilter = 'ALL' | 'ATTENTION' | 'LOW' | 'OUT' | 'EXPIRING' | 'EXPIRED';

function StatusBadges({ level }: { level: Pick<StockLevel, 'flags'> }) {
  if (!level.flags.length) return <Badge tone="success">{statusLabel('OK')}</Badge>;
  return (
    <span className="row" style={{ gap: '0.25rem', flexWrap: 'wrap' }}>
      {level.flags.map((f) => (
        <Badge key={f} tone={STATUS_TONE[f]}>
          {statusLabel(f)}
        </Badge>
      ))}
    </span>
  );
}

/* ----------------------------------------------------------------------------- levels */

function LevelsTab({ canEdit, onOpen }: { canEdit: boolean; onOpen: (itemId: string) => void }) {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<StatusFilter>('ALL');
  const [all, setAll] = useState(false);
  const levels = useStockLevels({ q, status, all });
  const counts = levels.data?.counts ?? {};
  return (
    <div className="stack">
      <Grid min={150}>
        <Stat label={t('Items in stock')} value={formatNumber(levels.data?.total ?? 0)} />
        <Stat
          label={t('Low stock')}
          value={formatNumber(counts.LOW ?? 0)}
          tone={counts.LOW ? 'warning' : undefined}
        />
        <Stat
          label={t('Out of stock')}
          value={formatNumber(counts.OUT ?? 0)}
          tone={counts.OUT ? 'danger' : undefined}
        />
        <Stat
          label={t('Expiring within 90 days')}
          value={formatNumber(counts.EXPIRING ?? 0)}
          tone={counts.EXPIRING ? 'info' : undefined}
        />
        <Stat
          label={t('Batches past expiry')}
          value={formatNumber(counts.EXPIRED ?? 0)}
          tone={counts.EXPIRED ? 'danger' : undefined}
          hint={counts.EXPIRED ? t('Write them off from the batch list') : undefined}
        />
      </Grid>
      <Card>
        <div className="search-bar">
          <TextField
            label={t('Search')}
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t('Name or ATC code')}
          />
          <SelectField
            label={t('Show')}
            value={status}
            onChange={(e) => setStatus(e.target.value as StatusFilter)}
            options={[
              { value: 'ALL', label: t('All items') },
              { value: 'ATTENTION', label: t('Needs attention') },
              { value: 'LOW', label: t('Low stock') },
              { value: 'OUT', label: t('Out of stock') },
              { value: 'EXPIRING', label: t('Expiring soon') },
              { value: 'EXPIRED', label: t('Expired stock') },
            ]}
          />
          <label className="checkbox">
            <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />
            <span>{t('Include catalogue items not stocked here')}</span>
          </label>
        </div>
        <QueryView query={levels}>
          {(data) =>
            data.items.length === 0 ? (
              <EmptyState title={t('No items match')} />
            ) : (
              <Table caption={t('Stock levels')}>
                <thead>
                  <tr>
                    <th>{t('Medicine')}</th>
                    <th>{t('On hand')}</th>
                    <th>{t('Reorder level')}</th>
                    <th>{t('Next expiry')}</th>
                    <th>{t('Status')}</th>
                    <th>
                      <span className="sr-only">{t('Actions')}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((l) => (
                    <tr key={l.itemId}>
                      <td>
                        <strong>{itemName(l)}</strong>
                        <div className="muted">
                          {l.atcCode ?? '—'}
                          {l.isEssential ? ` · ${t('Essential medicine')}` : ''}
                        </div>
                      </td>
                      <td>
                        {formatNumber(l.onHand)} <span className="muted">{l.unit}</span>
                        {l.expiredQuantity > 0 && (
                          <div className="muted">
                            {t('+ {count} expired', { count: formatNumber(l.expiredQuantity) })}
                          </div>
                        )}
                      </td>
                      <td>{l.reorderLevel ? formatNumber(l.reorderLevel) : '—'}</td>
                      <td>{l.nextExpiry ? formatDate(l.nextExpiry) : '—'}</td>
                      <td>
                        <StatusBadges level={l} />
                      </td>
                      <td>
                        <Button size="sm" variant="secondary" onClick={() => onOpen(l.itemId)}>
                          {canEdit ? t('Batches & settings') : t('Batches')}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )
          }
        </QueryView>
      </Card>
    </div>
  );
}

/* --------------------------------------------------------------------- item / batches */

function AdjustDialog({ batch, onClose }: { batch: StockBatch | null; onClose: () => void }) {
  const adjust = useStockMutation<{
    batchId: string;
    quantity: number;
    type: string;
    reason: string;
  }>('/stock/adjustments');
  const [type, setType] = useState(batch?.expired ? 'EXPIRED' : 'ADJUSTMENT');
  if (!batch) return null;

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const amount = Number(f.get('quantity'));
    const direction = String(f.get('direction'));
    const signed =
      type === 'EXPIRED' || type === 'DAMAGED' || direction === 'remove' ? -amount : amount;
    adjust.mutate(
      { batchId: batch!.id, quantity: signed, type, reason: String(f.get('reason')).trim() },
      { onSuccess: onClose },
    );
  }

  const removalOnly = type === 'EXPIRED' || type === 'DAMAGED';
  return (
    <Dialog open onClose={onClose} title={t('Adjust batch {batch}', { batch: batch.batchNumber })}>
      <form onSubmit={onSubmit}>
        <p className="muted">
          {t('{count} in this batch · expires {date}', {
            count: formatNumber(batch.quantity),
            date: formatDate(batch.expiryDate),
          })}
        </p>
        <SelectField
          label={t('Type of change')}
          value={type}
          onChange={(e) => setType(e.target.value)}
          options={[
            { value: 'ADJUSTMENT', label: movementLabel('ADJUSTMENT') },
            { value: 'EXPIRED', label: movementLabel('EXPIRED') },
            { value: 'DAMAGED', label: movementLabel('DAMAGED') },
            { value: 'RETURN', label: movementLabel('RETURN') },
          ]}
        />
        {!removalOnly && (
          <SelectField
            label={t('Direction')}
            name="direction"
            defaultValue={type === 'RETURN' ? 'add' : 'remove'}
            options={[
              { value: 'remove', label: t('Remove from stock') },
              { value: 'add', label: t('Add to stock') },
            ]}
          />
        )}
        <TextField
          label={t('Quantity')}
          name="quantity"
          type="number"
          min={1}
          max={removalOnly ? batch.quantity : undefined}
          defaultValue={type === 'EXPIRED' ? batch.quantity : undefined}
          required
        />
        <TextAreaField
          label={t('Reason')}
          name="reason"
          required
          minLength={5}
          maxLength={500}
          rows={2}
          hint={t('Kept in the stock ledger and the audit log.')}
        />
        <ErrorAlert error={adjust.error} />
        <div className="form-actions">
          <Button variant="secondary" onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button type="submit" loading={adjust.isPending}>
            {t('Save adjustment')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function ItemDialog({
  itemId,
  canEdit,
  onClose,
}: {
  itemId: string | null;
  canEdit: boolean;
  onClose: () => void;
}) {
  const q = useItemBatches(itemId);
  const [adjusting, setAdjusting] = useState<StockBatch | null>(null);
  const settings = useStockMutation<{ reorderLevel: number; pathSuffix: string }>(
    '/stock/settings/',
    'PUT',
  );
  return (
    <Dialog
      open={Boolean(itemId)}
      onClose={onClose}
      title={q.data ? itemName(q.data.item) : t('Batches')}
      wide
    >
      <QueryView query={q}>
        {(data) => (
          <div className="stack">
            {data.level && (
              <div className="row" style={{ gap: '0.75rem', flexWrap: 'wrap' }}>
                <span>
                  {t('On hand')}: <strong>{formatNumber(data.level.onHand)}</strong>{' '}
                  {data.item.unit}
                </span>
                <StatusBadges level={data.level} />
              </div>
            )}
            {data.batches.length === 0 ? (
              <EmptyState title={t('No batches at this facility yet')} />
            ) : (
              <Table caption={t('Batches')}>
                <thead>
                  <tr>
                    <th>{t('Batch')}</th>
                    <th>{t('Expiry')}</th>
                    <th>{t('Quantity')}</th>
                    <th>{t('Supplier')}</th>
                    {canEdit && (
                      <th>
                        <span className="sr-only">{t('Actions')}</span>
                      </th>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {data.batches.map((b, i) => (
                    <tr key={b.id}>
                      <td>
                        <span className="mono">{b.batchNumber}</span>
                        {i === data.batches.findIndex((x) => !x.expired && x.quantity > 0) && (
                          <div>
                            <Badge tone="info">{t('Use first')}</Badge>
                          </div>
                        )}
                      </td>
                      <td>
                        {formatDate(b.expiryDate)}
                        {b.expired && (
                          <div>
                            <Badge tone="danger">{t('Expired')}</Badge>
                          </div>
                        )}
                      </td>
                      <td>{formatNumber(b.quantity)}</td>
                      <td>
                        {b.supplier ?? '—'}
                        <div className="muted">{formatDate(b.receivedAt)}</div>
                      </td>
                      {canEdit && (
                        <td>
                          {b.quantity > 0 && (
                            <Button size="sm" variant="secondary" onClick={() => setAdjusting(b)}>
                              {b.expired ? t('Write off') : t('Adjust')}
                            </Button>
                          )}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
            {canEdit && (
              <form
                className="search-bar"
                onSubmit={(e) => {
                  e.preventDefault();
                  const v = Number(new FormData(e.currentTarget).get('reorderLevel'));
                  settings.mutate({ reorderLevel: v, pathSuffix: data.item.id });
                }}
              >
                <TextField
                  label={t('Reorder level')}
                  name="reorderLevel"
                  type="number"
                  min={0}
                  defaultValue={data.level?.reorderLevel ?? 0}
                  hint={t('Pharmacists are alerted when stock falls to this level.')}
                />
                <Button type="submit" variant="secondary" loading={settings.isPending}>
                  {t('Save')}
                </Button>
                {settings.isSuccess && <Badge tone="success">{t('Saved')}</Badge>}
              </form>
            )}
            <ErrorAlert error={settings.error} />
            <AdjustDialog
              key={adjusting?.id ?? 'none'}
              batch={adjusting}
              onClose={() => setAdjusting(null)}
            />
          </div>
        )}
      </QueryView>
    </Dialog>
  );
}

/* --------------------------------------------------------------------------- receive */

interface ReceiptLine {
  key: number;
  item: CatalogItem | null;
  batchNumber: string;
  expiryDate: string;
  quantity: string;
}

const emptyLine = (key: number): ReceiptLine => ({
  key,
  item: null,
  batchNumber: '',
  expiryDate: '',
  quantity: '',
});

function ReceiveTab({ onDone }: { onDone: () => void }) {
  const [supplier, setSupplier] = useState('');
  const [lines, setLines] = useState<ReceiptLine[]>([emptyLine(1)]);
  const receive = useStockMutation<{ supplier: string | null; items: object[] }>('/stock/receipts');
  const today = new Date().toISOString().slice(0, 10);
  const update = (key: number, patch: Partial<ReceiptLine>) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const complete = lines.filter(
    (l) => l.item && l.batchNumber && l.expiryDate && Number(l.quantity) > 0,
  );

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    receive.mutate(
      {
        supplier: supplier.trim() || null,
        items: complete.map((l) => ({
          itemId: l.item!.id,
          batchNumber: l.batchNumber.trim(),
          expiryDate: l.expiryDate,
          quantity: Number(l.quantity),
        })),
      },
      {
        onSuccess: () => {
          setLines([emptyLine(Date.now())]);
          onDone();
        },
      },
    );
  }

  return (
    <Card title={t('Receive a delivery')}>
      <form onSubmit={onSubmit} className="stack">
        <p className="muted">
          {t(
            'Enter each batch from the delivery note. Receiving a batch number that is already in stock adds to it.',
          )}
        </p>
        <TextField
          label={t('Supplier')}
          value={supplier}
          onChange={(e) => setSupplier(e.target.value)}
          maxLength={200}
          placeholder={t('e.g. the wholesaler named on the delivery note')}
        />
        {lines.map((l, i) => (
          <fieldset
            key={l.key}
            style={{
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius)',
              padding: '0.75rem',
            }}
          >
            <legend>{t('Line {n}', { n: i + 1 })}</legend>
            <CatalogPicker
              label={t('Medicine')}
              value={l.item}
              onChange={(item) => update(l.key, { item })}
            />
            <div className="form-grid">
              <TextField
                label={t('Batch number')}
                value={l.batchNumber}
                onChange={(e) => update(l.key, { batchNumber: e.target.value })}
                maxLength={60}
                required={Boolean(l.item)}
              />
              <TextField
                label={t('Expiry date')}
                type="date"
                min={today}
                value={l.expiryDate}
                onChange={(e) => update(l.key, { expiryDate: e.target.value })}
                required={Boolean(l.item)}
              />
              <TextField
                label={l.item ? t('Quantity ({unit})', { unit: l.item.unit }) : t('Quantity')}
                type="number"
                min={1}
                value={l.quantity}
                onChange={(e) => update(l.key, { quantity: e.target.value })}
                required={Boolean(l.item)}
              />
            </div>
            {lines.length > 1 && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}
              >
                {t('Remove line')}
              </Button>
            )}
          </fieldset>
        ))}
        <div>
          <Button
            variant="secondary"
            onClick={() => setLines((ls) => [...ls, emptyLine(Date.now())])}
          >
            {t('Add another line')}
          </Button>
        </div>
        <ErrorAlert error={receive.error} />
        {receive.isSuccess && <Alert tone="success" title={t('Delivery received')} />}
        <div className="form-actions">
          <Button type="submit" loading={receive.isPending} disabled={!complete.length}>
            {tn(complete.length, 'Receive {count} line', 'Receive {count} lines')}
          </Button>
        </div>
      </form>
    </Card>
  );
}

/* ------------------------------------------------------------------------- movements */

const MOVEMENT_TYPES: MovementType[] = [
  'RECEIPT',
  'DISPENSE',
  'ADJUSTMENT',
  'EXPIRED',
  'DAMAGED',
  'RETURN',
];

function MovementsTab() {
  const [type, setType] = useState('');
  const [page, setPage] = useState(1);
  const q = useMovements({ type, page });
  return (
    <Card title={t('Stock ledger')}>
      <p className="muted">
        {t('Every change to stock, newest first. Entries can never be edited or deleted.')}
      </p>
      <SelectField
        label={t('Type')}
        value={type}
        onChange={(e) => {
          setType(e.target.value);
          setPage(1);
        }}
        placeholder={t('All types')}
        options={MOVEMENT_TYPES.map((m) => ({ value: m, label: movementLabel(m) }))}
      />
      <QueryView query={q}>
        {(data) =>
          data.items.length === 0 ? (
            <EmptyState title={t('No stock movements yet')} />
          ) : (
            <>
              <Table caption={t('Stock ledger')}>
                <thead>
                  <tr>
                    <th>{t('When')}</th>
                    <th>{t('Medicine')}</th>
                    <th>{t('Change')}</th>
                    <th>{t('Type')}</th>
                    <th>{t('By')}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((m) => (
                    <tr key={m.id}>
                      <td>{formatDateTime(m.createdAt)}</td>
                      <td>
                        {itemName({ name: m.itemName, strength: m.itemStrength, form: m.itemForm })}
                        {m.batchNumber && <div className="muted mono">{m.batchNumber}</div>}
                      </td>
                      <td>
                        <strong
                          style={{ color: m.quantity < 0 ? 'var(--danger)' : 'var(--success)' }}
                        >
                          {m.quantity > 0 ? '+' : '−'}
                          {formatNumber(Math.abs(m.quantity))}
                        </strong>{' '}
                        <span className="muted">{m.unit}</span>
                      </td>
                      <td>
                        {movementLabel(m.type)}
                        {m.reason && <div className="muted">{m.reason}</div>}
                      </td>
                      <td>{m.byName}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
              <Pagination page={data.page} totalPages={data.totalPages} onChange={setPage} />
            </>
          )
        }
      </QueryView>
    </Card>
  );
}

/* ------------------------------------------------------------------------------ page */

export function StockPage() {
  const [params, setParams] = useSearchParams();
  const [tab, setTab] = useState<Tab>('levels');
  const levels = useStockLevels({ status: 'ALL' });
  const canEdit = levels.data?.canEdit ?? false;
  const openItem = params.get('item');
  const setOpenItem = (id: string | null) => {
    const next = new URLSearchParams(params);
    if (id) next.set('item', id);
    else next.delete('item');
    setParams(next, { replace: true });
  };
  const tabs: { id: Tab; label: string }[] = [
    { id: 'levels', label: t('Stock levels') },
    ...(canEdit ? [{ id: 'receive' as const, label: t('Receive delivery') }] : []),
    { id: 'movements', label: t('Stock ledger') },
  ];
  return (
    <>
      <PageHeader
        title={t('Pharmacy stock')}
        subtitle={
          canEdit
            ? t(
                'Stock at your facility’s pharmacy: deliveries, batches, expiry dates and every movement.',
              )
            : t('Read-only view of the pharmacy stock at your facility.')
        }
      />
      <Tabs<Tab> label={t('Stock sections')} tabs={tabs} active={tab} onChange={setTab} />
      <TabPanel id={tab}>
        {tab === 'levels' && <LevelsTab canEdit={canEdit} onOpen={setOpenItem} />}
        {tab === 'receive' && canEdit && <ReceiveTab onDone={() => setTab('levels')} />}
        {tab === 'movements' && <MovementsTab />}
      </TabPanel>
      <ItemDialog itemId={openItem} canEdit={canEdit} onClose={() => setOpenItem(null)} />
    </>
  );
}
