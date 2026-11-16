import { useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  accountBadges,
  ACCOUNT_STATUSES,
  ALL_ROLES,
  roleLabel,
  statusLabel,
  useAccounts,
  useFacilityOptions,
  type AccountFilters,
  type AccountStatus,
} from '../../api/adminUsers';
import type { Role } from '../../api/types';
import {
  Badge,
  Button,
  Card,
  Dialog,
  EmptyState,
  PageHeader,
  Pagination,
  QueryView,
  SelectField,
  Table,
  TextField,
} from '../../components/ui';
import { formatDateTime } from '../../format';
import { t, tn } from '../../i18n';
import { InviteForm } from './users/InviteForm';

const COUNT_KEY: Record<AccountStatus, 'active' | 'disabled' | 'locked' | 'pending' | 'noMfa'> = {
  active: 'active',
  disabled: 'disabled',
  locked: 'locked',
  pending: 'pending',
  no_mfa: 'noMfa',
};

/**
 * Every account of the service – staff, Ministry, administrators and patients – for the platform
 * administrator: search, filter by role, facility and state, and invite new accounts. The filters
 * live in the address, so a filtered list can be bookmarked and the back button returns to it.
 */
export function AdminUsers() {
  const [params, setParams] = useSearchParams();
  const filters: AccountFilters = {
    q: params.get('q') ?? '',
    role: (params.get('role') ?? '') as Role | '',
    facilityId: params.get('facility') ?? '',
    status: (params.get('status') ?? '') as AccountStatus | '',
    page: Math.max(1, Number(params.get('page')) || 1),
  };
  const list = useAccounts(filters);
  const facilities = useFacilityOptions();
  const [inviting, setInviting] = useState(false);

  const set = (patch: Record<string, string>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    if (!('page' in patch)) next.delete('page');
    setParams(next, { replace: true });
  };

  function onSearch(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    set({ q: String(new FormData(e.currentTarget).get('q') ?? '').trim() });
  }

  const counts = list.data?.counts;
  return (
    <>
      <PageHeader
        title={t('Users')}
        subtitle={t('Every account of the service: invite, disable, unlock, reset sign-in.')}
        actions={<Button onClick={() => setInviting(true)}>{t('Invite user')}</Button>}
      />
      <Card>
        <form role="search" onSubmit={onSearch}>
          {/* The row is a div: a form itself keeps the column layout of every form. */}
          <div className="search-bar">
            <TextField
              key={filters.q}
              label={t('Search name or email')}
              name="q"
              type="search"
              defaultValue={filters.q}
              maxLength={100}
            />
            <SelectField
              label={t('Role')}
              value={filters.role}
              onChange={(e) => set({ role: e.target.value })}
              placeholder={t('All roles')}
              options={ALL_ROLES.map((r) => ({ value: r, label: roleLabel(r) }))}
            />
            <SelectField
              label={t('Facility')}
              value={filters.facilityId}
              onChange={(e) => set({ facility: e.target.value })}
              placeholder={t('All facilities')}
              options={(facilities.data ?? []).map((f) => ({ value: f.id, label: f.name }))}
            />
            <Button type="submit" variant="secondary">
              {t('Search')}
            </Button>
          </div>
        </form>
        <div className="area-tabs" role="group" aria-label={t('State of the account')}>
          <button
            type="button"
            className={`area-tab ${filters.status ? '' : 'area-tab-active'}`}
            aria-pressed={!filters.status}
            onClick={() => set({ status: '' })}
          >
            {t('All accounts')}
          </button>
          {ACCOUNT_STATUSES.map((s) => (
            <button
              key={s}
              type="button"
              className={`area-tab ${filters.status === s ? 'area-tab-active' : ''}`}
              aria-pressed={filters.status === s}
              onClick={() => set({ status: filters.status === s ? '' : s })}
            >
              {statusLabel(s)}
              {counts ? ` (${counts[COUNT_KEY[s]]})` : ''}
            </button>
          ))}
        </div>
        <QueryView query={list}>
          {(data) =>
            data.items.length === 0 ? (
              <EmptyState title={t('No accounts found')}>
                {t('Change the search or the filters, or invite a new user.')}
              </EmptyState>
            ) : (
              <>
                <p className="muted" role="status">
                  {tn(data.total, '{count} account', '{count} accounts')}
                </p>
                <Table caption={t('Accounts')}>
                  <thead>
                    <tr>
                      <th scope="col">{t('Name')}</th>
                      <th scope="col">{t('Role')}</th>
                      <th scope="col">{t('Facility')}</th>
                      <th scope="col">{t('State')}</th>
                      <th scope="col">{t('Last sign-in')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.items.map((u) => (
                      <tr key={u.id}>
                        <td>
                          <Link to={`/admin/users/${u.id}`}>{u.fullName}</Link>
                          <div className="muted">{u.email}</div>
                        </td>
                        <td>{roleLabel(u.role)}</td>
                        <td>{u.facilityName ?? '—'}</td>
                        <td>
                          <span className="row" style={{ gap: '0.35rem', flexWrap: 'wrap' }}>
                            {accountBadges(u).map((b) => (
                              <Badge key={b.label} tone={b.tone}>
                                {b.label}
                              </Badge>
                            ))}
                          </span>
                        </td>
                        <td>{u.lastLoginAt ? formatDateTime(u.lastLoginAt) : t('Never')}</td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
                <Pagination
                  page={data.page}
                  totalPages={data.totalPages}
                  onChange={(p) => set({ page: String(p) })}
                />
              </>
            )
          }
        </QueryView>
      </Card>
      <Dialog open={inviting} onClose={() => setInviting(false)} title={t('Invite user')} wide>
        {inviting && <InviteForm onClose={() => setInviting(false)} />}
      </Dialog>
    </>
  );
}
