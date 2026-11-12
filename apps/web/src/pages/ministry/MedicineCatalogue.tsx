import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api } from '../../api/client';
import { STOCK_KEY, type CatalogItem } from '../../api/stock';
import {
  Badge,
  Button,
  Card,
  Dialog,
  EmptyState,
  ErrorAlert,
  PageHeader,
  QueryView,
  Table,
  TextField,
} from '../../components/ui';
import { t, tn } from '../../i18n';

/** A catalogue entry with the fields only the Ministry edits. */
type Medicine = CatalogItem & { barcode: string | null; ingredients: string[] | null };

/**
 * The national medicine catalogue: what can be prescribed, stocked and scanned at the bedside.
 * A pack barcode (GTIN) is what lets a nurse confirm the right medicine by scanning, and the
 * active ingredients drive the allergy and interaction checks – so both are kept here.
 */
export function MedicineCatalogue() {
  const [typed, setTyped] = useState('');
  const [q, setQ] = useState('');
  const [withdrawn, setWithdrawn] = useState(false);
  const [editing, setEditing] = useState<Medicine | 'new' | null>(null);
  const list = useQuery({
    queryKey: [...STOCK_KEY, 'catalogue-admin', q, withdrawn],
    queryFn: () =>
      api<{ items: Medicine[] }>('/stock/catalog', {
        query: { q: q || undefined, includeInactive: withdrawn ? 'true' : undefined },
      }).then((r) => r.items),
  });

  return (
    <>
      <PageHeader
        title={t('Medicine catalogue')}
        subtitle={t(
          'The national list of medicines that can be prescribed, stocked and scanned at the bedside.',
        )}
        actions={<Button onClick={() => setEditing('new')}>{t('Add medicine')}</Button>}
      />
      <Card>
        <form
          className="search-bar"
          onSubmit={(e) => {
            e.preventDefault();
            setQ(typed.trim());
          }}
        >
          <TextField
            label={t('Search')}
            hint={t('Name or ATC code')}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
          />
          <Button type="submit" variant="secondary">
            {t('Search')}
          </Button>
        </form>
        <label className="checkbox" style={{ margin: '0.75rem 0' }}>
          <input
            type="checkbox"
            checked={withdrawn}
            onChange={(e) => setWithdrawn(e.target.checked)}
          />{' '}
          {t('Also show medicines no longer in use')}
        </label>
        <QueryView query={list}>
          {(items) =>
            items.length === 0 ? (
              <EmptyState title={t('No medicines found')} />
            ) : (
              <>
                <p className="muted">
                  {tn(items.length, '{count} medicine', '{count} medicines')}
                  {!q && items.length >= 500 ? ` · ${t('Search to see more.')}` : ''}
                </p>
                <Table caption={t('Medicine catalogue')}>
                  <thead>
                    <tr>
                      <th>{t('Medicine')}</th>
                      <th>{t('ATC code')}</th>
                      <th>{t('Active ingredients')}</th>
                      <th>{t('Pack barcode')}</th>
                      <th>{t('Status')}</th>
                      <th>
                        <span className="sr-only">{t('Actions')}</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((m) => (
                      <tr key={m.id}>
                        <td>
                          <strong>{m.name}</strong> {m.strength ?? ''}
                          <div className="muted">
                            {m.form} · {m.unit}
                          </div>
                        </td>
                        <td className="mono">{m.atcCode ?? '—'}</td>
                        <td>{m.ingredients?.length ? m.ingredients.join(', ') : '—'}</td>
                        <td className="mono">
                          {m.barcode ?? <Badge tone="warning">{t('No barcode')}</Badge>}
                        </td>
                        <td>
                          <div className="row" style={{ gap: '0.35rem', flexWrap: 'wrap' }}>
                            {m.isActive ? (
                              <Badge tone="success">{t('In use')}</Badge>
                            ) : (
                              <Badge tone="neutral">{t('No longer in use')}</Badge>
                            )}
                            {m.isEssential && <Badge tone="info">{t('Essential')}</Badge>}
                          </div>
                        </td>
                        <td>
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => setEditing(m)}
                            aria-label={t('Edit {name}', { name: m.name })}
                          >
                            {t('Edit')}
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </>
            )
          }
        </QueryView>
      </Card>
      <Dialog
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing === 'new' ? t('Add medicine') : t('Edit medicine')}
        wide
      >
        {editing && (
          <MedicineForm
            key={editing === 'new' ? 'new' : editing.id}
            medicine={editing === 'new' ? null : editing}
            onDone={() => setEditing(null)}
          />
        )}
      </Dialog>
    </>
  );
}

function MedicineForm({ medicine, onDone }: { medicine: Medicine | null; onDone: () => void }) {
  const qc = useQueryClient();
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      medicine
        ? api(`/stock/catalog/${medicine.id}`, { method: 'PATCH', body })
        : api('/stock/catalog', { method: 'POST', body }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: STOCK_KEY });
      onDone();
    },
  });

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const text = (name: string) => String(f.get(name) ?? '').trim();
    const ingredients = text('ingredients')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);
    save.mutate({
      name: text('name'),
      strength: text('strength') || null,
      form: text('form'),
      unit: text('unit'),
      atcCode: text('atcCode').toUpperCase() || null,
      barcode: text('barcode') || null,
      ingredients: ingredients.length ? ingredients : null,
      isEssential: f.get('isEssential') === 'on',
      ...(medicine ? { isActive: f.get('isActive') === 'on' } : {}),
    });
  }

  return (
    <form onSubmit={onSubmit}>
      <div className="form-grid">
        <TextField
          label={t('Name')}
          name="name"
          required
          minLength={2}
          maxLength={200}
          defaultValue={medicine?.name ?? ''}
          hint={t('The generic (INN) name, e.g. Amoxicillin')}
        />
        <TextField
          label={t('Strength')}
          name="strength"
          maxLength={60}
          defaultValue={medicine?.strength ?? ''}
          hint={t('e.g. 500 mg')}
        />
        <TextField
          label={t('Form')}
          name="form"
          required
          minLength={2}
          maxLength={60}
          defaultValue={medicine?.form ?? ''}
          hint={t('e.g. tablet, capsule, solution for injection')}
        />
        <TextField
          label={t('Unit')}
          name="unit"
          required
          maxLength={30}
          defaultValue={medicine?.unit ?? ''}
          hint={t('What stock is counted in, e.g. tablet, ampoule, bottle')}
        />
        <TextField
          label={t('ATC code')}
          name="atcCode"
          maxLength={10}
          pattern="[A-Za-z][0-9]{2}[A-Za-z]{0,2}[0-9]{0,2}"
          defaultValue={medicine?.atcCode ?? ''}
          hint={t('e.g. J01CA04')}
        />
        <TextField
          label={t('Pack barcode')}
          name="barcode"
          inputMode="numeric"
          maxLength={64}
          defaultValue={medicine?.barcode ?? ''}
          hint={t(
            'The GTIN/EAN number printed under the barcode. Without it the pack cannot be confirmed by scanning.',
          )}
        />
      </div>
      <TextField
        label={t('Active ingredients')}
        name="ingredients"
        maxLength={500}
        defaultValue={medicine?.ingredients?.join(', ') ?? ''}
        hint={t(
          'Generic names separated by commas, e.g. amoxicillin, clavulanic acid. Used by the allergy and interaction checks.',
        )}
      />
      <label className="checkbox">
        <input type="checkbox" name="isEssential" defaultChecked={medicine?.isEssential ?? false} />{' '}
        {t('On the essential medicines list')}
      </label>
      {medicine && (
        <label className="checkbox">
          <input type="checkbox" name="isActive" defaultChecked={medicine.isActive} />{' '}
          {t('In use (untick to stop new prescriptions and stock entries)')}
        </label>
      )}
      <ErrorAlert error={save.error} />
      <div className="form-actions">
        <Button variant="secondary" onClick={onDone}>
          {t('Cancel')}
        </Button>
        <Button type="submit" loading={save.isPending}>
          {medicine ? t('Save') : t('Add medicine')}
        </Button>
      </div>
    </form>
  );
}
