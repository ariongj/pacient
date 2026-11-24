import { useSearchParams } from 'react-router-dom';
import {
  formatMoney,
  useInvoices,
  useOrganizations,
  type InvoiceFilter,
} from '../../api/subscriptions';
import { Grid, PageHeader, Pagination, QueryView, SelectField, Stat } from '../../components/ui';
import { t, tn } from '../../i18n';
import { ExportMenu } from './billing/ExportMenu';
import { InvoiceTable } from './billing/InvoiceTable';

const FILTERS: InvoiceFilter[] = ['all', 'open', 'overdue', 'paid', 'void'];
const filterLabel = (f: InvoiceFilter) =>
  ({
    all: t('All'),
    open: t('Open|invoice'),
    overdue: t('Overdue|invoice'),
    paid: t('Paid|invoice'),
    void: t('Voided|invoice'),
  })[f];

/** All invoices; record payments. */
export function Invoices() {
  const [params, setParams] = useSearchParams();
  const status = (FILTERS.find((f) => f === params.get('status')) ?? 'all') as InvoiceFilter;
  const facilityId = params.get('facilityId') ?? '';
  const page = Math.max(1, Number(params.get('page')) || 1);
  const query = useInvoices({ status, facilityId, page });
  const facilities = useOrganizations({ q: '', status: '' });
  const set = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    if (key !== 'page') next.delete('page');
    setParams(next, { replace: true });
  };

  return (
    <>
      <PageHeader
        title={t('Invoices and payments')}
        subtitle={t('All invoices; record payments.')}
        actions={<ExportMenu />}
      />
      <QueryView query={query}>
        {(data) => (
          <div className="stack">
            <Grid min={200}>
              <Stat
                label={t('Open|invoice')}
                value={formatMoney(data.totals.openCents, data.totals.currency)}
                hint={tn(data.totals.openCount, '{count} invoice', '{count} invoices')}
              />
              <Stat
                label={t('Overdue|invoice')}
                value={formatMoney(data.totals.overdueCents, data.totals.currency)}
                hint={tn(data.totals.overdueCount, '{count} invoice', '{count} invoices')}
                tone={data.totals.overdueCount ? 'danger' : undefined}
              />
              <Stat
                label={t('Paid this year')}
                value={formatMoney(data.totals.paidThisYearCents, data.totals.currency)}
                tone="success"
              />
            </Grid>
            <div className="search-bar">
              <SelectField
                label={t('Status')}
                value={status}
                onChange={(e) => set('status', e.target.value === 'all' ? '' : e.target.value)}
                options={FILTERS.map((f) => ({ value: f, label: filterLabel(f) }))}
              />
              <SelectField
                label={t('Facility')}
                value={facilityId}
                onChange={(e) => set('facilityId', e.target.value)}
                options={[
                  { value: '', label: t('All facilities') },
                  ...(facilities.data?.items ?? []).map((o) => ({
                    value: o.facility.id,
                    label: o.facility.name,
                  })),
                ]}
              />
            </div>
            <InvoiceTable invoices={data.items} audience="admin" showFacility />
            <Pagination
              page={data.page}
              totalPages={data.totalPages}
              onChange={(p) => set('page', String(p))}
            />
          </div>
        )}
      </QueryView>
    </>
  );
}
