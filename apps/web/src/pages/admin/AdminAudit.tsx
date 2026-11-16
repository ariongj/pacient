import { useState } from 'react';
import { useAdminAudit, type AuditItem } from '../../api/platform';
import { EmptyState, PageHeader, Pagination, QueryView, Table, Tabs } from '../../components/ui';
import { actionLabel, formatDateTime, humanize } from '../../format';
import { t } from '../../i18n';
import { auditTarget } from './platform/labels';

type Category = 'all' | 'users' | 'billing' | 'platform';

/** Common metadata keys in plain words; anything else keeps its technical name. */
const DETAIL_LABELS: Record<string, () => string> = {
  reason: () => t('Reason'),
  note: () => t('Note'),
  fields: () => t('Changed'),
  change: () => t('Change'),
  version: () => t('Version'),
  locale: () => t('Language'),
  role: () => t('Role'),
  from: () => t('From'),
  to: () => t('To'),
};

function details(meta: AuditItem['metadata']) {
  if (!meta) return null;
  const parts = Object.entries(meta)
    .filter(
      ([, v]) =>
        Array.isArray(v) || (v !== null && v !== undefined && v !== '' && typeof v !== 'object'),
    )
    .slice(0, 4)
    .map(([k, v]) => {
      const value = Array.isArray(v) ? v.join(', ') : String(v);
      const label = DETAIL_LABELS[k]?.() ?? k;
      return `${label}: ${value.length > 120 ? `${value.slice(0, 117)}…` : value}`;
    });
  return parts.length ? parts.join(' · ') : null;
}

/**
 * Every administrative action – on accounts (also by directors and the Ministry), subscriptions
 * and invoices, operator settings and legal texts – with who did it, when and to what.
 */
export function AdminAudit() {
  const [category, setCategory] = useState<Category>('all');
  const [page, setPage] = useState(1);
  const audit = useAdminAudit(category, page);
  return (
    <>
      <PageHeader
        title={t('Administrative audit')}
        subtitle={t('Every administrative action on accounts, subscriptions and settings.')}
      />
      <Tabs<Category>
        label={t('Kind of action')}
        withPanels={false}
        active={category}
        onChange={(c) => {
          setCategory(c);
          setPage(1);
        }}
        tabs={[
          { id: 'all', label: t('All') },
          { id: 'users', label: t('Accounts') },
          { id: 'billing', label: t('Subscriptions and invoices') },
          { id: 'platform', label: t('Settings and legal texts') },
        ]}
      />
      <QueryView query={audit}>
        {(r) =>
          r.items.length === 0 ? (
            <EmptyState title={t('No administrative actions yet')} />
          ) : (
            <>
              <Table caption={t('Administrative audit')}>
                <thead>
                  <tr>
                    <th scope="col">{t('Time')}</th>
                    <th scope="col">{t('Who')}</th>
                    <th scope="col">{t('Action')}</th>
                    <th scope="col">{t('About')}</th>
                    <th scope="col">{t('Details')}</th>
                  </tr>
                </thead>
                <tbody>
                  {r.items.map((a) => (
                    <tr key={a.id}>
                      <td>{formatDateTime(a.occurredAt)}</td>
                      <td>
                        {a.actorName ?? t('Automatic')}
                        {a.actorRole && <div className="muted">{humanize(a.actorRole)}</div>}
                      </td>
                      <td>{actionLabel(a.action)}</td>
                      <td>{auditTarget(a) ?? '—'}</td>
                      <td className="muted">{details(a.metadata) ?? '—'}</td>
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
  );
}
