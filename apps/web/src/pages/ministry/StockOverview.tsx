import { useState } from 'react';
import { downloadFile } from '../../api/client';
import { itemName, useNationalStock } from '../../api/stock';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorAlert,
  Grid,
  PageHeader,
  QueryView,
  Stat,
  Table,
  TextField,
} from '../../components/ui';
import { formatNumber } from '../../format';
import { t } from '../../i18n';

/**
 * National medicine availability for the Ministry: for each medicine, how many facilities have it
 * in stock, are running low or have run out. Operational data only – no patients.
 */
export function StockOverview() {
  const [essential, setEssential] = useState(true);
  const [q, setQ] = useState('');
  const [onlyProblems, setOnlyProblems] = useState(false);
  const data = useNationalStock(essential);
  const [exportError, setExportError] = useState<unknown>(null);

  return (
    <>
      <PageHeader
        title={t('Medicine availability')}
        subtitle={t(
          'Stock of medicines across all facility pharmacies, updated as they dispense and receive.',
        )}
        actions={
          <Button
            variant="secondary"
            onClick={() =>
              downloadFile('/stock/national', 'medicine-availability.csv', {
                essential: String(essential),
                format: 'csv',
              }).catch(setExportError)
            }
          >
            {t('Export CSV')}
          </Button>
        }
      />
      <ErrorAlert error={exportError} />
      <QueryView query={data}>
        {(d) => {
          const needle = q.trim().toLowerCase();
          const items = d.items.filter(
            (i) =>
              (!needle ||
                i.name.toLowerCase().includes(needle) ||
                (i.atcCode ?? '').toLowerCase().startsWith(needle)) &&
              (!onlyProblems || i.out > 0 || i.low > 0),
          );
          return (
            <div className="stack">
              <Grid min={180}>
                <Stat label={t('Medicines monitored')} value={formatNumber(d.summary.items)} />
                <Stat
                  label={t('Out of stock somewhere')}
                  value={formatNumber(d.summary.withShortage)}
                  tone={d.summary.withShortage ? 'danger' : 'success'}
                />
                <Stat
                  label={t('Running low somewhere')}
                  value={formatNumber(d.summary.withLowStock)}
                  tone={d.summary.withLowStock ? 'warning' : 'success'}
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
                  <label className="checkbox">
                    <input
                      type="checkbox"
                      checked={essential}
                      onChange={(e) => setEssential(e.target.checked)}
                    />
                    <span>{t('Essential medicines only')}</span>
                  </label>
                  <label className="checkbox">
                    <input
                      type="checkbox"
                      checked={onlyProblems}
                      onChange={(e) => setOnlyProblems(e.target.checked)}
                    />
                    <span>{t('Only shortages')}</span>
                  </label>
                </div>
                {items.length === 0 ? (
                  <EmptyState title={t('No medicines match')} />
                ) : (
                  <Table caption={t('Medicine availability')}>
                    <thead>
                      <tr>
                        <th>{t('Medicine')}</th>
                        <th>{t('Units nationally')}</th>
                        <th>{t('Facilities in stock')}</th>
                        <th>{t('Low')}</th>
                        <th>{t('Out of stock')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {items.map((i) => (
                        <tr key={i.itemId}>
                          <td>
                            <strong>{itemName(i)}</strong>
                            <div className="muted">
                              {i.atcCode ?? '—'}
                              {i.isEssential ? ` · ${t('Essential medicine')}` : ''}
                            </div>
                          </td>
                          <td>
                            {formatNumber(i.totalUnits)} <span className="muted">{i.unit}</span>
                          </td>
                          <td>{formatNumber(i.ok)}</td>
                          <td>
                            {i.low > 0 ? (
                              <>
                                <Badge tone="warning">{formatNumber(i.low)}</Badge>
                                <div className="muted">{i.lowFacilities.join(', ')}</div>
                              </>
                            ) : (
                              '—'
                            )}
                          </td>
                          <td>
                            {i.out > 0 ? (
                              <>
                                <Badge tone="danger">{formatNumber(i.out)}</Badge>
                                <div className="muted">{i.outFacilities.join(', ')}</div>
                              </>
                            ) : (
                              '—'
                            )}
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
