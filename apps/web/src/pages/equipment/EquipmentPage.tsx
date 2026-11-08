import { useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  categoryLabel,
  equipmentStatusLabel,
  useAvailability,
  useEquipmentList,
  useEquipmentMeta,
  useImportEquipment,
  useMaintenance,
  useNationalEquipment,
  type EquipmentItem,
  type EquipmentMeta,
  type ListFilters,
} from '../../api/equipment';
import { BarChart } from '../../components/charts';
import {
  Alert,
  Button,
  Card,
  EmptyState,
  ErrorAlert,
  Grid,
  PageHeader,
  Pagination,
  QueryView,
  SelectField,
  Stat,
  Table,
  TabPanel,
  Tabs,
  TextAreaField,
  TextField,
} from '../../components/ui';
import { formatDate, formatMonth, formatNumber } from '../../format';
import { t } from '../../i18n';
import { ItemDialog, ItemFormDialog, MaintenanceBadge, StatusBadge } from './EquipmentDialogs';

type TabId = 'register' | 'maintenance' | 'overview' | 'import';

/** The last n months as YYYY-MM, oldest first. */
function lastMonths(n: number): string[] {
  const now = new Date();
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.UTC(now.getFullYear(), now.getMonth() - (n - 1 - i), 1));
    return d.toISOString().slice(0, 7);
  });
}

export function EquipmentPage() {
  const meta = useEquipmentMeta();
  return (
    <QueryView query={meta}>
      {(m) =>
        m.isMinistry ? (
          <>
            <PageHeader
              title={t('Critical equipment')}
              subtitle={t(
                'Ventilators, defibrillators and dialysis machines in service, maintenance and faults across all facilities.',
              )}
            />
            <NationalView />
          </>
        ) : (
          <FacilityView meta={m} />
        )
      }
    </QueryView>
  );
}

function FacilityView({ meta }: { meta: EquipmentMeta }) {
  const [params, setParams] = useSearchParams();
  const [tab, setTab] = useState<TabId>('register');
  const [editing, setEditing] = useState<EquipmentItem | null>(null);
  const [adding, setAdding] = useState(false);
  const openId = params.get('item');
  const open = (id: string | null) => {
    const next = new URLSearchParams(params);
    if (id) next.set('item', id);
    else {
      next.delete('item');
      // Drop notification dedupe keys from the address bar too.
      for (const k of [...next.keys()]) if (k.startsWith('eq')) next.delete(k);
    }
    setParams(next, { replace: true });
  };
  const tabs: { id: TabId; label: string }[] = [
    { id: 'register', label: t('Equipment|equipment') },
    { id: 'maintenance', label: t('Maintenance|equipment') },
    { id: 'overview', label: t('Availability|equipment') },
    ...(meta.canManage ? [{ id: 'import' as const, label: t('Import from CSV') }] : []),
  ];
  return (
    <>
      <PageHeader
        title={t('Medical equipment')}
        subtitle={
          meta.canManage
            ? t('The equipment register of your facility: services, faults and repairs.')
            : t('Equipment of your facility. Report a fault as soon as you notice one.')
        }
        actions={
          meta.canManage && <Button onClick={() => setAdding(true)}>{t('Add equipment')}</Button>
        }
      />
      <Tabs label={t('Medical equipment')} tabs={tabs} active={tab} onChange={setTab} />
      <TabPanel id={tab}>
        {tab === 'register' && <RegisterTab meta={meta} onOpen={open} />}
        {tab === 'maintenance' && <MaintenanceTab meta={meta} onOpen={open} />}
        {tab === 'overview' && <OverviewTab />}
        {tab === 'import' && meta.canManage && <ImportTab meta={meta} />}
      </TabPanel>
      <ItemDialog
        id={openId}
        meta={meta}
        onClose={() => open(null)}
        onEdit={(item) => {
          open(null);
          setEditing(item);
        }}
      />
      <ItemFormDialog
        open={adding || Boolean(editing)}
        item={editing}
        meta={meta}
        onClose={() => {
          setAdding(false);
          setEditing(null);
        }}
      />
    </>
  );
}

function ItemsTable({
  caption,
  items,
  onOpen,
}: {
  caption: string;
  items: EquipmentItem[];
  onOpen: (id: string) => void;
}) {
  return (
    <Table caption={caption}>
      <thead>
        <tr>
          <th scope="col">{t('Asset tag|equipment')}</th>
          <th scope="col">{t('Equipment|equipment')}</th>
          <th scope="col">{t('Ward or unit')}</th>
          <th scope="col">{t('Status')}</th>
          <th scope="col">{t('Next service due')}</th>
          <th scope="col">
            <span className="sr-only">{t('Actions')}</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {items.map((i) => (
          <tr key={i.id}>
            <td>
              <code>{i.assetTag}</code>
            </td>
            <td>
              {i.name}
              <div className="muted">
                {[i.manufacturer, i.model].filter(Boolean).join(' · ') || categoryLabel(i.category)}
              </div>
            </td>
            <td>{i.unitName ?? '—'}</td>
            <td>
              <StatusBadge status={i.status} />
            </td>
            <td>
              {i.nextServiceDue ? formatDate(i.nextServiceDue) : '—'} <MaintenanceBadge item={i} />
            </td>
            <td>
              <Button size="sm" variant="secondary" onClick={() => onOpen(i.id)}>
                {t('Open|action')}
              </Button>
            </td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

function RegisterTab({ meta, onOpen }: { meta: EquipmentMeta; onOpen: (id: string) => void }) {
  const [filters, setFilters] = useState<ListFilters>({ page: 1 });
  const [search, setSearch] = useState('');
  const list = useEquipmentList(filters);
  const set = (k: keyof ListFilters, v: string) =>
    setFilters((f) => ({ ...f, [k]: v || undefined, page: 1 }));
  return (
    <Card>
      <form
        className="form-grid"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          set('q', search.trim());
        }}
      >
        <TextField
          label={t('Search: asset tag, name, model or serial number')}
          name="q"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          type="search"
        />
        <SelectField
          label={t('Ward or unit')}
          name="unitId"
          value={filters.unitId ?? ''}
          onChange={(e) => set('unitId', e.target.value)}
          placeholder={t('All')}
          options={meta.units.map((u) => ({ value: u.id, label: u.name }))}
        />
        <SelectField
          label={t('Category')}
          name="category"
          value={filters.category ?? ''}
          onChange={(e) => set('category', e.target.value)}
          placeholder={t('All')}
          options={meta.categories.map((c) => ({ value: c, label: categoryLabel(c) }))}
        />
        <SelectField
          label={t('Status')}
          name="status"
          value={filters.status ?? ''}
          onChange={(e) => set('status', e.target.value)}
          placeholder={t('All in use')}
          options={meta.statuses.map((s) => ({ value: s, label: equipmentStatusLabel(s) }))}
        />
        <div className="form-actions" style={{ alignSelf: 'end' }}>
          <Button type="submit" variant="secondary">
            {t('Search')}
          </Button>
        </div>
      </form>
      <QueryView query={list}>
        {(data) =>
          data.items.length === 0 ? (
            <EmptyState title={t('No equipment found')} />
          ) : (
            <>
              <p className="muted">{t('{count} items', { count: formatNumber(data.total) })}</p>
              <ItemsTable caption={t('Equipment|equipment')} items={data.items} onOpen={onOpen} />
              <Pagination
                page={data.page}
                totalPages={data.totalPages}
                onChange={(page) => setFilters((f) => ({ ...f, page }))}
              />
            </>
          )
        }
      </QueryView>
    </Card>
  );
}

function MaintenanceTab({ meta, onOpen }: { meta: EquipmentMeta; onOpen: (id: string) => void }) {
  const [unitId, setUnitId] = useState('');
  const lists = useMaintenance(unitId || undefined);
  return (
    <>
      <Card>
        <SelectField
          label={t('Ward or unit')}
          name="unitId"
          value={unitId}
          onChange={(e) => setUnitId(e.target.value)}
          placeholder={t('All')}
          options={meta.units.map((u) => ({ value: u.id, label: u.name }))}
        />
      </Card>
      <QueryView query={lists}>
        {(l) => (
          <>
            <Card title={t('Out of service')}>
              {l.outOfService.length ? (
                <ItemsTable caption={t('Out of service')} items={l.outOfService} onOpen={onOpen} />
              ) : (
                <EmptyState title={t('All equipment is in service')} />
              )}
            </Card>
            <Card title={t('Service overdue')}>
              {l.overdue.length ? (
                <ItemsTable caption={t('Service overdue')} items={l.overdue} onOpen={onOpen} />
              ) : (
                <EmptyState title={t('No service is overdue')} />
              )}
            </Card>
            <Card title={t('Service due within {days} days', { days: l.dueSoonDays })}>
              {l.dueSoon.length ? (
                <ItemsTable
                  caption={t('Service due within {days} days', { days: l.dueSoonDays })}
                  items={l.dueSoon}
                  onOpen={onOpen}
                />
              ) : (
                <EmptyState title={t('Nothing due soon')} />
              )}
            </Card>
          </>
        )}
      </QueryView>
    </>
  );
}

function OverviewTab() {
  const data = useAvailability();
  return (
    <QueryView query={data}>
      {(a) => (
        <>
          <Grid>
            <Stat label={t('Equipment in use')} value={formatNumber(a.totals.total)} />
            <Stat
              label={t('Out of service')}
              value={formatNumber(a.totals.outOfService)}
              tone={a.totals.outOfService ? 'warning' : 'success'}
            />
            <Stat
              label={t('Service overdue')}
              value={formatNumber(a.totals.overdue)}
              tone={a.totals.overdue ? 'danger' : 'success'}
            />
            <Stat label={t('Service due soon')} value={formatNumber(a.totals.dueSoon)} />
          </Grid>
          <Card title={t('Critical equipment in service by ward')}>
            <p className="muted">
              {t('Figures show equipment in service / all equipment (retired equipment excluded).')}
            </p>
            {a.units.length === 0 ? (
              <EmptyState title={t('No critical equipment registered')} />
            ) : (
              <Table caption={t('Critical equipment in service by ward')}>
                <thead>
                  <tr>
                    <th scope="col">{t('Ward or unit')}</th>
                    {a.criticalCategories.map((c) => (
                      <th scope="col" key={c} className="num">
                        {categoryLabel(c)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {a.units.map((u) => (
                    <tr key={u.unitId ?? 'none'}>
                      <th scope="row">{u.unitName ?? t('Not assigned to a ward')}</th>
                      {a.criticalCategories.map((c) => {
                        const cell = u.categories[c];
                        if (!cell)
                          return (
                            <td key={c} className="num">
                              —
                            </td>
                          );
                        const short = cell.inService < cell.total;
                        return (
                          <td key={c} className="num">
                            {short ? (
                              <strong>
                                {`${cell.inService} / ${cell.total}`}{' '}
                                <span className="sr-only">{t('not all in service')}</span>
                              </strong>
                            ) : (
                              `${cell.inService} / ${cell.total}`
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
        </>
      )}
    </QueryView>
  );
}

function ImportTab({ meta }: { meta: EquipmentMeta }) {
  const [csv, setCsv] = useState('');
  const run = useImportEquipment();
  const result = run.data;
  return (
    <Card title={t('Import from CSV')}>
      <p className="muted">
        {t(
          'One row per item, with a header row. Existing asset tags are updated; the status is never changed by an import. Check the file first – nothing is saved while any row has an error.',
        )}
      </p>
      <p>
        <code>{meta.csvColumns.join(',')}</code>
      </p>
      <TextAreaField
        label={t('CSV file contents')}
        name="csv"
        rows={8}
        value={csv}
        onChange={(e) => setCsv(e.target.value)}
      />
      <div className="form-actions" style={{ justifyContent: 'flex-start' }}>
        <TextField
          label={t('Choose a file')}
          name="file"
          type="file"
          accept=".csv,text/csv"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            if (file) setCsv(await file.text());
          }}
        />
        <Button
          variant="secondary"
          disabled={!csv.trim()}
          loading={run.isPending && run.variables?.dryRun}
          onClick={() => run.mutate({ csv, dryRun: true })}
        >
          {t('Check the file')}
        </Button>
        <Button
          disabled={!result || result.errors.length > 0 || result.applied || !result.dryRun}
          loading={run.isPending && !run.variables?.dryRun}
          onClick={() => run.mutate({ csv, dryRun: false })}
        >
          {t('Import')}
        </Button>
      </div>
      <ErrorAlert error={run.error} />
      {result && (
        <Alert
          tone={result.errors.length ? 'danger' : result.applied ? 'success' : 'info'}
          title={
            result.applied
              ? t('Imported: {created} new, {updated} updated', {
                  created: result.toCreate,
                  updated: result.toUpdate,
                })
              : result.errors.length
                ? t('{count} rows have errors', { count: result.errors.length })
                : t('The file is valid: {created} new, {updated} updated', {
                    created: result.toCreate,
                    updated: result.toUpdate,
                  })
          }
        >
          {result.errors.length > 0 && (
            <ul>
              {result.errors.map((e) => (
                <li key={e.line}>
                  {t('Line {line}', { line: e.line })}: {e.message}
                </li>
              ))}
            </ul>
          )}
        </Alert>
      )}
    </Card>
  );
}

function NationalView() {
  const data = useNationalEquipment();
  return (
    <QueryView query={data}>
      {(n) => {
        const sum = (c: string, k: 'total' | 'inService') =>
          n.byFacility.reduce((a, f) => a + (f.categories[c as 'VENTILATOR']?.[k] ?? 0), 0);
        return (
          <>
            <Grid>
              {n.categories.map((c) => (
                <Stat
                  key={c}
                  label={categoryLabel(c)}
                  value={`${formatNumber(sum(c, 'inService'))} / ${formatNumber(sum(c, 'total'))}`}
                  hint={t('in service / all')}
                  tone={sum(c, 'inService') < sum(c, 'total') ? 'warning' : 'success'}
                />
              ))}
              <Stat
                label={t('Maintenance overdue')}
                value={n.overduePct === null ? '—' : `${formatNumber(n.overduePct)} %`}
                tone={n.overduePct && n.overduePct > 10 ? 'danger' : undefined}
              />
            </Grid>
            <p className="muted">
              {t('Figures show equipment in service / all equipment (retired equipment excluded).')}
            </p>
            <Card title={t('By facility')}>
              <Table caption={t('Critical equipment in service by facility')}>
                <thead>
                  <tr>
                    <th scope="col">{t('Facility')}</th>
                    <th scope="col">{t('Municipality')}</th>
                    {n.categories.map((c) => (
                      <th scope="col" key={c} className="num">
                        {categoryLabel(c)}
                      </th>
                    ))}
                    <th scope="col" className="num">
                      {t('Maintenance overdue')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {n.maintenance.map((m) => {
                    const f = n.byFacility.find((x) => x.facilityId === m.facilityId);
                    return (
                      <tr key={m.facilityId}>
                        <th scope="row">{m.facility}</th>
                        <td>{m.municipality}</td>
                        {n.categories.map((c) => {
                          const cell = f?.categories[c];
                          return (
                            <td key={c} className="num">
                              {cell ? `${cell.inService} / ${cell.total}` : '—'}
                            </td>
                          );
                        })}
                        <td className="num">
                          {m.overduePct === null ? '—' : `${formatNumber(m.overduePct)} %`}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </Table>
            </Card>
            <Card title={t('By municipality')}>
              <Table caption={t('Critical equipment in service by municipality')}>
                <thead>
                  <tr>
                    <th scope="col">{t('Municipality')}</th>
                    {n.categories.map((c) => (
                      <th scope="col" key={c} className="num">
                        {categoryLabel(c)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {n.byMunicipality.map((m) => (
                    <tr key={m.municipality}>
                      <th scope="row">{m.municipality}</th>
                      {n.categories.map((c) => {
                        const cell = m.categories[c];
                        return (
                          <td key={c} className="num">
                            {cell ? `${cell.inService} / ${cell.total}` : '—'}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </Table>
            </Card>
            <Card title={t('Equipment faults per month')}>
              {n.faultsByMonth.length ? (
                <BarChart
                  title={t('Equipment faults per month')}
                  data={lastMonths(12).map((m) => ({
                    label: formatMonth(m),
                    value: n.faultsByMonth.find((f) => f.month === m)?.count ?? 0,
                  }))}
                />
              ) : (
                <EmptyState title={t('No faults reported in the last 12 months')} />
              )}
            </Card>
          </>
        );
      }}
    </QueryView>
  );
}
