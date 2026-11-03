import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState, type FormEvent } from 'react';
import { api } from '../../api/client';
import { itemName, STOCK_KEY, type CatalogItem, type DispenseStockInfo } from '../../api/stock';
import type { PharmacyItem } from '../../api/types';
import {
  Alert,
  Badge,
  Button,
  ErrorAlert,
  QueryView,
  Table,
  TextAreaField,
  TextField,
} from '../../components/ui';
import { formatDate, formatNumber } from '../../format';
import { t } from '../../i18n';
import { CatalogPicker } from './CatalogPicker';

/** First-expiry-first-out over usable batches (mirrors the server). */
function fefo(batches: DispenseStockInfo['batches'], units: number) {
  const lines: { batchId: string; batchNumber: string; expiryDate: string; units: number }[] = [];
  let remaining = units;
  for (const b of batches.filter((x) => !x.expired && x.quantity > 0)) {
    if (remaining <= 0) break;
    const take = Math.min(b.quantity, remaining);
    lines.push({
      batchId: b.id,
      batchNumber: b.batchNumber,
      expiryDate: b.expiryDate,
      units: take,
    });
    remaining -= take;
  }
  return { lines, shortBy: Math.max(0, remaining) };
}

/**
 * Dispense a verified prescription from stock: the catalogue item (from the prescription, or
 * chosen here), the units handed out and the batches they come from (first expiry first).
 * Medicines outside the catalogue can be dispensed without stock tracking, with a reason.
 */
export function DispenseForm({
  item,
  onClose,
}: {
  item: PharmacyItem & { catalogItemId?: string | null };
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [chosen, setChosen] = useState<CatalogItem | null>(null);
  const [untracked, setUntracked] = useState(false);
  const info = useQuery({
    queryKey: ['pharmacy', 'rx', item.id, 'stock', chosen?.id ?? null],
    queryFn: () =>
      api<DispenseStockInfo>(`/pharmacy/prescriptions/${item.id}/stock`, {
        query: { itemId: chosen?.id },
      }),
  });
  const [unitsText, setUnitsText] = useState<string | null>(null);
  const dispense = useMutation({
    mutationFn: (body: object) =>
      api(`/pharmacy/prescriptions/${item.id}/dispense`, { method: 'POST', body }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['pharmacy'] });
      void qc.invalidateQueries({ queryKey: STOCK_KEY });
      onClose();
    },
  });

  const data = info.data;
  const units = unitsText !== null ? Number(unitsText) : (data?.suggestedUnits ?? 0);
  const allocation = useMemo(
    () => (data?.item ? fefo(data.batches, units > 0 ? units : 0) : null),
    [data, units],
  );
  const expiredUnits =
    data?.batches.filter((b) => b.expired).reduce((a, b) => a + b.quantity, 0) ?? 0;

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const note = String(f.get('note') ?? '').trim() || null;
    if (data?.item && !untracked) {
      dispense.mutate({
        stock: {
          itemId: data.item.id,
          units,
          lines: allocation?.lines.map((l) => ({ batchId: l.batchId, units: l.units })),
        },
        note,
      });
    } else {
      dispense.mutate({
        quantity: String(f.get('quantity') ?? '').trim(),
        untrackedReason: String(f.get('untrackedReason') ?? '').trim(),
        note,
      });
    }
  }

  return (
    <form onSubmit={onSubmit}>
      <p>
        <strong>{item.medication}</strong> {item.dosage}, {item.frequency} — {item.patientName}
      </p>
      <QueryView query={info}>
        {(d) => (
          <div className="stack">
            {d.item ? (
              <CatalogPicker
                label={t('Medicine from stock')}
                value={d.item}
                onChange={(next) => {
                  setChosen(next);
                  setUnitsText(null);
                }}
                allowClear={!item.catalogItemId || Boolean(chosen)}
              />
            ) : (
              !untracked && (
                <>
                  {d.candidates.length > 0 && (
                    <div className="field">
                      <span style={{ fontWeight: 600 }}>{t('Matching catalogue items')}</span>
                      <div className="row" style={{ gap: '0.4rem', flexWrap: 'wrap' }}>
                        {d.candidates.map((c) => (
                          <Button
                            key={c.id}
                            size="sm"
                            variant="secondary"
                            onClick={() => setChosen({ ...c, isEssential: false, isActive: true })}
                          >
                            {itemName(c)}
                          </Button>
                        ))}
                      </div>
                    </div>
                  )}
                  <CatalogPicker
                    label={t('Choose the medicine from the catalogue')}
                    value={null}
                    onChange={setChosen}
                    hint={t('The prescription is linked to the item, so its stock is tracked.')}
                  />
                </>
              )
            )}

            {d.item && !untracked && (
              <>
                <TextField
                  label={t('Units to dispense ({unit})', { unit: d.item.unit })}
                  type="number"
                  min={1}
                  required
                  value={unitsText ?? (d.suggestedUnits ? String(d.suggestedUnits) : '')}
                  onChange={(e) => setUnitsText(e.target.value)}
                  hint={
                    d.suggestedUnits
                      ? t('Suggested from the frequency and treatment period: {count}', {
                          count: d.suggestedUnits,
                        })
                      : undefined
                  }
                />
                <p className="muted" style={{ margin: 0 }}>
                  {t('In stock: {count} {unit}', {
                    count: formatNumber(d.level?.onHand ?? 0),
                    unit: d.item.unit,
                  })}
                  {expiredUnits > 0 &&
                    ` · ${t('{count} expired – not usable', { count: formatNumber(expiredUnits) })}`}
                </p>
                {allocation && units > 0 && allocation.lines.length > 0 && (
                  <Table caption={t('Batches to use')}>
                    <thead>
                      <tr>
                        <th>{t('Batch')}</th>
                        <th>{t('Expiry')}</th>
                        <th>{t('Units')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {allocation.lines.map((l, i) => (
                        <tr key={l.batchId}>
                          <td>
                            <span className="mono">{l.batchNumber}</span>{' '}
                            {i === 0 && <Badge tone="info">{t('Expires first')}</Badge>}
                          </td>
                          <td>{formatDate(l.expiryDate)}</td>
                          <td>{formatNumber(l.units)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                )}
                {allocation && allocation.shortBy > 0 && (
                  <Alert tone="danger" title={t('Not enough stock')}>
                    {t('{count} unit(s) are missing. Receive a delivery or dispense less.', {
                      count: allocation.shortBy,
                    })}
                  </Alert>
                )}
              </>
            )}

            {!d.item && (
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={untracked}
                  onChange={(e) => setUntracked(e.target.checked)}
                />
                <span>
                  {t('This medicine is not in the catalogue – dispense without stock tracking')}
                </span>
              </label>
            )}
            {!d.item && untracked && (
              <>
                <TextField
                  label={t('Quantity dispensed')}
                  name="quantity"
                  required
                  maxLength={100}
                  placeholder={t('e.g. 28 tablets')}
                />
                <TextAreaField
                  label={t('Why is stock not tracked?')}
                  name="untrackedReason"
                  required
                  minLength={5}
                  maxLength={500}
                  rows={2}
                  hint={t('Recorded in the audit log.')}
                />
              </>
            )}
          </div>
        )}
      </QueryView>
      <TextAreaField label={t('Note (optional)')} name="note" maxLength={2000} rows={2} />
      <ErrorAlert error={dispense.error} />
      <div className="form-actions">
        <Button variant="secondary" onClick={onClose}>
          {t('Cancel')}
        </Button>
        <Button
          type="submit"
          loading={dispense.isPending}
          disabled={
            !data ||
            (data.item && !untracked
              ? !(units > 0) || Boolean(allocation && allocation.shortBy > 0)
              : !untracked)
          }
        >
          {t('Dispense')}
        </Button>
      </div>
    </form>
  );
}
