import { useState, type FormEvent } from 'react';
import { useUser } from '../../auth/AuthContext';
import {
  equivalenceLabel,
  exportVersion,
  fieldLabel,
  statusLabel,
  statusTone,
  useConcept,
  useCreateMap,
  useCreateSystem,
  useImportVersion,
  useVersionAction,
  useVersionDiff,
  type CodeSystemSummary,
  type Concept,
  type ConceptDiff,
  type MapImportReport,
  type MapVersion,
  type SystemVersion,
} from '../../api/terminology';
import {
  Alert,
  Badge,
  Button,
  DefinitionList,
  Dialog,
  EmptyState,
  ErrorAlert,
  Grid,
  QueryView,
  SelectField,
  Stat,
  Table,
  TextAreaField,
  TextField,
} from '../../components/ui';
import { formatDateTime, formatNumber } from '../../format';
import { getLocale, t } from '../../i18n';

/** The display in the interface language (falls back to the English display). */
export function displayOf(c: Pick<Concept, 'display' | 'displaySq' | 'displaySr'>) {
  const locale = getLocale();
  if (locale === 'sq') return c.displaySq ?? c.display;
  if (locale === 'sr') return c.displaySr ?? c.display;
  return c.display;
}

export function StatusBadge({ status }: { status: SystemVersion['status'] }) {
  return <Badge tone={statusTone(status)}>{statusLabel(status)}</Badge>;
}

/* ---------------------------------------------------------------- versions table -------- */

export function VersionsTable({
  kind,
  code,
  versions,
  canManage,
  onCompare,
}: {
  kind: 'system' | 'map';
  code: string;
  versions: (SystemVersion | MapVersion)[];
  canManage: boolean;
  onCompare?: (versionId: string) => void;
}) {
  const action = useVersionAction(kind);
  const [confirm, setConfirm] = useState<{
    id: string;
    version: string;
    action: 'activate' | 'discard';
  } | null>(null);
  if (!versions.length) return <EmptyState title={t('No versions yet')} />;
  return (
    <>
      <ErrorAlert error={action.error} />
      <Table caption={t('Versions')}>
        <thead>
          <tr>
            <th scope="col">{t('Version')}</th>
            <th scope="col">{t('Status')}</th>
            <th scope="col" className="num">
              {kind === 'system' ? t('Codes') : t('Entries')}
            </th>
            <th scope="col">{t('Imported')}</th>
            <th scope="col">{t('Activated')}</th>
            <th scope="col">
              <span className="sr-only">{t('Actions')}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {versions.map((v) => (
            <tr key={v.id}>
              <th scope="row">
                <code>{v.version}</code>
                {v.notes && <div className="muted">{v.notes}</div>}
              </th>
              <td>
                <StatusBadge status={v.status} />
              </td>
              <td className="num">
                {formatNumber('conceptCount' in v ? v.conceptCount : v.entryCount)}
              </td>
              <td>{formatDateTime(v.importedAt)}</td>
              <td>{formatDateTime(v.activatedAt)}</td>
              <td>
                <div className="row">
                  {onCompare && (
                    <Button size="sm" variant="secondary" onClick={() => onCompare(v.id)}>
                      {t('Compare')}
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void exportVersion(kind, v.id, `${code}-${v.version}.csv`)}
                  >
                    {t('Download CSV')}
                  </Button>
                  {canManage && v.status === 'DRAFT' && (
                    <>
                      <Button
                        size="sm"
                        onClick={() =>
                          setConfirm({ id: v.id, version: v.version, action: 'activate' })
                        }
                      >
                        {t('Activate')}
                      </Button>
                      <Button
                        size="sm"
                        variant="danger"
                        onClick={() =>
                          setConfirm({ id: v.id, version: v.version, action: 'discard' })
                        }
                      >
                        {t('Discard|draft')}
                      </Button>
                    </>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
      <Dialog
        open={Boolean(confirm)}
        onClose={() => setConfirm(null)}
        title={
          confirm?.action === 'activate' ? t('Activate this version?') : t('Discard this draft?')
        }
      >
        {confirm && (
          <div className="stack">
            <p>
              {confirm.action === 'activate'
                ? t(
                    'Version {version} becomes the one in use everywhere; the current active version is retired. This is recorded in the audit trail.',
                    { version: confirm.version },
                  )
                : t('Draft {version} and its codes are deleted.', { version: confirm.version })}
            </p>
            <div className="form-actions">
              <Button variant="secondary" onClick={() => setConfirm(null)}>
                {t('Cancel')}
              </Button>
              <Button
                variant={confirm.action === 'activate' ? 'primary' : 'danger'}
                loading={action.isPending}
                onClick={() =>
                  action.mutate(
                    { id: confirm.id, action: confirm.action },
                    { onSuccess: () => setConfirm(null) },
                  )
                }
              >
                {confirm.action === 'activate' ? t('Activate') : t('Discard|draft')}
              </Button>
            </div>
          </div>
        )}
      </Dialog>
    </>
  );
}

/* ---------------------------------------------------------------- diff ---------------- */

export function DiffView({ diff }: { diff: ConceptDiff }) {
  const c = diff.counts;
  const list = (title: string, items: { code: string; display: string }[]) =>
    items.length > 0 && (
      <details>
        <summary>
          {title} ({formatNumber(items.length)})
        </summary>
        <ul>
          {items.map((i) => (
            <li key={i.code}>
              <code>{i.code}</code> {i.display}
            </li>
          ))}
        </ul>
      </details>
    );
  return (
    <div className="stack">
      <p className="muted">
        {diff.against
          ? t('Compared with version {version}.', { version: diff.against.version })
          : t('There is no other version to compare with; every code is new.')}
      </p>
      <Grid min={130}>
        <Stat label={t('Added')} value={formatNumber(c.added)} />
        <Stat label={t('Removed')} value={formatNumber(c.removed)} />
        <Stat label={t('Display changed')} value={formatNumber(c.displayChanged)} />
        <Stat label={t('Inactivated')} value={formatNumber(c.inactivated)} />
        <Stat label={t('Reactivated')} value={formatNumber(c.reactivated)} />
        <Stat label={t('Moved in the hierarchy')} value={formatNumber(c.parentChanged)} />
        <Stat label={t('Unchanged')} value={formatNumber(c.unchanged)} />
      </Grid>
      {c.removed > 0 && (
        <Alert tone="warning">
          {t('Removed codes can no longer be chosen; records that already use them keep the code.')}
        </Alert>
      )}
      {list(t('Added'), diff.added)}
      {list(t('Removed'), diff.removed)}
      {list(t('Inactivated'), diff.inactivated)}
      {list(t('Reactivated'), diff.reactivated)}
      {diff.displayChanged.length > 0 && (
        <details>
          <summary>
            {t('Display changed')} ({formatNumber(diff.displayChanged.length)})
          </summary>
          <Table caption={t('Display changed')}>
            <thead>
              <tr>
                <th scope="col">{t('Code')}</th>
                <th scope="col">{t('Text')}</th>
                <th scope="col">{t('Before')}</th>
                <th scope="col">{t('After')}</th>
              </tr>
            </thead>
            <tbody>
              {diff.displayChanged.map((d) => (
                <tr key={`${d.code}-${d.field}`}>
                  <th scope="row">
                    <code>{d.code}</code>
                  </th>
                  <td>{fieldLabel(d.field)}</td>
                  <td>{d.before ?? '—'}</td>
                  <td>{d.after ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        </details>
      )}
      {diff.parentChanged.length > 0 && (
        <details>
          <summary>
            {t('Moved in the hierarchy')} ({formatNumber(diff.parentChanged.length)})
          </summary>
          <ul>
            {diff.parentChanged.map((p) => (
              <li key={p.code}>
                <code>{p.code}</code>: {p.before ?? '—'} → {p.after ?? '—'}
              </li>
            ))}
          </ul>
        </details>
      )}
      {diff.truncated && <p className="muted">{t('Only the first 500 of each list are shown.')}</p>}
    </div>
  );
}

export function DiffDialog({
  versionId,
  onClose,
}: {
  versionId: string | null;
  onClose: () => void;
}) {
  const diff = useVersionDiff(versionId);
  return (
    <Dialog open={Boolean(versionId)} onClose={onClose} title={t('Compare versions')} wide>
      <QueryView query={diff}>
        {(d) => (
          <div className="stack">
            <p>
              {t('Version')} <code>{d.version.version}</code>{' '}
              <StatusBadge status={d.version.status} />
            </p>
            <DiffView diff={d} />
          </div>
        )}
      </QueryView>
    </Dialog>
  );
}

/* ---------------------------------------------------------------- concept --------------- */

export function ConceptDialog({
  systemId,
  code,
  versionId,
  onClose,
  onOpen,
}: {
  systemId: string;
  code: string | null;
  versionId?: string;
  onClose: () => void;
  onOpen: (code: string) => void;
}) {
  const q = useConcept(systemId, code, versionId);
  return (
    <Dialog
      open={Boolean(code)}
      onClose={onClose}
      title={code ? t('Code {code}', { code }) : ''}
      wide
    >
      <QueryView query={q}>
        {(d) => (
          <div className="stack">
            <DefinitionList
              items={[
                [t('Code system'), `${d.system.name} (${d.system.code})`],
                [t('Version'), d.version.version],
                [t('Display (English)'), d.concept.display],
                [t('Display (Albanian)'), d.concept.displaySq],
                [t('Display (Serbian)'), d.concept.displaySr],
                [
                  t('Status'),
                  d.concept.active ? (
                    <Badge tone="success">{t('Active|code')}</Badge>
                  ) : (
                    <Badge tone="neutral">{t('Inactive|code')}</Badge>
                  ),
                ],
                [
                  t('Parent|code'),
                  d.parent ? (
                    <Button variant="ghost" size="sm" onClick={() => onOpen(d.parent!.code)}>
                      {d.parent.code} – {displayOf(d.parent)}
                    </Button>
                  ) : null,
                ],
              ]}
            />
            {typeof d.concept.properties?.note === 'string' && (
              <Alert tone="warning" title={t('Needs confirmation')}>
                {d.concept.properties.note}
              </Alert>
            )}
            {d.children.length > 0 && (
              <section>
                <h3>{t('Narrower codes')}</h3>
                <ul>
                  {d.children.map((c) => (
                    <li key={c.code}>
                      <Button variant="ghost" size="sm" onClick={() => onOpen(c.code)}>
                        {c.code} – {c.display}
                      </Button>
                      {!c.active && <Badge tone="neutral">{t('Inactive|code')}</Badge>}
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {d.mappings.length > 0 && (
              <section>
                <h3>{t('Mappings')}</h3>
                <Table caption={t('Mappings')}>
                  <thead>
                    <tr>
                      <th scope="col">{t('Mapping')}</th>
                      <th scope="col">{t('Source code')}</th>
                      <th scope="col">{t('Target code')}</th>
                      <th scope="col">{t('Equivalence')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.mappings.flatMap((m) =>
                      m.entries.map((e) => (
                        <tr key={`${m.mapId}-${e.sourceCode}-${e.targetCode ?? ''}`}>
                          <th scope="row">{m.name}</th>
                          <td>
                            <code>{e.sourceCode}</code>
                          </td>
                          <td>{e.targetCode ? <code>{e.targetCode}</code> : '—'}</td>
                          <td>{equivalenceLabel(e.equivalence)}</td>
                        </tr>
                      )),
                    )}
                  </tbody>
                </Table>
              </section>
            )}
          </div>
        )}
      </QueryView>
    </Dialog>
  );
}

/* ---------------------------------------------------------------- import ---------------- */

const SYSTEM_EXAMPLE = 'code,display,display_sq,display_sr,parent,active';
const MAP_EXAMPLE = 'source_code,target_code,equivalence,comment';

export function ImportDialog({
  kind,
  target,
  onClose,
}: {
  kind: 'system' | 'map';
  target: { id: string; code: string; name: string } | null;
  onClose: () => void;
}) {
  const imp = useImportVersion(kind);
  const [file, setFile] = useState<File | null>(null);
  const [version, setVersion] = useState('');
  const [notes, setNotes] = useState('');
  const [checked, setChecked] = useState<
    ({ conceptCount?: number; diff?: ConceptDiff } & Partial<MapImportReport>) | null
  >(null);
  const close = () => {
    imp.reset();
    setFile(null);
    setVersion('');
    setNotes('');
    setChecked(null);
    onClose();
  };
  const run = (dryRun: boolean) => (e?: FormEvent) => {
    e?.preventDefault();
    if (!target || !file) return;
    imp.mutate(
      { id: target.id, file, version, notes, dryRun },
      { onSuccess: (r) => (dryRun ? setChecked(r) : close()) },
    );
  };
  return (
    <Dialog
      open={Boolean(target)}
      onClose={close}
      title={target ? t('Import a new version of {name}', { name: target.name }) : ''}
      wide
    >
      <form className="stack" onSubmit={run(true)}>
        <p className="muted">
          {t(
            'The file becomes a draft. Check it first: every problem is listed by line and nothing is saved until the file is correct. A draft is used only after it is activated.',
          )}
        </p>
        <p>
          {t('Columns (first line):')}{' '}
          <code>{kind === 'system' ? SYSTEM_EXAMPLE : MAP_EXAMPLE}</code>
        </p>
        <div className="form-grid">
          <TextField
            label={t('Version label')}
            required
            maxLength={40}
            pattern="[A-Za-z0-9][A-Za-z0-9._\-]*"
            value={version}
            onChange={(e) => setVersion(e.target.value)}
            hint={t('e.g. 2019-KS-2')}
          />
          <TextField
            label={t('CSV file')}
            type="file"
            accept=".csv,text/csv"
            required
            onChange={(e) => {
              setFile(e.target.files?.[0] ?? null);
              setChecked(null);
            }}
          />
        </div>
        <TextAreaField
          label={t('Notes')}
          maxLength={2000}
          rows={2}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
        <ErrorAlert error={imp.error} />
        {checked && (
          <Alert tone="success" title={t('The file is valid')}>
            {checked.diff ? (
              <DiffView diff={checked.diff} />
            ) : (
              <MapReport report={checked as MapImportReport} />
            )}
          </Alert>
        )}
        <div className="form-actions">
          <Button variant="secondary" onClick={close}>
            {t('Cancel')}
          </Button>
          <Button
            type="submit"
            variant="secondary"
            loading={imp.isPending}
            disabled={!file || !version}
          >
            {t('Check the file')}
          </Button>
          <Button loading={imp.isPending} disabled={!checked} onClick={() => run(false)()}>
            {t('Save as draft')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export function MapReport({ report }: { report: MapImportReport }) {
  return (
    <div className="stack">
      <p>
        {t('{count} entries; source version {source}, target version {target}.', {
          count: formatNumber(report.entryCount ?? 0),
          source: report.sourceVersion,
          target: report.targetVersion,
        })}
      </p>
      {report.byEquivalence && (
        <ul>
          {Object.entries(report.byEquivalence)
            .filter(([, n]) => n > 0)
            .map(([e, n]) => (
              <li key={e}>
                {equivalenceLabel(e as never)}: {formatNumber(n)}
              </li>
            ))}
        </ul>
      )}
      {report.unmappedSourceCodes && report.unmappedSourceCodes.count > 0 && (
        <Alert tone="warning" title={t('Source codes without a mapping')}>
          {formatNumber(report.unmappedSourceCodes.count)}:{' '}
          {report.unmappedSourceCodes.codes.join(', ')}
          {report.unmappedSourceCodes.count > report.unmappedSourceCodes.codes.length && ' …'}
        </Alert>
      )}
      {report.warnings && report.warnings.length > 0 && (
        <ul>
          {report.warnings.map((w) => (
            <li key={`${w.path}-${w.message}`}>
              <code>{w.path}</code> {t(w.message)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- create ---------------- */

export function CreateSystemDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const user = useUser();
  const create = useCreateSystem();
  const kind = user.role === 'MINISTRY' ? 'EXTERNAL' : 'LOCAL';
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const body = Object.fromEntries(
      [...f.entries()].filter(([, v]) => typeof v === 'string' && v.trim() !== ''),
    );
    create.mutate({ ...body, kind }, { onSuccess: onClose });
  };
  return (
    <Dialog open={open} onClose={onClose} title={t('New code system')}>
      <form className="stack" onSubmit={submit}>
        <p className="muted">
          {kind === 'EXTERNAL'
            ? t('A national or international code system, managed by the Ministry.')
            : t('A local code system of your facility, e.g. the laboratory’s own test codes.')}
        </p>
        <TextField
          label={t('Code|identifier')}
          name="code"
          required
          pattern="[A-Z0-9][A-Z0-9\-]{1,39}"
          hint={t('Capital letters, digits and hyphens, e.g. LOCAL-LAB-QKUK')}
        />
        <TextField label={t('Name')} name="name" required minLength={3} maxLength={200} />
        <TextField
          label={t('Canonical URL')}
          name="url"
          type="url"
          required
          maxLength={300}
          hint={t('Unique address that identifies the code system, e.g. in FHIR messages')}
        />
        <TextField label={t('Publisher')} name="publisher" maxLength={200} />
        <TextAreaField
          label={t('Description and licence')}
          name="description"
          maxLength={4000}
          rows={3}
        />
        <ErrorAlert error={create.error} />
        <div className="form-actions">
          <Button variant="secondary" onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button type="submit" loading={create.isPending}>
            {t('Create')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export function CreateMapDialog({
  open,
  onClose,
  systems,
}: {
  open: boolean;
  onClose: () => void;
  systems: CodeSystemSummary[];
}) {
  const create = useCreateMap();
  const options = systems.map((s) => ({ value: s.id, label: `${s.code} – ${s.name}` }));
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget).entries());
    create.mutate(f, { onSuccess: onClose });
  };
  return (
    <Dialog open={open} onClose={onClose} title={t('New mapping')}>
      <form className="stack" onSubmit={submit}>
        <p className="muted">
          {t(
            'A mapping that uses a local code system belongs to that facility; mappings between national code systems belong to the Ministry.',
          )}
        </p>
        <TextField
          label={t('Code|identifier')}
          name="code"
          required
          pattern="[A-Z0-9][A-Z0-9\-]{1,59}"
          hint={t('Capital letters, digits and hyphens')}
        />
        <TextField label={t('Name')} name="name" required minLength={3} maxLength={200} />
        <TextField label={t('Canonical URL')} name="url" type="url" required maxLength={300} />
        <SelectField
          label={t('Source code system')}
          name="sourceSystemId"
          required
          placeholder={t('Choose…')}
          options={options}
        />
        <SelectField
          label={t('Target code system')}
          name="targetSystemId"
          required
          placeholder={t('Choose…')}
          options={options}
        />
        <ErrorAlert error={create.error} />
        <div className="form-actions">
          <Button variant="secondary" onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button type="submit" loading={create.isPending}>
            {t('Create')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
