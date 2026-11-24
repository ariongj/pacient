import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/client';
import {
  fetchTemplate,
  kindPath,
  LEGAL_KINDS,
  LEGAL_LOCALES,
  useAcceptanceStats,
  useLegalAdmin,
  useLegalDocumentAdmin,
  useLegalMutation,
  type LegalAdminList,
  type LegalDocumentFull,
  type LegalDocumentSummary,
  type LegalKind,
  type LegalLocale,
} from '../../api/platform';
import {
  Alert,
  Badge,
  Button,
  Card,
  Dialog,
  EmptyState,
  ErrorAlert,
  formValues,
  PageHeader,
  QueryView,
  SelectField,
  Table,
  TextAreaField,
  TextField,
} from '../../components/ui';
import { formatDate, formatDateTime, humanize } from '../../format';
import { LOCALES, t } from '../../i18n';
import { LegalText } from './platform/LegalText';
import { settingLabel } from './platform/labels';

const kindLabel = (k: LegalKind) => (k === 'TERMS' ? t('Terms of use') : t('Privacy notice'));
const languageLabel = (l: string) => LOCALES.find((x) => x.value === l)?.label ?? l;
/** Newest version first ("10.0" after "9.1"), then the languages in a fixed order. */
const byVersion = (a: LegalDocumentSummary, b: LegalDocumentSummary) =>
  b.version.localeCompare(a.version, undefined, { numeric: true }) ||
  LEGAL_LOCALES.indexOf(a.locale) - LEGAL_LOCALES.indexOf(b.locale);
/**
 * Whether another published text of this kind (not `self`) asked for acceptance. Then a version
 * that does not ask is still accepted by everyone who never accepted the latest one that did (new
 * accounts among them); otherwise nobody is asked.
 */
const askedElsewhere = (
  list: LegalAdminList,
  kind: LegalKind,
  self: (d: LegalDocumentSummary) => boolean,
) =>
  list.documents.some((d) => d.kind === kind && !self(d) && d.publishedAt && d.requiresAcceptance);

/**
 * Terms of use and privacy notice: versions per language, drafts, publishing and who accepted.
 * A published text is fixed; a change is a new version that users accept at their next sign-in.
 */
export function LegalAdmin() {
  const list = useLegalAdmin();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [publishing, setPublishing] = useState<LegalDocumentSummary | null>(null);
  const [deleting, setDeleting] = useState<LegalDocumentSummary | null>(null);
  const [who, setWho] = useState<{ kind: LegalKind; version: string } | null>(null);

  return (
    <>
      <PageHeader
        title={t('Terms and privacy')}
        subtitle={t('Terms of use and privacy notice: drafts, publishing, acceptance.')}
        actions={<Button onClick={() => setCreating(true)}>{t('New version')}</Button>}
      />
      <Alert tone="warning" title={t('The starting texts are drafts')}>
        {t(
          'They describe how Pacient works, but they are not legal advice. Have every text reviewed by a lawyer before you publish it.',
        )}
      </Alert>
      <QueryView query={list}>
        {(l) => (
          <>
            {l.missingSettings.length > 0 && (
              <Alert tone="warning" title={t('Operator details missing')}>
                {t('The texts refer to details that are still empty:')}{' '}
                {l.missingSettings.map(settingLabel).join(', ')}.{' '}
                <Link to="/admin/settings">{t('Fill them in under operator settings.')}</Link>
              </Alert>
            )}
            {LEGAL_KINDS.map((kind) => (
              <KindCard
                key={kind}
                kind={kind}
                list={l}
                onEdit={setEditing}
                onPublish={setPublishing}
                onDelete={setDeleting}
                onWho={(version) => setWho({ kind, version })}
              />
            ))}
          </>
        )}
      </QueryView>

      <Dialog open={creating} onClose={() => setCreating(false)} title={t('New version')} wide>
        {creating && list.data && (
          <NewVersionForm
            list={list.data}
            onCancel={() => setCreating(false)}
            onCreated={(id) => {
              setCreating(false);
              setEditing(id);
            }}
          />
        )}
      </Dialog>
      <Dialog
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={t('Text of the document')}
        wide
      >
        {editing && <Editor id={editing} onClose={() => setEditing(null)} />}
      </Dialog>
      <Dialog
        open={publishing !== null}
        onClose={() => setPublishing(null)}
        title={t('Publish this text?')}
      >
        {publishing && (
          <PublishConfirm
            doc={publishing}
            othersAsk={Boolean(
              list.data &&
              askedElsewhere(list.data, publishing.kind, (d) => d.id === publishing.id),
            )}
            onClose={() => setPublishing(null)}
          />
        )}
      </Dialog>
      <Dialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title={t('Delete this draft?')}
      >
        {deleting && <DeleteConfirm doc={deleting} onClose={() => setDeleting(null)} />}
      </Dialog>
      <Dialog open={who !== null} onClose={() => setWho(null)} title={t('Who accepted')} wide>
        {who && <WhoAccepted kind={who.kind} version={who.version} />}
      </Dialog>
    </>
  );
}

function KindCard({
  kind,
  list,
  onEdit,
  onPublish,
  onDelete,
  onWho,
}: {
  kind: LegalKind;
  list: LegalAdminList;
  onEdit: (id: string) => void;
  onPublish: (d: LegalDocumentSummary) => void;
  onDelete: (d: LegalDocumentSummary) => void;
  onWho: (version: string) => void;
}) {
  const docs = list.documents.filter((d) => d.kind === kind).sort(byVersion);
  const current = list.current[kind];
  const accepted = list.acceptance.find((a) => a.kind === kind && a.version === current)?.accepted;
  const requires = docs.some((d) => d.version === current && d.publishedAt && d.requiresAcceptance);
  // A current version that does not ask for acceptance is still accepted by those who never
  // accepted the latest one that did: their acceptances are recorded and shown here too.
  const acceptedByNewcomers = !requires && askedElsewhere(list, kind, (d) => d.version === current);
  return (
    <Card
      title={kindLabel(kind)}
      actions={
        current ? (
          <Link to={kindPath(kind)} target="_blank" rel="noreferrer">
            {t('Open the public page')}
          </Link>
        ) : undefined
      }
    >
      {current ? (
        <p>
          {t('Current version: {version}.', { version: current })}{' '}
          {requires || acceptedByNewcomers ? (
            <>
              {acceptedByNewcomers && (
                <span className="muted">
                  {t(
                    'Users who accepted an earlier version are not asked again; new accounts and anyone who never accepted the latest version that required acceptance accept this one.',
                  )}{' '}
                </span>
              )}
              {t('{accepted} of {active} active accounts have accepted it.', {
                accepted: accepted ?? 0,
                active: list.activeAccounts,
              })}{' '}
              <Button size="sm" variant="secondary" onClick={() => onWho(current)}>
                {t('Who accepted')}
              </Button>
            </>
          ) : (
            <span className="muted">{t('Users are not asked to accept this version.')}</span>
          )}
        </p>
      ) : (
        <p className="muted">{t('Nothing published yet: the public page says so.')}</p>
      )}
      {docs.length === 0 ? (
        <EmptyState title={t('No versions yet')}>
          {t('Use “New version” to start from the draft text.')}
        </EmptyState>
      ) : (
        <Table caption={kindLabel(kind)}>
          <thead>
            <tr>
              <th scope="col">{t('Version')}</th>
              <th scope="col">{t('Language')}</th>
              <th scope="col">{t('Title')}</th>
              <th scope="col">{t('Status')}</th>
              <th scope="col">
                <span className="sr-only">{t('Actions')}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {docs.map((d) => (
              <tr key={d.id}>
                <td>
                  {d.version}
                  {d.version === current && (
                    <div>
                      <Badge tone="info">{t('Current|legal version')}</Badge>
                    </div>
                  )}
                </td>
                <td>{languageLabel(d.locale)}</td>
                <td>
                  {d.title}
                  <div className="muted">
                    {d.requiresAcceptance ? t('Users must accept it') : t('For information only')}
                  </div>
                </td>
                <td>
                  {d.publishedAt ? (
                    <Badge tone="success">
                      {t('Published {date}', { date: formatDate(d.publishedAt) })}
                    </Badge>
                  ) : (
                    <Badge tone="warning">{t('Draft|legal document')}</Badge>
                  )}
                </td>
                <td>
                  <div className="row" style={{ gap: '0.35rem', flexWrap: 'wrap' }}>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => onEdit(d.id)}
                      aria-label={`${d.publishedAt ? t('View') : t('Edit')} – ${kindLabel(kind)} ${d.version} ${languageLabel(d.locale)}`}
                    >
                      {d.publishedAt ? t('View') : t('Edit')}
                    </Button>
                    {!d.publishedAt && (
                      <>
                        <Button
                          size="sm"
                          onClick={() => onPublish(d)}
                          aria-label={`${t('Publish')} – ${kindLabel(kind)} ${d.version} ${languageLabel(d.locale)}`}
                        >
                          {t('Publish')}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => onDelete(d)}
                          aria-label={`${t('Delete')} – ${kindLabel(kind)} ${d.version} ${languageLabel(d.locale)}`}
                        >
                          {t('Delete')}
                        </Button>
                      </>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}

/** A new draft, started from the draft template or from the current version's text. */
function NewVersionForm({
  list,
  onCancel,
  onCreated,
}: {
  list: LegalAdminList;
  onCancel: () => void;
  onCreated: (id: string) => void;
}) {
  const [kind, setKind] = useState<LegalKind>('TERMS');
  const [locale, setLocale] = useState<LegalLocale>('sq');
  const [start, setStart] = useState<'copy' | 'template' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const create = useLegalMutation((body: Record<string, unknown>) => ({
    path: '/admin/legal',
    method: 'POST',
    body,
  }));
  const current = list.current[kind];
  const startFrom = current ? (start ?? 'copy') : 'template';
  // The published translation of the current version a copy starts from (else any of them).
  const copied = (() => {
    const docs = list.documents.filter(
      (d) => d.kind === kind && d.version === current && d.publishedAt,
    );
    return docs.find((d) => d.locale === locale) ?? docs[0];
  })();

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const v = formValues(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      let source: { title: string; body: string };
      if (startFrom === 'copy' && copied) {
        // The text as written, with its placeholders, so this version gets the operator details
        // of its own publication. Texts published before that was kept have only the filled-in
        // text (the form says so).
        const doc = await api<LegalDocumentFull>(`/admin/legal/${copied.id}`);
        source =
          doc.titleSource !== null && doc.bodySource !== null
            ? { title: doc.titleSource, body: doc.bodySource }
            : doc;
      } else {
        source = await fetchTemplate(kind, locale);
      }
      const doc = await create.mutateAsync({
        kind,
        version: v.version,
        locale,
        title: source.title,
        body: source.body,
        requiresAcceptance: v.requiresAcceptance === 'on',
      });
      if (doc) onCreated(doc.id);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => void onSubmit(e)}>
      <div className="form-grid">
        <SelectField
          label={t('Text')}
          name="kind"
          value={kind}
          onChange={(e) => setKind(e.target.value as LegalKind)}
          options={LEGAL_KINDS.map((k) => ({ value: k, label: kindLabel(k) }))}
        />
        <TextField
          label={t('Version')}
          name="version"
          required
          maxLength={20}
          pattern="[0-9A-Za-z][0-9A-Za-z._\-]{0,19}"
          placeholder={current ? t('e.g. {example}', { example: nextVersion(current) }) : '1.0'}
          hint={
            current
              ? t('The current version is {version}. Use the same version for a translation.', {
                  version: current,
                })
              : t('For example 1.0.')
          }
        />
        <SelectField
          label={t('Language')}
          name="locale"
          value={locale}
          onChange={(e) => setLocale(e.target.value as LegalLocale)}
          options={LEGAL_LOCALES.map((l) => ({ value: l, label: languageLabel(l) }))}
        />
        <SelectField
          label={t('Start from')}
          name="start"
          value={startFrom}
          onChange={(e) => setStart(e.target.value as 'copy' | 'template')}
          options={[
            ...(current
              ? [
                  {
                    value: 'copy',
                    label: t('The current version ({version})', { version: current }),
                  },
                ]
              : []),
            { value: 'template', label: t('The draft template') },
          ]}
        />
      </div>
      <label className="checkbox" style={{ margin: '0.75rem 0' }}>
        <input type="checkbox" name="requiresAcceptance" defaultChecked />{' '}
        {t('Users must accept this version at their next sign-in')}
      </label>
      <p className="muted">
        {t(
          'Details such as {operatorName} or {privacyEmail} are filled in from the operator settings when the text is published.',
        )}
      </p>
      {startFrom === 'copy' && copied && !copied.hasSource && (
        <Alert tone="warning" title={t('Check the operator details in the copy')}>
          {t(
            'This version was published before the text as written was kept: the copy may contain the operator details as they were when it was published instead of placeholders. Check them against the operator settings, or replace them with placeholders, before you publish.',
          )}
        </Alert>
      )}
      <ErrorAlert error={error} />
      <div className="form-actions">
        <Button variant="secondary" onClick={onCancel}>
          {t('Cancel')}
        </Button>
        <Button type="submit" loading={busy}>
          {t('Create draft')}
        </Button>
      </div>
    </form>
  );
}

/** "1.0" → "2.0"; anything else gets "-2" appended as a suggestion only. */
function nextVersion(v: string) {
  const m = /^(\d+)(\.\d+)?$/.exec(v);
  return m ? `${Number(m[1]) + 1}.0` : `${v}-2`;
}

function Editor({ id, onClose }: { id: string; onClose: () => void }) {
  const doc = useLegalDocumentAdmin(id);
  return <QueryView query={doc}>{(d) => <EditorForm doc={d} onClose={onClose} />}</QueryView>;
}

function EditorForm({ doc, onClose }: { doc: LegalDocumentFull; onClose: () => void }) {
  const [body, setBody] = useState(doc.body);
  const [preview, setPreview] = useState(Boolean(doc.publishedAt));
  const save = useLegalMutation(
    (patch: Record<string, unknown>) => ({
      path: `/admin/legal/${doc.id}`,
      method: 'PATCH',
      body: patch,
    }),
    onClose,
  );
  const heading = `${kindLabel(doc.kind)} · ${t('Version {version}', { version: doc.version })} · ${languageLabel(doc.locale)}`;

  if (doc.publishedAt) {
    return (
      <div className="stack">
        <p className="muted">
          {heading} · {t('Published {date}', { date: formatDateTime(doc.publishedAt) })}.{' '}
          {t('A published text cannot be changed; create a new version instead.')}
        </p>
        <h3>{doc.title}</h3>
        <LegalText body={doc.body} level={3} />
        <div className="form-actions">
          <Button variant="secondary" onClick={onClose}>
            {t('Close')}
          </Button>
        </div>
      </div>
    );
  }

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const v = formValues(e.currentTarget);
    save.mutate({ title: v.title, body, requiresAcceptance: v.requiresAcceptance === 'on' });
  }

  return (
    <form onSubmit={onSubmit}>
      <p className="muted">{heading}</p>
      <TextField
        label={t('Title')}
        name="title"
        required
        minLength={2}
        maxLength={200}
        defaultValue={doc.title}
      />
      {preview ? (
        <div
          role="region"
          aria-label={t('Preview')}
          tabIndex={0}
          style={{
            maxHeight: '50vh',
            overflowY: 'auto',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-sm)',
            padding: '0.75rem 1rem',
          }}
        >
          <LegalText body={body} level={3} />
        </div>
      ) : (
        <TextAreaField
          label={t('Text')}
          name="body"
          required
          minLength={20}
          maxLength={100000}
          rows={18}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          style={{ fontFamily: 'var(--mono)', fontSize: '0.9rem' }}
          hint={t(
            'A line starting with "# " is a heading, "- " a list item; an empty line starts a new paragraph.',
          )}
        />
      )}
      <label className="checkbox" style={{ margin: '0.75rem 0' }}>
        <input type="checkbox" name="requiresAcceptance" defaultChecked={doc.requiresAcceptance} />{' '}
        {t('Users must accept this version at their next sign-in')}
      </label>
      <ErrorAlert error={save.error} />
      <div className="form-actions">
        <Button variant="ghost" onClick={() => setPreview((p) => !p)}>
          {preview ? t('Edit the text') : t('Preview')}
        </Button>
        <Button variant="secondary" onClick={onClose}>
          {t('Cancel')}
        </Button>
        <Button type="submit" loading={save.isPending}>
          {t('Save draft')}
        </Button>
      </div>
    </form>
  );
}

function PublishConfirm({
  doc,
  othersAsk,
  onClose,
}: {
  doc: LegalDocumentSummary;
  /** Another published text of this kind asked for acceptance. */
  othersAsk: boolean;
  onClose: () => void;
}) {
  const publish = useLegalMutation(
    () => ({ path: `/admin/legal/${doc.id}/publish`, method: 'POST', body: {} }),
    onClose,
  );
  return (
    <div className="stack">
      <p>
        <strong>
          {kindLabel(doc.kind)} · {t('Version {version}', { version: doc.version })} ·{' '}
          {languageLabel(doc.locale)}
        </strong>
      </p>
      <p>{t('Once published, the text cannot be changed. A later change is a new version.')}</p>
      <p>
        {t(
          'The operator details it refers to are written into the text now: changing the operator settings later does not change this version.',
        )}
      </p>
      <p>
        {doc.requiresAcceptance
          ? t('Every user is asked to accept this version the next time they sign in.')
          : othersAsk
            ? t(
                'The text is shown on the public page. Users who accepted an earlier version are not asked again; new accounts and anyone who never accepted the latest version that required acceptance accept this one.',
              )
            : t('The text is shown on the public page; users are not asked to accept it.')}
      </p>
      <ErrorAlert error={publish.error} />
      <div className="form-actions">
        <Button variant="secondary" onClick={onClose}>
          {t('Cancel')}
        </Button>
        <Button loading={publish.isPending} onClick={() => publish.mutate(undefined)}>
          {t('Publish')}
        </Button>
      </div>
    </div>
  );
}

function DeleteConfirm({ doc, onClose }: { doc: LegalDocumentSummary; onClose: () => void }) {
  const remove = useLegalMutation(
    () => ({ path: `/admin/legal/${doc.id}`, method: 'DELETE' }),
    onClose,
  );
  return (
    <div className="stack">
      <p>
        {kindLabel(doc.kind)} · {t('Version {version}', { version: doc.version })} ·{' '}
        {languageLabel(doc.locale)}
      </p>
      <ErrorAlert error={remove.error} />
      <div className="form-actions">
        <Button variant="secondary" onClick={onClose}>
          {t('Cancel')}
        </Button>
        <Button
          variant="danger"
          loading={remove.isPending}
          onClick={() => remove.mutate(undefined)}
        >
          {t('Delete draft')}
        </Button>
      </div>
    </div>
  );
}

function WhoAccepted({ kind, version }: { kind: LegalKind; version: string }) {
  const stats = useAcceptanceStats(kind, version);
  return (
    <QueryView query={stats}>
      {(s) => (
        <div className="stack">
          <p>
            {kindLabel(kind)} · {t('Version {version}', { version })}:{' '}
            {t('{accepted} of {active} active accounts have accepted it.', {
              accepted: s.accepted,
              active: s.activeAccounts,
            })}
          </p>
          {s.latest.length === 0 ? (
            <EmptyState title={t('Nobody has accepted this version yet')} />
          ) : (
            <Table caption={t('Latest acceptances')}>
              <thead>
                <tr>
                  <th scope="col">{t('Name')}</th>
                  <th scope="col">{t('Role')}</th>
                  <th scope="col">{t('Language')}</th>
                  <th scope="col">{t('Accepted')}</th>
                </tr>
              </thead>
              <tbody>
                {s.latest.map((a) => (
                  <tr key={a.id}>
                    <td>
                      {a.userName ?? (
                        <span className="muted">{t('Patient account|user account')}</span>
                      )}
                    </td>
                    <td>{humanize(a.role)}</td>
                    <td>{languageLabel(a.locale)}</td>
                    <td>{formatDateTime(a.acceptedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
          <p className="muted">
            {t('The latest 50 acceptances are listed.')}{' '}
            {t('Patients are not named: only that a patient account accepted, and when.')}
          </p>
        </div>
      )}
    </QueryView>
  );
}
