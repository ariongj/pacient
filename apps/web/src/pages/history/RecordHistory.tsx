import { useState } from 'react';
import { useUser } from '../../auth/AuthContext';
import {
  fieldLabel,
  tableLabel,
  useRecentChanges,
  useRecordHistory,
  type FieldKind,
  type HistoryActor,
  type HistoryTable,
  type RecordVersion,
} from '../../api/history';
import {
  Badge,
  Button,
  Card,
  DefinitionList,
  Dialog,
  EmptyState,
  Pagination,
  QueryView,
  SelectField,
  Table,
} from '../../components/ui';
import { actionLabel, formatDate, formatDateTime, humanize } from '../../format';
import { t } from '../../i18n';

/**
 * Version history of clinical records, opened from the chart: who changed what and when. Staff
 * only (the server refuses patients and guardians and audits every read).
 */

type Value = string | number | boolean | null;

/** Only treating clinicians can read the history (the server enforces the rest). */
function useCanSeeHistory() {
  const role = useUser().role;
  return role === 'DOCTOR' || role === 'NURSE';
}

export function formatValue(kind: FieldKind, v: Value): string {
  if (v === null || v === '') return '—';
  switch (kind) {
    case 'datetime':
      return formatDateTime(String(v));
    case 'date':
      return formatDate(String(v));
    case 'bool':
      return v ? t('Yes') : t('No');
    case 'enum':
      return humanize(String(v));
    case 'masked':
      return t('Issued (code not shown)');
    default:
      return String(v);
  }
}

const operationLabel = (v: Pick<RecordVersion, 'operation' | 'mergedMove'>) =>
  v.mergedMove
    ? t('Moved here from a merged duplicate record')
    : {
        BASELINE: t('State when the history began'),
        INSERT: t('Created'),
        UPDATE: t('Changed'),
        DELETE: t('Deleted'),
      }[v.operation];

const operationTone = (op: RecordVersion['operation']) =>
  op === 'DELETE' ? 'danger' : op === 'INSERT' ? 'success' : 'neutral';

function ActorLine({ by }: { by: HistoryActor | null }) {
  if (!by) {
    return (
      <span className="muted">
        {t('Person not recorded (e.g. laboratory interface or data load)')}
      </span>
    );
  }
  return (
    <span>
      {by.userId === null ? t('System|actor') : (by.name ?? t('Unknown user'))}
      {by.role ? ` (${humanize(by.role)})` : ''} · {actionLabel(by.action)}
    </span>
  );
}

function VersionBlock({ v }: { v: RecordVersion }) {
  const showState = v.operation === 'BASELINE' || v.operation === 'DELETE';
  return (
    <section className="stack" aria-label={t('Version {n}', { n: v.version })}>
      <div className="row" style={{ flexWrap: 'wrap', gap: '0.5rem', alignItems: 'baseline' }}>
        <strong>{t('Version {n}', { n: v.version })}</strong>
        <Badge tone={operationTone(v.operation)}>{operationLabel(v)}</Badge>
        <span className="muted">{formatDateTime(v.recordedAt)}</span>
      </div>
      <div>
        <ActorLine by={v.by} />
      </div>
      {v.operation === 'INSERT' && (
        <DefinitionList
          items={v.changes.map((c) => [fieldLabel(c.field, c.label), formatValue(c.kind, c.after)])}
        />
      )}
      {v.operation === 'UPDATE' && !v.mergedMove && v.changes.length === 0 && (
        <p className="muted">{t('Only links to other records changed.')}</p>
      )}
      {v.operation === 'UPDATE' && v.changes.length > 0 && (
        <Table caption={t('Changes in version {n}', { n: v.version })}>
          <thead>
            <tr>
              <th scope="col">{t('Field')}</th>
              <th scope="col">{t('Before')}</th>
              <th scope="col">{t('After')}</th>
            </tr>
          </thead>
          <tbody>
            {v.changes.map((c) => (
              <tr key={c.field}>
                <th scope="row">{fieldLabel(c.field, c.label)}</th>
                <td>{formatValue(c.kind, c.before)}</td>
                <td>{formatValue(c.kind, c.after)}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {showState && v.state.length > 0 && (
        <details>
          <summary>
            {v.operation === 'DELETE' ? t('Content before it was deleted') : t('Content')}
          </summary>
          <DefinitionList
            items={v.state.map((x) => [fieldLabel(x.field, x.label), formatValue(x.kind, x.value)])}
          />
        </details>
      )}
    </section>
  );
}

function HistoryDialogBody({
  patientId,
  table,
  resourceId,
}: {
  patientId: string;
  table: HistoryTable;
  resourceId: string;
}) {
  const q = useRecordHistory(patientId, table, resourceId);
  return (
    <QueryView query={q}>
      {(h) => (
        <div className="stack">
          <p>
            <strong>{h.title || tableLabel(h.table)}</strong>
            {h.deleted && (
              <>
                {' '}
                <Badge tone="danger">{t('Deleted')}</Badge>
              </>
            )}
          </p>
          <p className="muted">
            {t(
              'Every change is kept. The person is the one whose action was logged in the same step; reading this history is logged too.',
            )}
          </p>
          {h.versions.map((v) => (
            <VersionBlock key={v.version} v={v} />
          ))}
        </div>
      )}
    </QueryView>
  );
}

/** A small "History" button for one record; opens the version history in a dialog. */
export function RecordHistory({
  patientId,
  table,
  resourceId,
  label,
}: {
  patientId: string;
  table: HistoryTable;
  resourceId: string;
  /** What the record is, for the button's accessible name (e.g. the substance). */
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  if (!useCanSeeHistory()) return null;
  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => setOpen(true)}
        aria-label={label ? t('History of {item}', { item: label }) : t('History|record')}
      >
        {t('History|record')}
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} title={t('History of this record')} wide>
        {open && <HistoryDialogBody patientId={patientId} table={table} resourceId={resourceId} />}
      </Dialog>
    </>
  );
}

const TABLES: HistoryTable[] = [
  'allergies',
  'diagnoses',
  'prescriptions',
  'vital_signs',
  'lab_results',
  'immunizations',
  'encounters',
];

/** Recent changes in the chart, newest first, with a filter by record type. */
export function RecentChanges({
  patientId,
  titled = true,
}: {
  patientId: string;
  titled?: boolean;
}) {
  const [page, setPage] = useState(1);
  const [table, setTable] = useState<HistoryTable | ''>('');
  const [opened, setOpened] = useState<{ table: HistoryTable; resourceId: string } | null>(null);
  const q = useRecentChanges(patientId, page, table || undefined);
  return (
    <Card title={titled ? t('Recent changes in this chart') : undefined}>
      <SelectField
        label={t('Record type')}
        name="history-table"
        value={table}
        onChange={(e) => {
          setTable(e.target.value as HistoryTable | '');
          setPage(1);
        }}
        options={[
          { value: '', label: t('All record types') },
          ...TABLES.map((x) => ({ value: x, label: tableLabel(x) })),
        ]}
      />
      <QueryView query={q}>
        {(res) =>
          res.items.length === 0 ? (
            <EmptyState title={t('No changes recorded yet')} />
          ) : (
            <>
              <Table caption={t('Recent changes in this chart')}>
                <thead>
                  <tr>
                    <th scope="col">{t('When')}</th>
                    <th scope="col">{t('Record|item')}</th>
                    <th scope="col">{t('What happened')}</th>
                    <th scope="col">{t('Who')}</th>
                    <th scope="col">
                      <span className="sr-only">{t('History|record')}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {res.items.map((c) => (
                    <tr key={c.id}>
                      <td>{formatDateTime(c.recordedAt)}</td>
                      <td>
                        {tableLabel(c.table)}
                        {c.title && c.table !== 'vital_signs' ? `: ${c.title}` : ''}
                      </td>
                      <td>
                        {operationLabel(c)}
                        {c.changedFields.length > 0 &&
                          ` – ${c.changedFields.map((f) => fieldLabel(f.field, f.label)).join(', ')}`}
                        {c.operation === 'UPDATE' &&
                          !c.mergedMove &&
                          c.changedFields.length === 0 &&
                          ` – ${t('only links to other records')}`}
                      </td>
                      <td>
                        <ActorLine by={c.by} />
                      </td>
                      <td>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setOpened({ table: c.table, resourceId: c.resourceId })}
                          aria-label={t('History of {item}', {
                            item: c.title || tableLabel(c.table),
                          })}
                        >
                          {t('History|record')}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
              <Pagination page={res.page} totalPages={res.totalPages} onChange={setPage} />
            </>
          )
        }
      </QueryView>
      <Dialog
        open={opened !== null}
        onClose={() => setOpened(null)}
        title={t('History of this record')}
        wide
      >
        {opened && (
          <HistoryDialogBody
            patientId={patientId}
            table={opened.table}
            resourceId={opened.resourceId}
          />
        )}
      </Dialog>
    </Card>
  );
}

/** A collapsed section for the chart overview; loads (and is audited) only when opened. */
export function RecentChangesSection({ patientId }: { patientId: string }) {
  const [open, setOpen] = useState(false);
  if (!useCanSeeHistory()) return null;
  return (
    <details onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary>{t('Recent changes in this chart')}</summary>
      {open && <RecentChanges patientId={patientId} titled={false} />}
    </details>
  );
}
