import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useUser } from '../../auth/AuthContext';
import {
  EQUIVALENCES,
  equivalenceLabel,
  kindLabel,
  statusLabel,
  useCodeSystem,
  useCodeSystems,
  useConceptMaps,
  useConcepts,
  useMapEntries,
  type CodeSystemSummary,
  type ConceptMapSummary,
} from '../../api/terminology';
import {
  Alert,
  Badge,
  Button,
  Card,
  DefinitionList,
  EmptyState,
  PageHeader,
  Pagination,
  QueryView,
  SelectField,
  Table,
  TabPanel,
  Tabs,
  TextField,
} from '../../components/ui';
import { formatNumber } from '../../format';
import { t } from '../../i18n';
import {
  ConceptDialog,
  CreateMapDialog,
  CreateSystemDialog,
  DiffDialog,
  displayOf,
  ImportDialog,
  StatusBadge,
  VersionsTable,
} from './TerminologyComponents';

type TabId = 'systems' | 'maps';

/**
 * Terminology: code systems (ICD-10, LOINC, ATC, local codes) with their versions and concepts,
 * and mappings between them. Everyone on the staff reads; the Ministry manages national code
 * systems and a director the local ones of their facility.
 */
export function TerminologyPage() {
  const user = useUser();
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') === 'maps' ? 'maps' : 'systems') as TabId;
  const setTab = (id: TabId) => setParams({ tab: id }, { replace: true });
  const canCreate = user.role === 'MINISTRY' || user.role === 'DIRECTOR';
  return (
    <>
      <PageHeader
        title={t('Terminology')}
        subtitle={t(
          'Code systems used in Pacient, their versions and the mappings between local and national codes.',
        )}
      />
      <Tabs
        label={t('Terminology')}
        active={tab}
        onChange={setTab}
        tabs={[
          { id: 'systems', label: t('Code systems') },
          { id: 'maps', label: t('Mappings') },
        ]}
      />
      <TabPanel id={tab}>
        {tab === 'systems' ? (
          <SystemsTab canCreate={canCreate} />
        ) : (
          <MapsTab canCreate={canCreate} />
        )}
      </TabPanel>
    </>
  );
}

/* ------------------------------------------------------------------ code systems --------- */

function SystemsTab({ canCreate }: { canCreate: boolean }) {
  const systems = useCodeSystems();
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  return (
    <div className="stack">
      <QueryView query={systems}>
        {(items) => {
          // Until one is chosen, open a system with a draft waiting (that is where work is).
          const current =
            items.find((s) => s.id === selected) ??
            items.find((s) => s.drafts > 0) ??
            items[0] ??
            null;
          return (
            <>
              <Card
                title={t('Code systems')}
                actions={
                  canCreate && (
                    <Button size="sm" onClick={() => setCreating(true)}>
                      {t('New code system')}
                    </Button>
                  )
                }
              >
                {items.length === 0 ? (
                  <EmptyState title={t('No code systems yet')} />
                ) : (
                  <Table caption={t('Code systems')}>
                    <thead>
                      <tr>
                        <th scope="col">{t('Code system')}</th>
                        <th scope="col">{t('Kind')}</th>
                        <th scope="col">{t('Version in use')}</th>
                        <th scope="col" className="num">
                          {t('Codes')}
                        </th>
                        <th scope="col">{t('Drafts')}</th>
                        <th scope="col">
                          <span className="sr-only">{t('Actions')}</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {items.map((s) => (
                        <tr key={s.id} aria-current={current?.id === s.id || undefined}>
                          <th scope="row">
                            <strong>{s.name}</strong>
                            <div className="muted">
                              <code>{s.code}</code>
                            </div>
                          </th>
                          <td>{kindLabel(s.kind)}</td>
                          <td>{s.activeVersion ? <code>{s.activeVersion.version}</code> : '—'}</td>
                          <td className="num">
                            {s.activeVersion ? formatNumber(s.activeVersion.conceptCount) : '—'}
                          </td>
                          <td>
                            {s.drafts > 0 ? (
                              <Badge tone="warning">{formatNumber(s.drafts)}</Badge>
                            ) : (
                              '—'
                            )}
                          </td>
                          <td>
                            <Button
                              size="sm"
                              variant={current?.id === s.id ? 'primary' : 'secondary'}
                              onClick={() => setSelected(s.id)}
                              aria-label={t('Open {name}', { name: s.name })}
                            >
                              {t('Open|action')}
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                )}
              </Card>
              {current && <SystemPanel key={current.id} summary={current} />}
            </>
          );
        }}
      </QueryView>
      <CreateSystemDialog open={creating} onClose={() => setCreating(false)} />
    </div>
  );
}

function SystemPanel({ summary }: { summary: CodeSystemSummary }) {
  const detail = useCodeSystem(summary.id);
  const [comparing, setComparing] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  return (
    <>
      <Card
        title={summary.name}
        actions={
          summary.canManage && (
            <Button size="sm" onClick={() => setImporting(true)}>
              {t('Import a new version')}
            </Button>
          )
        }
      >
        <QueryView query={detail}>
          {(d) => (
            <div className="stack">
              <DefinitionList
                items={[
                  [t('Code|identifier'), <code key="c">{d.code}</code>],
                  [
                    t('Canonical URL'),
                    <code key="u" style={{ overflowWrap: 'anywhere' }}>
                      {d.url}
                    </code>,
                  ],
                  [t('Kind'), kindLabel(d.kind)],
                  [t('Publisher'), d.publisher],
                ]}
              />
              {d.description && <p className="muted">{d.description}</p>}
              <h3>{t('Versions')}</h3>
              <VersionsTable
                kind="system"
                code={d.code}
                versions={d.versions}
                canManage={d.canManage}
                onCompare={setComparing}
              />
            </div>
          )}
        </QueryView>
      </Card>
      {summary.activeVersion || (detail.data?.versions.length ?? 0) > 0 ? (
        <ConceptBrowser summary={summary} versions={detail.data?.versions ?? []} />
      ) : null}
      <DiffDialog versionId={comparing} onClose={() => setComparing(null)} />
      <ImportDialog
        kind="system"
        target={importing ? summary : null}
        onClose={() => setImporting(false)}
      />
    </>
  );
}

function ConceptBrowser({
  summary,
  versions,
}: {
  summary: CodeSystemSummary;
  versions: { id: string; version: string; status: 'DRAFT' | 'ACTIVE' | 'RETIRED' }[];
}) {
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [versionId, setVersionId] = useState<string>('');
  const [activeOnly, setActiveOnly] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const concepts = useConcepts(summary.id, {
    q,
    page,
    versionId: versionId || undefined,
    activeOnly,
  });
  return (
    <Card title={t('Codes')}>
      <div className="form-grid">
        <TextField
          label={t('Search by code or text')}
          type="search"
          value={q}
          maxLength={100}
          onChange={(e) => {
            setQ(e.target.value);
            setPage(1);
          }}
          hint={t('Text is searched in English, Albanian and Serbian')}
        />
        <SelectField
          label={t('Version')}
          value={versionId}
          placeholder={t('Version in use')}
          onChange={(e) => {
            setVersionId(e.target.value);
            setPage(1);
          }}
          options={versions
            .filter((v) => v.status !== 'ACTIVE')
            .map((v) => ({
              value: v.id,
              label: `${v.version} (${statusLabel(v.status)})`,
            }))}
        />
        <label className="checkbox" style={{ alignSelf: 'end' }}>
          <input
            type="checkbox"
            checked={activeOnly}
            onChange={(e) => {
              setActiveOnly(e.target.checked);
              setPage(1);
            }}
          />
          <span>{t('Only active codes')}</span>
        </label>
      </div>
      {!summary.activeVersion && !versionId ? (
        <Alert tone="info">
          {t('This code system has no version in use yet. Choose a draft to look at it.')}
        </Alert>
      ) : (
        <QueryView query={concepts}>
          {(r) =>
            r.items.length === 0 ? (
              <EmptyState title={t('No codes found')} />
            ) : (
              <>
                <p className="muted" aria-live="polite">
                  {t('{count} codes in version {version}', {
                    count: formatNumber(r.total),
                    version: r.version.version,
                  })}{' '}
                  <StatusBadge status={r.version.status} />
                </p>
                <Table caption={t('Codes')}>
                  <thead>
                    <tr>
                      <th scope="col">{t('Code')}</th>
                      <th scope="col">{t('Display')}</th>
                      <th scope="col">{t('Parent|code')}</th>
                      <th scope="col">{t('Status')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.items.map((c) => (
                      <tr key={c.code}>
                        <th scope="row">
                          <Button variant="ghost" size="sm" onClick={() => setOpen(c.code)}>
                            <code>{c.code}</code>
                          </Button>
                        </th>
                        <td>
                          {displayOf(c)}
                          {displayOf(c) !== c.display && <div className="muted">{c.display}</div>}
                        </td>
                        <td>{c.parentCode ? <code>{c.parentCode}</code> : '—'}</td>
                        <td>
                          {c.active ? (
                            <Badge tone="success">{t('Active|code')}</Badge>
                          ) : (
                            <Badge tone="neutral">{t('Inactive|code')}</Badge>
                          )}
                          {c.properties?.needsConfirmation === true && (
                            <Badge tone="warning">{t('Needs confirmation')}</Badge>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
                <Pagination page={r.page} totalPages={r.totalPages} onChange={setPage} />
              </>
            )
          }
        </QueryView>
      )}
      <ConceptDialog
        systemId={summary.id}
        code={open}
        versionId={versionId || undefined}
        onClose={() => setOpen(null)}
        onOpen={setOpen}
      />
    </Card>
  );
}

/* ------------------------------------------------------------------ mappings ------------ */

function MapsTab({ canCreate }: { canCreate: boolean }) {
  const maps = useConceptMaps();
  const systems = useCodeSystems();
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  return (
    <div className="stack">
      <QueryView query={maps}>
        {(items) => {
          const current = items.find((m) => m.id === selected) ?? items[0] ?? null;
          return (
            <>
              <Card
                title={t('Mappings')}
                actions={
                  canCreate && (
                    <Button size="sm" onClick={() => setCreating(true)} disabled={!systems.data}>
                      {t('New mapping')}
                    </Button>
                  )
                }
              >
                {items.length === 0 ? (
                  <EmptyState title={t('No mappings yet')} />
                ) : (
                  <Table caption={t('Mappings')}>
                    <thead>
                      <tr>
                        <th scope="col">{t('Mapping')}</th>
                        <th scope="col">{t('Source code system')}</th>
                        <th scope="col">{t('Target code system')}</th>
                        <th scope="col">{t('Version in use')}</th>
                        <th scope="col" className="num">
                          {t('Entries')}
                        </th>
                        <th scope="col">
                          <span className="sr-only">{t('Actions')}</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {items.map((m) => (
                        <tr key={m.id}>
                          <th scope="row">
                            <strong>{m.name}</strong>
                            <div className="muted">
                              <code>{m.code}</code>
                            </div>
                          </th>
                          <td>
                            <code>{m.source.code}</code>
                          </td>
                          <td>
                            <code>{m.target.code}</code>
                          </td>
                          <td>{m.activeVersion ? <code>{m.activeVersion.version}</code> : '—'}</td>
                          <td className="num">
                            {m.activeVersion ? formatNumber(m.activeVersion.entryCount) : '—'}
                          </td>
                          <td>
                            <Button
                              size="sm"
                              variant={current?.id === m.id ? 'primary' : 'secondary'}
                              onClick={() => setSelected(m.id)}
                              aria-label={t('Open {name}', { name: m.name })}
                            >
                              {t('Open|action')}
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                )}
              </Card>
              {current && <MapPanel key={current.id} map={current} />}
            </>
          );
        }}
      </QueryView>
      <CreateMapDialog
        open={creating}
        onClose={() => setCreating(false)}
        systems={systems.data ?? []}
      />
    </div>
  );
}

function MapPanel({ map }: { map: ConceptMapSummary }) {
  const [importing, setImporting] = useState(false);
  const [q, setQ] = useState('');
  const [equivalence, setEquivalence] = useState('');
  const [page, setPage] = useState(1);
  const entries = useMapEntries(map.activeVersion ? map.id : null, { q, equivalence, page });
  return (
    <>
      <Card
        title={map.name}
        actions={
          map.canManage && (
            <Button size="sm" onClick={() => setImporting(true)}>
              {t('Import a new version')}
            </Button>
          )
        }
      >
        <div className="stack">
          <DefinitionList
            items={[
              [t('Code|identifier'), <code key="c">{map.code}</code>],
              [
                t('Canonical URL'),
                <code key="u" style={{ overflowWrap: 'anywhere' }}>
                  {map.url}
                </code>,
              ],
              [t('Source code system'), `${map.source.name} (${map.source.code})`],
              [t('Target code system'), `${map.target.name} (${map.target.code})`],
            ]}
          />
          <h3>{t('Versions')}</h3>
          <VersionsTable
            kind="map"
            code={map.code}
            versions={map.versions}
            canManage={map.canManage}
          />
        </div>
      </Card>
      <Card title={t('Entries in the version in use')}>
        {!map.activeVersion ? (
          <Alert tone="info">{t('This mapping has no version in use yet.')}</Alert>
        ) : (
          <>
            <div className="form-grid">
              <TextField
                label={t('Search by code or text')}
                type="search"
                value={q}
                maxLength={100}
                onChange={(e) => {
                  setQ(e.target.value);
                  setPage(1);
                }}
              />
              <SelectField
                label={t('Equivalence')}
                value={equivalence}
                placeholder={t('All')}
                onChange={(e) => {
                  setEquivalence(e.target.value);
                  setPage(1);
                }}
                options={EQUIVALENCES.map((e) => ({ value: e, label: equivalenceLabel(e) }))}
              />
            </div>
            <QueryView query={entries}>
              {(r) =>
                r.items.length === 0 ? (
                  <EmptyState title={t('No entries found')} />
                ) : (
                  <>
                    <Table caption={t('Entries in the version in use')}>
                      <thead>
                        <tr>
                          <th scope="col">{t('Source code')}</th>
                          <th scope="col">{t('Target code')}</th>
                          <th scope="col">{t('Equivalence')}</th>
                          <th scope="col">{t('Comment')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {r.items.map((e) => (
                          <tr key={`${e.sourceCode}-${e.targetCode ?? ''}`}>
                            <th scope="row">
                              <code>{e.sourceCode}</code>
                              {e.sourceDisplay && <div className="muted">{e.sourceDisplay}</div>}
                            </th>
                            <td>
                              {e.targetCode ? <code>{e.targetCode}</code> : '—'}
                              {e.targetDisplay && <div className="muted">{e.targetDisplay}</div>}
                            </td>
                            <td>
                              <Badge tone={e.equivalence === 'UNMATCHED' ? 'warning' : 'neutral'}>
                                {equivalenceLabel(e.equivalence)}
                              </Badge>
                            </td>
                            <td>{e.comment ?? '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </Table>
                    <Pagination page={r.page} totalPages={r.totalPages} onChange={setPage} />
                  </>
                )
              }
            </QueryView>
          </>
        )}
      </Card>
      <ImportDialog
        kind="map"
        target={importing ? map : null}
        onClose={() => setImporting(false)}
      />
    </>
  );
}
