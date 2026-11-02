import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState, type ReactNode } from 'react';
import { api } from '../../api/client';
import {
  mergeApi,
  type ChoosableField,
  type CompareSide,
  type DuplicateCandidate,
  type MergeHistoryItem,
} from '../../api/merge';
import type { Page, PatientListItem } from '../../api/types';
import {
  Alert,
  Badge,
  Button,
  Card,
  Dialog,
  EmptyState,
  ErrorAlert,
  PageHeader,
  QueryView,
  Table,
  TextAreaField,
  TextField,
  type Tone,
} from '../../components/ui';
import { formatDate, formatDateTime, humanize } from '../../format';
import { t, tn } from '../../i18n';

/**
 * Duplicate records. The director finds the same person registered twice at the facility,
 * compares the two records (demographics and record counts only – never clinical content) and
 * merges them. Every merge keeps full lineage and can be undone from the history.
 */

const name = (p: { firstName: string; lastName: string }) => `${p.firstName} ${p.lastName}`;

const scoreTone = (score: number): Tone =>
  score >= 85 ? 'danger' : score >= 70 ? 'warning' : 'info';

function PatientBrief({ p }: { p: DuplicateCandidate['a'] }) {
  return (
    <div>
      <strong>{name(p)}</strong>
      <div className="muted">
        {formatDate(p.dateOfBirth)} · {t('National ID')}{' '}
        <span className="mono">{p.nationalId}</span>
      </div>
      <div className="muted">
        {t('Registered {date}', { date: formatDate(p.createdAt) })}
        {p.hasPortalAccount && (
          <>
            {' · '}
            <Badge tone="info">{t('Portal account')}</Badge>
          </>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ compare & merge */

const FIELDS: { key: ChoosableField; label: string; value: (p: CompareSide) => string | null }[] = [
  { key: 'phone', label: 'Phone', value: (p) => p.phone },
  { key: 'email', label: 'Email', value: (p) => p.email },
  { key: 'address', label: 'Address', value: (p) => p.address },
  { key: 'municipality', label: 'Municipality', value: (p) => p.municipality },
  {
    key: 'emergencyContact',
    label: 'Emergency contact',
    value: (p) =>
      p.emergencyContactName || p.emergencyContactPhone
        ? [p.emergencyContactName, p.emergencyContactPhone].filter(Boolean).join(' · ')
        : null,
  },
  {
    key: 'bloodType',
    label: 'Blood type',
    value: (p) => (p.bloodType && p.bloodType !== 'UNKNOWN' ? p.bloodType : null),
  },
];

function Row({ label, a, b }: { label: string; a: ReactNode; b: ReactNode }) {
  return (
    <tr>
      <th scope="row">{label}</th>
      <td>{a ?? '—'}</td>
      <td>{b ?? '—'}</td>
    </tr>
  );
}

function MergeDialog({
  pair,
  onClose,
  onMerged,
}: {
  pair: { a: string; b: string };
  onClose: () => void;
  onMerged: (message: string) => void;
}) {
  const qc = useQueryClient();
  const compare = useQuery({
    queryKey: ['patient-merges', 'compare', pair.a, pair.b],
    queryFn: () => mergeApi.compare(pair.a, pair.b),
  });
  const [survivorSide, setSurvivorSide] = useState<'a' | 'b' | null>(null);
  const [choices, setChoices] = useState<Partial<Record<ChoosableField, 'survivor' | 'merged'>>>(
    {},
  );
  const [reason, setReason] = useState('');
  const [confirming, setConfirming] = useState(false);
  const groupId = useId();

  const merge = useMutation({
    mutationFn: mergeApi.merge,
    onSuccess: (r, vars) => {
      void qc.invalidateQueries({ queryKey: ['patient-merges'] });
      void qc.invalidateQueries({ queryKey: ['patients'] });
      const moved = Object.entries(r.moved)
        .filter(([k]) => !k.includes(':'))
        .reduce((a, [, n]) => a + n, 0);
      const data = compare.data!;
      const survivor = data.a.id === vars.survivorId ? data.a : data.b;
      onMerged(
        tn(
          moved,
          'Records merged: {count} entry moved to {name}.',
          'Records merged: {count} entries moved to {name}.',
          { name: name(survivor) },
        ),
      );
    },
  });

  return (
    <Dialog open onClose={onClose} title={t('Compare and merge records')} wide>
      <QueryView query={compare}>
        {(data) => {
          // Default survivor: the record with a portal account, otherwise the one with more
          // entries, otherwise the one registered first (later registrations are usually the
          // duplicate).
          const defaultSide: 'a' | 'b' =
            data.a.hasPortalAccount !== data.b.hasPortalAccount
              ? data.a.hasPortalAccount
                ? 'a'
                : 'b'
              : data.a.totalRecords !== data.b.totalRecords
                ? data.b.totalRecords > data.a.totalRecords
                  ? 'b'
                  : 'a'
                : data.b.createdAt < data.a.createdAt
                  ? 'b'
                  : 'a';
          const side = survivorSide ?? defaultSide;
          const survivor = side === 'a' ? data.a : data.b;
          const duplicate = side === 'a' ? data.b : data.a;
          const bothAccounts = data.a.hasPortalAccount && data.b.hasPortalAccount;
          const differing = FIELDS.filter(
            (f) => f.value(duplicate) && f.value(duplicate) !== f.value(survivor),
          );
          const taken = differing.filter((f) => choices[f.key] === 'merged');
          const movedTotal = duplicate.totalRecords;
          const reasonOk = reason.trim().length >= 10;

          if (confirming) {
            return (
              <div className="stack">
                <Alert tone="warning" title={t('Please confirm the merge')}>
                  <ul>
                    <li>
                      {tn(
                        movedTotal,
                        '{count} entry will move from {from} to {to}.',
                        '{count} entries will move from {from} to {to}.',
                        {
                          from: `${name(duplicate)} (${duplicate.nationalId})`,
                          to: name(survivor),
                        },
                      )}
                    </li>
                    <li>
                      {t('The record {nationalId} will be closed and marked as merged.', {
                        nationalId: duplicate.nationalId,
                      })}
                    </li>
                    {taken.length > 0 && (
                      <li>
                        {t('Taken from the duplicate: {fields}.', {
                          fields: taken.map((f) => t(f.label)).join(', '),
                        })}
                      </li>
                    )}
                    {duplicate.hasPortalAccount && (
                      <li>
                        {t('The patient’s portal account will move to the surviving record.')}
                      </li>
                    )}
                    <li>{t('The doctors on the care team are notified.')}</li>
                    <li>{t('You can undo this merge later from the merge history.')}</li>
                  </ul>
                </Alert>
                <ErrorAlert error={merge.error} />
                <div className="form-actions">
                  <Button variant="secondary" onClick={() => setConfirming(false)}>
                    {t('Back')}
                  </Button>
                  <Button
                    variant="danger"
                    loading={merge.isPending}
                    onClick={() =>
                      merge.mutate({
                        survivorId: survivor.id,
                        mergedId: duplicate.id,
                        reason: reason.trim(),
                        fieldChoices: Object.fromEntries(
                          differing.map((f) => [f.key, choices[f.key] ?? 'survivor']),
                        ),
                      })
                    }
                  >
                    {t('Merge records')}
                  </Button>
                </div>
              </div>
            );
          }

          const sections = Object.entries(data.sections).filter(
            ([k]) => (data.a.counts[k] ?? 0) + (data.b.counts[k] ?? 0) > 0,
          );
          const head = (key: 'a' | 'b', p: CompareSide) => (
            <th scope="col">
              <label className="checkbox" style={{ alignItems: 'flex-start' }}>
                <input
                  type="radio"
                  name={`${groupId}-survivor`}
                  checked={side === key}
                  onChange={() => setSurvivorSide(key)}
                  style={{ marginTop: '0.25rem' }}
                />
                <span>
                  {name(p)}
                  <span className="muted" style={{ display: 'block', fontWeight: 400 }}>
                    {side === key ? t('Keep this record') : t('Duplicate – will be closed')}
                  </span>
                </span>
              </label>
            </th>
          );

          return (
            <div className="stack">
              <p className="muted" style={{ margin: 0 }}>
                {t(
                  'Choose the record to keep – normally the one with the correct national ID. Only identity details and the number of entries are shown; clinical content stays with the care team.',
                )}
              </p>
              {bothAccounts && (
                <Alert tone="danger" title={t('Both records have a portal account')}>
                  {t(
                    'Ask the patient which account they use and have the other one deactivated before merging.',
                  )}
                </Alert>
              )}
              <Table caption={t('Comparison of the two records')}>
                <thead>
                  <tr>
                    <th scope="col">
                      <span className="sr-only">{t('Detail')}</span>
                    </th>
                    {head('a', data.a)}
                    {head('b', data.b)}
                  </tr>
                </thead>
                <tbody>
                  <Row
                    label={t('National ID')}
                    a={<span className="mono">{data.a.nationalId}</span>}
                    b={<span className="mono">{data.b.nationalId}</span>}
                  />
                  <Row
                    label={t('Date of birth')}
                    a={formatDate(data.a.dateOfBirth)}
                    b={formatDate(data.b.dateOfBirth)}
                  />
                  <Row label={t('Sex')} a={humanize(data.a.sex)} b={humanize(data.b.sex)} />
                  {FIELDS.map((f) => (
                    <Row key={f.key} label={t(f.label)} a={f.value(data.a)} b={f.value(data.b)} />
                  ))}
                  <Row
                    label={t('Portal account')}
                    a={data.a.hasPortalAccount ? t('Yes') : t('No')}
                    b={data.b.hasPortalAccount ? t('Yes') : t('No')}
                  />
                  <Row
                    label={t('Guardians')}
                    a={data.a.guardians.join(', ') || null}
                    b={data.b.guardians.join(', ') || null}
                  />
                  <Row
                    label={t('Registered')}
                    a={formatDate(data.a.createdAt)}
                    b={formatDate(data.b.createdAt)}
                  />
                  {sections.map(([k, label]) => (
                    <Row
                      key={k}
                      label={t(label)}
                      a={String(data.a.counts[k] ?? 0)}
                      b={String(data.b.counts[k] ?? 0)}
                    />
                  ))}
                  <Row
                    label={t('Entries in total')}
                    a={<strong>{data.a.totalRecords}</strong>}
                    b={<strong>{data.b.totalRecords}</strong>}
                  />
                </tbody>
              </Table>

              {differing.length > 0 && (
                <fieldset>
                  <legend>
                    {t('Details that differ – which value should the kept record have?')}
                  </legend>
                  <div className="stack" style={{ gap: '0.6rem' }}>
                    {differing.map((f) => (
                      <div key={f.key}>
                        <strong>{t(f.label)}</strong>
                        <div className="row" style={{ flexWrap: 'wrap', gap: '1rem' }}>
                          {(['survivor', 'merged'] as const).map((src) => (
                            <label key={src} className="checkbox">
                              <input
                                type="radio"
                                name={`${groupId}-${f.key}`}
                                checked={(choices[f.key] ?? 'survivor') === src}
                                onChange={() => setChoices((c) => ({ ...c, [f.key]: src }))}
                              />
                              <span>
                                {(src === 'survivor' ? f.value(survivor) : f.value(duplicate)) ??
                                  t('(empty)')}
                              </span>
                            </label>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </fieldset>
              )}

              <TextAreaField
                label={t('Reason for the merge')}
                required
                minLength={10}
                maxLength={500}
                rows={3}
                value={reason}
                onChange={(e) => setReason(e.currentTarget.value)}
                hint={t(
                  'For the audit trail, e.g. “Same person – surname misspelt at walk-in registration, confirmed with ID card”.',
                )}
              />
              <div className="form-actions">
                <Button variant="secondary" onClick={onClose}>
                  {t('Cancel')}
                </Button>
                <Button disabled={bothAccounts || !reasonOk} onClick={() => setConfirming(true)}>
                  {t('Review merge')}
                </Button>
              </div>
            </div>
          );
        }}
      </QueryView>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ manual compare */

function PatientPicker({
  label,
  value,
  onChange,
}: {
  label: string;
  value: PatientListItem | null;
  onChange: (p: PatientListItem | null) => void;
}) {
  const [search, setSearch] = useState('');
  const q = search.trim();
  const results = useQuery({
    queryKey: ['patients', 'merge-picker', q],
    queryFn: () =>
      api<Page<PatientListItem>>('/patients', {
        query: { scope: 'facility', search: q, pageSize: 8 },
      }),
    enabled: q.length >= 2,
  });
  if (value) {
    return (
      <div className="stack" style={{ gap: '0.35rem' }}>
        <span className="muted">{label}</span>
        <div className="row-between">
          <span>
            <strong>{name(value)}</strong>{' '}
            <span className="muted">
              {formatDate(value.dateOfBirth)} · <span className="mono">{value.nationalId}</span>
            </span>
          </span>
          <Button size="sm" variant="secondary" onClick={() => onChange(null)}>
            {t('Change')}
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div className="stack" style={{ gap: '0.35rem' }}>
      <TextField
        label={label}
        type="search"
        value={search}
        onChange={(e) => setSearch(e.currentTarget.value)}
        placeholder={t('Name or national ID')}
      />
      {q.length >= 2 && (
        <QueryView query={results}>
          {(page) =>
            page.items.length === 0 ? (
              <p className="muted" style={{ margin: 0 }}>
                {t('No patients found')}
              </p>
            ) : (
              <ul className="list">
                {page.items.map((p) => (
                  <li key={p.id} className="row-between">
                    <span>
                      {name(p)}{' '}
                      <span className="muted">
                        {formatDate(p.dateOfBirth)} · <span className="mono">{p.nationalId}</span>
                      </span>
                    </span>
                    <Button size="sm" variant="secondary" onClick={() => onChange(p)}>
                      {t('Select')}
                    </Button>
                  </li>
                ))}
              </ul>
            )
          }
        </QueryView>
      )}
    </div>
  );
}

function ManualCompare({ onCompare }: { onCompare: (a: string, b: string) => void }) {
  const [a, setA] = useState<PatientListItem | null>(null);
  const [b, setB] = useState<PatientListItem | null>(null);
  return (
    <Card title={t('Compare any two records')}>
      <p className="muted">
        {t('Not in the list above? Search for both records registered at your facility.')}
      </p>
      <div className="form-grid">
        <PatientPicker label={t('First record')} value={a} onChange={setA} />
        <PatientPicker label={t('Second record')} value={b} onChange={setB} />
      </div>
      {a && b && a.id === b.id && (
        <Alert tone="warning" title={t('Choose two different records')} />
      )}
      <div className="form-actions">
        <Button disabled={!a || !b || a.id === b.id} onClick={() => onCompare(a!.id, b!.id)}>
          {t('Compare')}
        </Button>
      </div>
    </Card>
  );
}

/* ------------------------------------------------------------------ history */

function UnmergeDialog({ item, onClose }: { item: MergeHistoryItem; onClose: () => void }) {
  const qc = useQueryClient();
  const [reason, setReason] = useState('');
  const mutation = useMutation({
    mutationFn: () => mergeApi.unmerge(item.id, reason.trim()),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['patient-merges'] });
      void qc.invalidateQueries({ queryKey: ['patients'] });
      onClose();
    },
  });
  return (
    <Dialog open onClose={onClose} title={t('Undo merge')}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          mutation.mutate();
        }}
      >
        <p style={{ margin: 0 }}>
          {t(
            'The {count} entries that were moved go back to {name} ({nationalId}) and that record is reopened. Entries added since the merge stay with {survivor}.',
            {
              count: item.movedCount,
              name: name(item.merged),
              nationalId: item.merged.nationalId,
              survivor: name(item.survivor),
            },
          )}
        </p>
        <TextAreaField
          label={t('Reason for undoing the merge')}
          required
          minLength={10}
          maxLength={500}
          rows={3}
          value={reason}
          onChange={(e) => setReason(e.currentTarget.value)}
        />
        <ErrorAlert error={mutation.error} />
        <div className="form-actions">
          <Button variant="secondary" onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button
            type="submit"
            variant="danger"
            disabled={reason.trim().length < 10}
            loading={mutation.isPending}
          >
            {t('Undo merge')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function History() {
  const q = useQuery({ queryKey: ['patient-merges', 'history'], queryFn: mergeApi.history });
  const [undo, setUndo] = useState<MergeHistoryItem | null>(null);
  return (
    <Card title={t('Merge history')}>
      <QueryView query={q}>
        {({ items }) =>
          items.length === 0 ? (
            <EmptyState title={t('No merges yet')} />
          ) : (
            <Table caption={t('Merge history')}>
              <thead>
                <tr>
                  <th>{t('Kept record')}</th>
                  <th>{t('Merged duplicate')}</th>
                  <th>{t('Reason')}</th>
                  <th>{t('When')}</th>
                  <th>
                    <span className="sr-only">{t('Actions')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((m) => (
                  <tr key={m.id}>
                    <td>
                      <strong>{name(m.survivor)}</strong>
                      <div className="muted mono">{m.survivor.nationalId}</div>
                    </td>
                    <td>
                      {name(m.merged)}
                      <div className="muted mono">{m.merged.nationalId}</div>
                      <div className="muted">
                        {tn(m.movedCount, '{count} entry moved', '{count} entries moved')}
                        {m.accountMoved ? ` · ${t('portal account moved')}` : ''}
                      </div>
                    </td>
                    <td>{m.reason}</td>
                    <td>
                      {formatDateTime(m.mergedAt)}
                      <div className="muted">{m.mergedBy}</div>
                      {m.unmergedAt && (
                        <div style={{ marginTop: '0.35rem' }}>
                          <Badge tone="neutral">
                            {t('Undone {date}', { date: formatDateTime(m.unmergedAt) })}
                          </Badge>
                          <div className="muted">
                            {m.unmergedBy}
                            {m.unmergeReason ? ` – ${m.unmergeReason}` : ''}
                          </div>
                        </div>
                      )}
                    </td>
                    <td>
                      {!m.unmergedAt && (
                        <Button size="sm" variant="secondary" onClick={() => setUndo(m)}>
                          {t('Undo merge')}
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )
        }
      </QueryView>
      {undo && <UnmergeDialog item={undo} onClose={() => setUndo(null)} />}
    </Card>
  );
}

/* ------------------------------------------------------------------ page */

export function DirectorDuplicates() {
  const candidates = useQuery({
    queryKey: ['patient-merges', 'candidates'],
    queryFn: mergeApi.candidates,
  });
  const [pair, setPair] = useState<{ a: string; b: string } | null>(null);
  const [done, setDone] = useState<string | null>(null);

  return (
    <div className="stack">
      <PageHeader
        title={t('Duplicate records')}
        subtitle={t(
          'Find people registered more than once at your facility and merge their records into one.',
        )}
      />
      {done && (
        <Alert tone="success" title={done}>
          {t('The merge is listed in the history below, where it can be undone if needed.')}
        </Alert>
      )}
      <Card title={t('Possible duplicates')}>
        <p className="muted">
          {t(
            'Records with the same date of birth and a matching or very similar name, phone or email. Nothing is merged automatically – always check identity documents first.',
          )}
        </p>
        <QueryView query={candidates}>
          {({ items }) =>
            items.length === 0 ? (
              <EmptyState title={t('No likely duplicates found')}>
                {t('You can still compare any two records below.')}
              </EmptyState>
            ) : (
              <Table caption={t('Possible duplicates')}>
                <thead>
                  <tr>
                    <th>{t('First record')}</th>
                    <th>{t('Possible duplicate')}</th>
                    <th>{t('Why')}</th>
                    <th>
                      <span className="sr-only">{t('Actions')}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((c) => (
                    <tr key={`${c.a.id}-${c.b.id}`}>
                      <td>
                        <PatientBrief p={c.a} />
                      </td>
                      <td>
                        <PatientBrief p={c.b} />
                      </td>
                      <td>
                        <Badge tone={scoreTone(c.score)}>
                          {t('{score}% match', { score: c.score })}
                        </Badge>
                        <ul style={{ margin: '0.35rem 0 0', paddingLeft: '1.1rem' }}>
                          {c.reasons.map((r) => (
                            <li key={r}>{t(r)}</li>
                          ))}
                        </ul>
                      </td>
                      <td>
                        <Button
                          size="sm"
                          onClick={() => {
                            setDone(null);
                            setPair({ a: c.a.id, b: c.b.id });
                          }}
                        >
                          {t('Compare')}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )
          }
        </QueryView>
      </Card>
      <ManualCompare
        onCompare={(a, b) => {
          setDone(null);
          setPair({ a, b });
        }}
      />
      <History />
      {pair && (
        <MergeDialog
          key={`${pair.a}-${pair.b}`}
          pair={pair}
          onClose={() => setPair(null)}
          onMerged={(message) => {
            setPair(null);
            setDone(message);
          }}
        />
      )}
    </div>
  );
}
