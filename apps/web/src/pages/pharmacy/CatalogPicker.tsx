import { useId, useState } from 'react';
import { itemName, useCatalogSearch, type CatalogItem } from '../../api/stock';
import { Badge, Button } from '../../components/ui';
import { t } from '../../i18n';

/**
 * Search the national medication catalogue by name or ATC code and pick one item. Shows the
 * chosen item with a "Change" button; `allowClear` lets the user go back to free text.
 */
export function CatalogPicker({
  label,
  value,
  onChange,
  initialQuery = '',
  hint,
  allowClear = true,
}: {
  label: string;
  value: CatalogItem | null;
  onChange: (item: CatalogItem | null) => void;
  initialQuery?: string;
  hint?: string;
  allowClear?: boolean;
}) {
  const id = useId();
  const [q, setQ] = useState(initialQuery);
  const results = useCatalogSearch(q, !value);

  if (value) {
    return (
      <div className="field">
        <span style={{ fontWeight: 600 }}>{label}</span>
        <div className="row" style={{ gap: '0.5rem', flexWrap: 'wrap' }}>
          <strong>{itemName(value)}</strong>
          {value.atcCode && <span className="mono muted">{value.atcCode}</span>}
          {value.isEssential && <Badge tone="info">{t('Essential medicine')}</Badge>}
          {allowClear && (
            <Button size="sm" variant="secondary" onClick={() => onChange(null)}>
              {t('Change')}
            </Button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={t('Name or ATC code, e.g. amoxicillin or J01CA04')}
        autoComplete="off"
        aria-describedby={hint ? `${id}-hint` : undefined}
      />
      {hint && (
        <small id={`${id}-hint`} className="muted">
          {hint}
        </small>
      )}
      {q.trim().length >= 2 && (
        <ul className="list" aria-label={t('Catalogue matches')} style={{ marginTop: '0.4rem' }}>
          {results.isPending && <li className="muted">{t('Searching…')}</li>}
          {results.data?.length === 0 && (
            <li className="muted">{t('No medicine in the catalogue matches “{q}”', { q })}</li>
          )}
          {results.data?.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                style={{ width: '100%', justifyContent: 'flex-start', textAlign: 'left' }}
                onClick={() => onChange(item)}
              >
                <span>
                  {itemName(item)}{' '}
                  <span className="muted">
                    {item.atcCode ?? ''} · {item.unit}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
