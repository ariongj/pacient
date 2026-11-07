import { useState, type FormEvent } from 'react';
import {
  decisionLabel,
  decisionShort,
  kindExplanation,
  kindLabel,
  organLabel,
  PATIENT_REVOCABLE_KINDS,
  summaryText,
  useMyWishes,
  useNameProxy,
  useRecordMyDonation,
  useWithdrawMine,
  type Directive,
  type MyWishes,
} from '../../api/directives';
import { useAuth } from '../../auth/AuthContext';
import {
  Alert,
  Badge,
  Button,
  Card,
  DefinitionList,
  Dialog,
  EmptyState,
  ErrorAlert,
  PageHeader,
  QueryView,
  TextAreaField,
  TextField,
} from '../../components/ui';
import { formatDate, formatDateTime } from '../../format';
import { t } from '../../i18n';
import { DonationForm, ReasonDialog } from './DonationForm';

/** The person's organ donation decision, healthcare proxy and decisions about their care. */
export function PortalWishesPage() {
  const { acting } = useAuth();
  const wishes = useMyWishes(acting?.patientId ?? null);
  const [withdrawing, setWithdrawing] = useState<Directive | null>(null);
  const withdraw = useWithdrawMine();

  return (
    <>
      <PageHeader
        title={
          acting
            ? t('Decisions about care – {name}', { name: acting.firstName })
            : t('Organ donation and my wishes')
        }
        subtitle={t(
          'Your organ donation decision, the person you want consulted if you cannot decide yourself, and decisions your care team has recorded with you.',
        )}
      />
      <QueryView query={wishes}>
        {(w) => (
          <>
            {!w.acting && <DonationCard wishes={w} />}
            {!w.acting && (
              <ProxyCard
                proxy={w.directives.find(
                  (d) => d.kind === 'HEALTHCARE_PROXY' && d.status === 'ACTIVE',
                )}
                onWithdraw={setWithdrawing}
              />
            )}
            {w.acting && (
              <Alert tone="info">
                {t(
                  'Organ donation decisions and healthcare proxies are personal: only adults can register them for themselves.',
                )}
              </Alert>
            )}
            <CareDecisionsCard
              items={w.directives.filter(
                (d) => d.status === 'ACTIVE' && (w.acting || d.kind !== 'HEALTHCARE_PROXY'),
              )}
              canWithdraw={!w.acting}
              onWithdraw={setWithdrawing}
            />
          </>
        )}
      </QueryView>
      <ReasonDialog
        open={withdrawing !== null}
        title={t('Withdraw')}
        intro={withdrawing ? kindLabel(withdrawing.kind) : undefined}
        submitLabel={t('Withdraw')}
        submitting={withdraw.isPending}
        error={withdraw.error}
        onClose={() => {
          setWithdrawing(null);
          withdraw.reset();
        }}
        onSubmit={(reason) =>
          withdrawing &&
          withdraw.mutate({ id: withdrawing.id, reason }, { onSuccess: () => setWithdrawing(null) })
        }
      />
    </>
  );
}

function DonationCard({ wishes }: { wishes: MyWishes }) {
  const { donation } = wishes;
  const record = useRecordMyDonation();
  const [editing, setEditing] = useState(false);
  const current = donation.current;
  return (
    <Card
      title={t('Organ donation')}
      actions={
        donation.eligible ? (
          <Button size="sm" onClick={() => setEditing(true)}>
            {current ? t('Change my decision') : t('Register my decision')}
          </Button>
        ) : undefined
      }
    >
      <p className="muted">
        {t(
          'Your decision is kept in the national organ donation register. Doctors do not see it in your record: they check it only around the end of life or for transplant coordination, and every check appears under “Who viewed my record”. You can change your decision at any time.',
        )}
      </p>
      {!donation.eligible && donation.reason === 'MINOR' && (
        <Alert tone="info">{t('You can register your decision from the age of 18.')}</Alert>
      )}
      {current ? (
        <DefinitionList
          items={[
            [t('My decision'), <strong key="d">{decisionLabel(current.decision)}</strong>],
            ...(current.organs?.length
              ? ([[t('Organs and tissue'), current.organs.map(organLabel).join(', ')]] as [
                  string,
                  string,
                ][])
              : []),
            [
              t('Family informed'),
              current.familyInformed === null ? '—' : current.familyInformed ? t('Yes') : t('No'),
            ],
            ...(current.faithOrBeliefNote
              ? ([[t('Faith or belief'), current.faithOrBeliefNote]] as [string, string][])
              : []),
            [t('Registered'), formatDateTime(current.createdAt)],
          ]}
        />
      ) : (
        donation.eligible && <EmptyState title={t('You have not registered a decision yet')} />
      )}
      {donation.history.length > 1 && (
        <details>
          <summary>
            {t('Earlier decisions ({count})', { count: donation.history.length - 1 })}
          </summary>
          <ul>
            {donation.history.slice(1).map((h) => (
              <li key={h.id}>
                {formatDate(h.createdAt)} – {decisionShort(h.decision)}
                {h.organs?.length ? ` (${h.organs.map(organLabel).join(', ')})` : ''} ·{' '}
                {h.recordedVia === 'PORTAL'
                  ? t('in the portal')
                  : t('in person, recorded by {name}', { name: h.recordedByName })}
              </li>
            ))}
          </ul>
        </details>
      )}
      <Dialog
        open={editing}
        onClose={() => {
          setEditing(false);
          record.reset();
        }}
        title={t('My organ donation decision')}
      >
        <DonationForm
          initial={current}
          submitting={record.isPending}
          error={record.error}
          onCancel={() => setEditing(false)}
          onSubmit={(body) => record.mutate(body, { onSuccess: () => setEditing(false) })}
        />
      </Dialog>
    </Card>
  );
}

function ProxyCard({
  proxy,
  onWithdraw,
}: {
  proxy: Directive | undefined;
  onWithdraw: (d: Directive) => void;
}) {
  const name = useNameProxy();
  const [open, setOpen] = useState(false);
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const v = (k: string) => String(f.get(k) ?? '').trim() || undefined;
    name.mutate(
      {
        proxyName: v('proxyName') ?? '',
        proxyPhone: v('proxyPhone'),
        relationship: v('relationship'),
        note: v('note'),
      },
      { onSuccess: () => setOpen(false) },
    );
  }
  return (
    <Card
      title={t('Healthcare proxy')}
      actions={
        proxy ? (
          <Button size="sm" variant="secondary" onClick={() => onWithdraw(proxy)}>
            {t('Withdraw')}
          </Button>
        ) : (
          <Button size="sm" onClick={() => setOpen(true)}>
            {t('Name a healthcare proxy')}
          </Button>
        )
      }
    >
      <p className="muted">{kindExplanation('HEALTHCARE_PROXY')}</p>
      {proxy ? (
        <DefinitionList
          items={[
            [t('Name'), proxy.proxyName],
            [t('Phone'), proxy.proxyPhone ?? '—'],
            [t('Details'), summaryText(proxy.summary)],
            [t('Since'), formatDate(proxy.createdAt)],
          ]}
        />
      ) : (
        <EmptyState title={t('No healthcare proxy named')} />
      )}
      <Dialog
        open={open}
        onClose={() => {
          setOpen(false);
          name.reset();
        }}
        title={t('Name a healthcare proxy')}
      >
        <form onSubmit={submit} className="stack">
          <TextField label={t('Name')} name="proxyName" required minLength={2} maxLength={200} />
          <div className="form-grid">
            <TextField label={t('Relationship')} name="relationship" maxLength={100} />
            <TextField label={t('Phone')} name="proxyPhone" maxLength={40} type="tel" />
          </div>
          <TextAreaField label={t('Note (optional)')} name="note" maxLength={1000} rows={3} />
          <p className="muted">
            {t('Tell this person that you have named them, so they know your wishes.')}
          </p>
          <ErrorAlert error={name.error} />
          <div className="form-actions">
            <Button variant="secondary" onClick={() => setOpen(false)}>
              {t('Cancel')}
            </Button>
            <Button type="submit" loading={name.isPending}>
              {t('Save')}
            </Button>
          </div>
        </form>
      </Dialog>
    </Card>
  );
}

function CareDecisionsCard({
  items,
  canWithdraw,
  onWithdraw,
}: {
  items: Directive[];
  canWithdraw: boolean;
  onWithdraw: (d: Directive) => void;
}) {
  return (
    <Card title={t('Decisions about your care')}>
      {items.length === 0 ? (
        <EmptyState
          title={t('No decisions about resuscitation or limits of treatment are recorded')}
        />
      ) : (
        <ul className="stack" style={{ listStyle: 'none', padding: 0 }}>
          {items.map((d) => (
            <li key={d.id} className="card" style={{ padding: '0.75rem 1rem' }}>
              <div className="row" style={{ justifyContent: 'space-between', gap: '0.5rem' }}>
                <strong>{kindLabel(d.kind)}</strong>
                {d.reviewDue && <Badge tone="warning">{t('Review due|directive')}</Badge>}
              </div>
              <p>{kindExplanation(d.kind)}</p>
              <p className="muted">{d.summary}</p>
              <p className="muted">
                {d.selfRegistered
                  ? t('Registered by you on {date}', { date: formatDate(d.createdAt) })
                  : t('Recorded by {name} on {date}', {
                      name: d.createdByName,
                      date: formatDate(d.createdAt),
                    })}
              </p>
              {canWithdraw && PATIENT_REVOCABLE_KINDS.includes(d.kind) && (
                <Button size="sm" variant="secondary" onClick={() => onWithdraw(d)}>
                  {t('Withdraw')}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
