import { useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  kindLabel,
  statusLabel,
  statusTone,
  TICKET_KINDS,
  useColleagues,
  useOpenTicket,
  useSupportMe,
  useSupportStats,
  useTicket,
  useTicketAction,
  useTickets,
  type SupportMe,
  type Ticket,
  type TicketAction,
  type TicketFilter,
  type TicketKind,
} from '../../api/support';
import { useUser } from '../../auth/AuthContext';
import {
  Alert,
  Badge,
  Button,
  Card,
  DefinitionList,
  Dialog,
  EmptyState,
  ErrorAlert,
  Grid,
  Loading,
  PageHeader,
  Pagination,
  QueryView,
  SelectField,
  Stat,
  Table,
  Tabs,
  TextAreaField,
  formValues,
} from '../../components/ui';
import { formatDateTime, formatNumber, humanize } from '../../format';
import { t } from '../../i18n';

/**
 * IT support: every staff member can ask for help with an account or a device; IT support works
 * the facility's requests; the director approves two-step sign-in resets and access changes; the
 * Ministry sees counts per facility.
 */
export function SupportPage() {
  const me = useSupportMe();
  const [params, setParams] = useSearchParams();
  const openId = params.get('ticket');
  const close = () => {
    params.delete('ticket');
    setParams(params, { replace: true });
  };
  return (
    <>
      <PageHeader
        title={t('IT support')}
        subtitle={t(
          'Help with accounts, sign-in and devices. IT support never sees patient data and never changes roles – the director does that.',
        )}
      />
      <QueryView query={me}>
        {(m) => (
          <div className="stack">
            {m.national ? (
              <NationalStats />
            ) : (
              <>
                {(m.desk || m.approves) && <DeskList me={m} />}
                {m.canRequest && <MyRequests />}
              </>
            )}
            <Dialog open={Boolean(openId)} onClose={close} title={t('Support request')} wide>
              {openId && <TicketDetail id={openId} me={m} />}
            </Dialog>
          </div>
        )}
      </QueryView>
    </>
  );
}

function StatusBadge({ ticket }: { ticket: Ticket }) {
  return <Badge tone={statusTone(ticket.status)}>{statusLabel(ticket.status)}</Badge>;
}

function useOpenDetail() {
  const [params, setParams] = useSearchParams();
  return (id: string) => {
    params.set('ticket', id);
    setParams(params);
  };
}

function TicketTable({
  items,
  caption,
  desk,
}: {
  items: Ticket[];
  caption: string;
  desk: boolean;
}) {
  const open = useOpenDetail();
  return (
    <Table caption={caption}>
      <thead>
        <tr>
          <th scope="col">{t('Request')}</th>
          <th scope="col">{t('Status')}</th>
          {desk && <th scope="col">{t('Account')}</th>}
          <th scope="col">{t('Opened')}</th>
          <th scope="col">
            <span className="sr-only">{t('Actions')}</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {items.map((i) => (
          <tr key={i.id}>
            <td>
              <strong>{kindLabel(i.kind)}</strong>
              <div className="muted">
                <code>{i.reference}</code>
              </div>
            </td>
            <td>
              <StatusBadge ticket={i} />
              {i.assigneeName && <div className="muted">{i.assigneeName}</div>}
            </td>
            {desk && (
              <td>
                {i.subject ? (
                  <>
                    {i.subject.fullName}
                    <div className="muted">
                      {humanize(i.subject.role)}
                      {i.subject.locked ? ` · ${t('Locked')}` : ''}
                    </div>
                  </>
                ) : (
                  '—'
                )}
              </td>
            )}
            <td>
              {formatDateTime(i.createdAt)}
              {i.requesterName && <div className="muted">{i.requesterName}</div>}
            </td>
            <td>
              <Button size="sm" variant="secondary" onClick={() => open(i.id)}>
                {t('Open|view')}
                <span className="sr-only">: {i.reference}</span>
              </Button>
            </td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

function DeskList({ me }: { me: SupportMe }) {
  const [filter, setFilter] = useState<TicketFilter>(me.approves && !me.desk ? 'approval' : 'open');
  const [page, setPage] = useState(1);
  const list = useTickets(filter, page);
  return (
    <Card title={me.desk ? t('Support desk') : t('IT support requests of the facility')}>
      <Tabs
        label={t('Support requests')}
        withPanels={false}
        active={filter}
        onChange={(f) => {
          setFilter(f);
          setPage(1);
        }}
        tabs={[
          { id: 'open', label: t('Open|requests') },
          { id: 'approval', label: t('Waiting for the director') },
          { id: 'closed', label: t('Closed') },
          { id: 'all', label: t('All') },
        ]}
      />
      <QueryView query={list}>
        {(d) =>
          d.items.length === 0 ? (
            <EmptyState title={t('No requests here')} />
          ) : (
            <>
              <TicketTable items={d.items} caption={t('Support requests')} desk />
              <Pagination page={d.page} totalPages={d.totalPages} onChange={setPage} />
            </>
          )
        }
      </QueryView>
    </Card>
  );
}

function MyRequests() {
  const user = useUser();
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const list = useTickets('all', page, user.role !== 'IT_SUPPORT' && user.role !== 'DIRECTOR');
  const mine = user.role === 'IT_SUPPORT' || user.role === 'DIRECTOR';
  return (
    <Card
      title={t('My requests')}
      actions={<Button onClick={() => setCreating(true)}>{t('Ask IT support')}</Button>}
    >
      {mine ? (
        <p className="muted">{t('Your own requests appear in the list above.')}</p>
      ) : (
        <QueryView query={list}>
          {(d) =>
            d.items.length === 0 ? (
              <EmptyState title={t('You have not asked IT support for anything yet')} />
            ) : (
              <>
                <TicketTable items={d.items} caption={t('My requests')} desk={false} />
                <Pagination page={d.page} totalPages={d.totalPages} onChange={setPage} />
              </>
            )
          }
        </QueryView>
      )}
      <Dialog open={creating} onClose={() => setCreating(false)} title={t('Ask IT support')}>
        {creating && <NewTicketForm onDone={() => setCreating(false)} />}
      </Dialog>
    </Card>
  );
}

function NewTicketForm({ onDone }: { onDone: () => void }) {
  const user = useUser();
  const colleagues = useColleagues();
  const create = useOpenTicket();
  const [kind, setKind] = useState<TicketKind>('ACCOUNT_LOCKED');
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const v = formValues(e.currentTarget);
    create.mutate(
      {
        kind,
        description: v.description ?? '',
        subjectUserId: v.subjectUserId && v.subjectUserId !== user.id ? v.subjectUserId : undefined,
      },
      { onSuccess: onDone },
    );
  }
  return (
    <form className="stack" onSubmit={submit}>
      <SelectField
        label={t('What do you need?')}
        name="kind"
        required
        value={kind}
        onChange={(e) => setKind(e.target.value as TicketKind)}
        options={TICKET_KINDS.map((k) => ({ value: k, label: kindLabel(k) }))}
      />
      <SelectField
        label={t('Whose account?')}
        name="subjectUserId"
        defaultValue={user.id}
        options={[
          { value: user.id, label: t('My own account') },
          ...(colleagues.data ?? [])
            .filter((c) => c.id !== user.id)
            .map((c) => ({ value: c.id, label: `${c.fullName} (${humanize(c.role)})` })),
        ]}
      />
      <TextAreaField
        label={t('Describe the problem')}
        name="description"
        required
        minLength={5}
        maxLength={2000}
        hint={t('Never write patient names or health information here.')}
      />
      {(kind === 'MFA_RESET' || kind === 'ACCESS_CHANGE') && (
        <Alert tone="info">
          {t(
            'This needs the director’s approval before IT support can act. Be ready to confirm who you are.',
          )}
        </Alert>
      )}
      {create.error ? <ErrorAlert error={create.error} /> : null}
      <div className="form-actions">
        <Button type="submit" loading={create.isPending}>
          {t('Send the request')}
        </Button>
      </div>
    </form>
  );
}

function TicketDetail({ id, me }: { id: string; me: SupportMe }) {
  const ticket = useTicket(id);
  const action = useTicketAction();
  const [closing, setClosing] = useState<'resolve' | 'reject' | 'reject-approval' | null>(null);
  const [done, setDone] = useState<string | null>(null);
  if (ticket.isPending) return <Loading />;
  if (ticket.error) return <ErrorAlert error={ticket.error} />;
  const tk = ticket.data!;
  const open = ['OPEN', 'IN_PROGRESS', 'AWAITING_APPROVAL'].includes(tk.status);
  const run = (a: TicketAction, message: string, body?: Record<string, unknown>) =>
    action.mutate(
      { id: tk.id, action: a, body },
      {
        onSuccess: () => {
          setDone(message);
          setClosing(null);
        },
      },
    );
  const s = tk.subject;
  return (
    <div className="stack">
      <DefinitionList
        items={[
          [t('Reference|ticket'), <code key="r">{tk.reference}</code>],
          [t('Request'), kindLabel(tk.kind)],
          [t('Status'), <StatusBadge key="s" ticket={tk} />],
          [t('Opened'), `${formatDateTime(tk.createdAt)} · ${tk.requesterName ?? '—'}`],
          [t('Description'), tk.description],
          ...(tk.assigneeName ? [[t('Handled by'), tk.assigneeName] as [string, string]] : []),
          ...(tk.approvedAt
            ? [
                [t('Approved'), `${formatDateTime(tk.approvedAt)} · ${tk.approverName ?? '—'}`] as [
                  string,
                  string,
                ],
              ]
            : []),
          ...(tk.resolution ? [[t('Outcome'), tk.resolution] as [string, string]] : []),
        ]}
      />
      {s && (
        <Card title={t('Account')}>
          <DefinitionList
            items={[
              [t('Name'), s.fullName],
              [t('Role'), humanize(s.role)],
              ...(s.email !== undefined
                ? ([
                    [t('Email'), s.email],
                    [t('Signed in last'), s.lastLoginAt ? formatDateTime(s.lastLoginAt) : '—'],
                    [
                      t('State'),
                      [
                        s.isActive ? t('Active|account') : t('Deactivated'),
                        s.activated ? null : t('Not activated yet'),
                        s.locked
                          ? t('Locked until {time}', { time: formatDateTime(s.lockedUntil!) })
                          : null,
                        t('Failed sign-ins: {n}', { n: s.failedLoginAttempts ?? 0 }),
                        s.twoStepEnabled
                          ? t('Two-step sign-in on|account')
                          : t('Two-step sign-in off|account'),
                      ]
                        .filter(Boolean)
                        .join(' · '),
                    ],
                  ] as [string, string][])
                : []),
            ]}
          />
        </Card>
      )}
      {done && <Alert tone="success">{done}</Alert>}
      {action.error ? <ErrorAlert error={action.error} /> : null}

      {me.desk && open && (
        <div className="form-actions" style={{ justifyContent: 'flex-start' }}>
          {!tk.assignedToMe && (
            <Button variant="secondary" onClick={() => run('assign', t('You took the request'))}>
              {t('Take it')}
            </Button>
          )}
          {s?.locked && (
            <Button onClick={() => run('unlock', t('The account was unlocked'))}>
              {t('Unlock the account')}
            </Button>
          )}
          {s && (tk.kind === 'PASSWORD_RESET' || tk.kind === 'ACCOUNT_LOCKED') && (
            <Button
              variant="secondary"
              onClick={() =>
                run('password-reset', t('A reset link was sent to the account’s own e-mail'))
              }
            >
              {t('Send a password-reset link')}
            </Button>
          )}
          {tk.needsApproval && !tk.approvedAt && tk.status !== 'AWAITING_APPROVAL' && (
            <Button
              onClick={() => run('request-approval', t('The directors were asked to approve'))}
            >
              {t('Ask the director to approve')}
            </Button>
          )}
          {tk.kind === 'MFA_RESET' && tk.approvedAt && s?.twoStepEnabled && (
            <Button
              variant="danger"
              onClick={() =>
                run(
                  'mfa-reset',
                  t('Two-step sign-in was reset; the person sets it up again at the next sign-in'),
                )
              }
            >
              {t('Reset two-step sign-in')}
            </Button>
          )}
          {tk.status !== 'AWAITING_APPROVAL' && (
            <Button variant="secondary" onClick={() => setClosing('resolve')}>
              {t('Resolve')}
            </Button>
          )}
          <Button variant="ghost" onClick={() => setClosing('reject')}>
            {t('Close without a change')}
          </Button>
        </div>
      )}
      {me.desk && tk.kind === 'ACCESS_CHANGE' && open && (
        <p className="muted">
          {t(
            'The director makes access changes on the staff page; resolve the request afterwards.',
          )}
        </p>
      )}

      {me.approves && tk.status === 'AWAITING_APPROVAL' && (
        <div className="form-actions" style={{ justifyContent: 'flex-start' }}>
          <Button onClick={() => run('approve', t('Approved – IT support can go ahead'))}>
            {t('Approve')}
          </Button>
          <Button variant="secondary" onClick={() => setClosing('reject-approval')}>
            {t('Decline')}
          </Button>
        </div>
      )}

      {closing && (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            const text = formValues(e.currentTarget).text ?? '';
            if (closing === 'reject-approval') {
              run('reject-approval', t('Declined'), { note: text });
            } else {
              run(closing, closing === 'resolve' ? t('Request resolved') : t('Request closed'), {
                resolution: text,
              });
            }
          }}
        >
          <TextAreaField
            label={closing === 'reject-approval' ? t('Reason') : t('What was done')}
            name="text"
            required
            minLength={3}
            maxLength={2000}
            hint={t('The person who asked is told the request was closed, not this text.')}
          />
          <div className="form-actions">
            <Button variant="ghost" onClick={() => setClosing(null)}>
              {t('Cancel')}
            </Button>
            <Button type="submit" loading={action.isPending}>
              {t('Save')}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}

function NationalStats() {
  const stats = useSupportStats();
  return (
    <Card title={t('IT support requests by facility')}>
      <QueryView query={stats}>
        {(s) => (
          <div className="stack">
            <Grid>
              {s.byKind.map((k) => (
                <Stat
                  key={k.kind}
                  label={kindLabel(k.kind)}
                  value={formatNumber(k.count)}
                  hint={t('Last 30 days')}
                />
              ))}
            </Grid>
            {s.facilities.length === 0 ? (
              <EmptyState title={t('No requests yet')} />
            ) : (
              <Table caption={t('IT support requests by facility')}>
                <thead>
                  <tr>
                    <th scope="col">{t('Facility')}</th>
                    <th scope="col" className="num">
                      {t('Open|requests')}
                    </th>
                    <th scope="col" className="num">
                      {t('Waiting for the director')}
                    </th>
                    <th scope="col" className="num">
                      {t('Resolved (30 days)')}
                    </th>
                    <th scope="col" className="num">
                      {t('Median hours to resolve')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {s.facilities.map((f) => (
                    <tr key={f.facilityId}>
                      <th scope="row">{f.facilityName}</th>
                      <td className="num">{formatNumber(f.open)}</td>
                      <td className="num">{formatNumber(f.awaitingApproval)}</td>
                      <td className="num">{formatNumber(f.resolved30d)}</td>
                      <td className="num">
                        {f.medianHours === null ? '—' : String(f.medianHours).replace('.', ',')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
            <p className="muted">
              {t('Counts only – the content of requests stays at the facility.')}
            </p>
          </div>
        )}
      </QueryView>
    </Card>
  );
}
