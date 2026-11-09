import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import {
  decisionLabel,
  decisionTone,
  downloadAttestation,
  flagLabel,
  flagTone,
  licenceLabel,
  reviewStatusLabel,
  reviewStatusTone,
  useCompleteReview,
  useDecide,
  useReview,
  type Decision,
  type ReviewDetail,
  type ReviewItem,
} from '../../api/accessreviews';
import {
  Alert,
  Badge,
  Button,
  Card,
  Dialog,
  EmptyState,
  ErrorAlert,
  Grid,
  QueryView,
  Stat,
  Table,
  Tabs,
  TextAreaField,
} from '../../components/ui';
import { formatDate, formatDateTime, formatNumber, humanize } from '../../format';
import { t } from '../../i18n';

type Filter = 'all' | 'flagged' | 'undecided';

/** Where the change itself is made. */
const staffPage = (scope: 'FACILITY' | 'MINISTRY') =>
  scope === 'MINISTRY' ? '/ministry/staff' : '/director/staff';

export function ReviewStatusBadge({
  status,
  overdue,
}: {
  status: ReviewDetail['status'] | 'NOT_OPENED';
  overdue?: boolean;
}) {
  return (
    <Badge tone={reviewStatusTone(status, overdue)}>{reviewStatusLabel(status, overdue)}</Badge>
  );
}

/** One review: the accounts with what was seen, and the decisions. */
export function ReviewView({ id }: { id: string }) {
  const review = useReview(id);
  return <QueryView query={review}>{(r) => <ReviewBody review={r} />}</QueryView>;
}

function ReviewBody({ review }: { review: ReviewDetail }) {
  const [filter, setFilter] = useState<Filter>(review.status === 'OPEN' ? 'undecided' : 'all');
  const [deciding, setDeciding] = useState<{ item: ReviewItem; decision: Decision } | null>(null);
  const keep = useDecide(review.id);
  const complete = useCompleteReview(review.id);
  const flagged = review.items.filter((i) => i.snapshot.flags.some((f) => f !== 'NO_TWO_STEP'));
  const undecided = review.items.filter((i) => !i.decision);
  const shown = filter === 'flagged' ? flagged : filter === 'undecided' ? undecided : review.items;
  const title =
    review.scope === 'MINISTRY'
      ? t('Ministry review {period}', { period: review.period })
      : t('{facility} – review {period}', {
          facility: review.facilityName ?? '',
          period: review.period,
        });
  return (
    <div className="stack">
      <Card
        title={title}
        actions={
          <>
            {review.canComplete && (
              <Button loading={complete.isPending} onClick={() => complete.mutate()}>
                {t('Complete the review')}
              </Button>
            )}
            {review.status === 'COMPLETED' && (
              <Button variant="secondary" onClick={() => void downloadAttestation(review)}>
                {t('Download attestation (CSV)')}
              </Button>
            )}
          </>
        }
      >
        <Grid min={170}>
          <Stat
            label={t('Status')}
            value={<ReviewStatusBadge status={review.status} overdue={review.overdue} />}
          />
          <Stat
            label={t('Due by')}
            value={formatDate(review.dueDate)}
            tone={review.overdue ? 'danger' : undefined}
          />
          <Stat
            label={t('Accounts decided')}
            value={`${formatNumber(review.decided)} / ${formatNumber(review.total)}`}
          />
          <Stat label={t('Accounts revoked')} value={formatNumber(review.revoked)} />
          <Stat label={t('Accounts with warnings')} value={formatNumber(flagged.length)} />
        </Grid>
        {review.completedAt && (
          <p className="muted">
            {t('Completed on {date}.', { date: formatDateTime(review.completedAt) })}
          </p>
        )}
        {!review.canDecide && review.status === 'OPEN' && (
          <Alert tone="info">
            {t('You can read this review. Decisions are made by the facility’s directors.')}
          </Alert>
        )}
        {review.status === 'OPEN' && review.canDecide && undecided.length > 0 && (
          <p className="muted">
            {t(
              'Check each account: keep it, mark it for a change (made on the staff page) or revoke it. The review can be completed when every account is decided.',
            )}
          </p>
        )}
        <ErrorAlert error={complete.error ?? keep.error} />
      </Card>
      <Tabs
        label={t('Show accounts')}
        withPanels={false}
        active={filter}
        onChange={setFilter}
        tabs={[
          { id: 'undecided', label: t('Undecided'), count: undecided.length },
          { id: 'flagged', label: t('With warnings'), count: flagged.length },
          { id: 'all', label: t('All accounts'), count: review.items.length },
        ]}
      />
      {shown.length === 0 ? (
        <EmptyState title={t('No accounts in this list')} />
      ) : (
        <Table caption={title}>
          <thead>
            <tr>
              <th scope="col">{t('Account')}</th>
              <th scope="col">{t('Last sign-in')}</th>
              <th scope="col">{t('Licence')}</th>
              <th scope="col" className="num">
                {t('Emergency access (90 days)')}
              </th>
              <th scope="col">{t('Warnings')}</th>
              <th scope="col">{t('Decision')}</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((item) => (
              <ItemRow
                key={item.id}
                item={item}
                review={review}
                onDecide={(decision) =>
                  decision === 'KEEP'
                    ? keep.mutate({ itemId: item.id, decision })
                    : setDeciding({ item, decision })
                }
                busy={keep.isPending && keep.variables?.itemId === item.id}
              />
            ))}
          </tbody>
        </Table>
      )}
      <DecisionDialog
        reviewId={review.id}
        scope={review.scope}
        deciding={deciding}
        onClose={() => setDeciding(null)}
      />
    </div>
  );
}

function ItemRow({
  item,
  review,
  onDecide,
  busy,
}: {
  item: ReviewItem;
  review: ReviewDetail;
  onDecide: (d: Decision) => void;
  busy: boolean;
}) {
  const s = item.snapshot;
  const canAct = review.canDecide && !item.isMe && item.decision !== 'REVOKE';
  return (
    <tr>
      <th scope="row">
        <strong>{s.fullName}</strong>
        <div className="muted">
          {humanize(s.role)}
          {s.specialty ? ` · ${s.specialty}` : ''}
          {review.scope === 'MINISTRY' && s.facilityName ? ` · ${s.facilityName}` : ''}
        </div>
        <div className="muted">{s.email}</div>
        {s.units.length > 0 && <div className="muted">{s.units.join(', ')}</div>}
        {!item.current.isActive && item.decision !== 'REVOKE' && (
          <Badge tone="neutral">{t('Deactivated since the review opened')}</Badge>
        )}
      </th>
      <td>
        {s.lastLoginAt ? formatDate(s.lastLoginAt) : t('Never')}
        {s.twoStep && <div className="muted">{t('Two-step sign-in on')}</div>}
      </td>
      <td>{licenceLabel(s.licence)}</td>
      <td className="num">{formatNumber(s.emergencyAccessCount)}</td>
      <td>
        {s.flags.length === 0 ? (
          '—'
        ) : (
          <div className="badge-wrap">
            {s.flags.map((f) => (
              <Badge key={f} tone={flagTone(f)}>
                {flagLabel(f)}
              </Badge>
            ))}
          </div>
        )}
      </td>
      <td>
        {item.decision && (
          <div>
            <Badge tone={decisionTone(item.decision)}>{decisionLabel(item.decision)}</Badge>
            {item.note && <div>{item.note}</div>}
            {item.decidedByName && (
              <div className="muted">
                {t('{name}, {date}', {
                  name: item.decidedByName,
                  date: formatDate(item.decidedAt),
                })}
              </div>
            )}
          </div>
        )}
        {item.isMe && review.status === 'OPEN' && (
          <p className="muted">{t('Your own account is reviewed by someone else.')}</p>
        )}
        {canAct && (
          <div
            className="badge-wrap"
            role="group"
            aria-label={t('Decide on {name}', { name: s.fullName })}
          >
            {item.decision !== 'KEEP' && (
              <Button size="sm" variant="secondary" loading={busy} onClick={() => onDecide('KEEP')}>
                {t('Keep')}
              </Button>
            )}
            {item.decision !== 'CHANGE' && (
              <Button size="sm" variant="secondary" onClick={() => onDecide('CHANGE')}>
                {t('Change needed')}
              </Button>
            )}
            <Button size="sm" variant="danger" onClick={() => onDecide('REVOKE')}>
              {t('Revoke')}
            </Button>
          </div>
        )}
      </td>
    </tr>
  );
}

function DecisionDialog({
  reviewId,
  scope,
  deciding,
  onClose,
}: {
  reviewId: string;
  scope: 'FACILITY' | 'MINISTRY';
  deciding: { item: ReviewItem; decision: Decision } | null;
  onClose: () => void;
}) {
  const decide = useDecide(reviewId);
  const revoke = deciding?.decision === 'REVOKE';
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!deciding) return;
    const note = String(new FormData(e.currentTarget).get('note') ?? '').trim();
    decide.mutate(
      { itemId: deciding.item.id, decision: deciding.decision, note },
      {
        onSuccess: () => {
          decide.reset();
          onClose();
        },
      },
    );
  };
  return (
    <Dialog
      open={deciding !== null}
      onClose={() => {
        decide.reset();
        onClose();
      }}
      title={
        revoke
          ? t('Revoke the account of {name}', { name: deciding?.item.snapshot.fullName ?? '' })
          : t('Change needed for {name}', { name: deciding?.item.snapshot.fullName ?? '' })
      }
    >
      <form onSubmit={submit} className="stack">
        {revoke ? (
          <Alert tone="danger">
            {t(
              'The account is deactivated at once and every session ends. It can be reactivated on the staff page if this was a mistake.',
            )}
          </Alert>
        ) : (
          <p className="muted">
            {t('Note what must change. The change itself is made on the staff page.')}{' '}
            <Link to={staffPage(scope)}>{t('Open the staff page')}</Link>
          </p>
        )}
        <TextAreaField
          name="note"
          label={revoke ? t('Reason for revoking') : t('What must change')}
          required
          minLength={3}
          maxLength={500}
        />
        <ErrorAlert error={decide.error} />
        <div className="form-actions">
          <Button variant="secondary" onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button type="submit" variant={revoke ? 'danger' : 'primary'} loading={decide.isPending}>
            {revoke ? t('Revoke the account') : t('Save the decision')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
