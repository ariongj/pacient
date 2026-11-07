import { useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  categoryLabel,
  COMPLAINT_CATEGORIES,
  complaintStatusLabel,
  complaintStatusTone,
  FEEDBACK_ITEMS,
  feedbackItemLabel,
  outcomeLabel,
  settingLabel,
  useMyComplaints,
  usePortalComplaintAction,
  usePortalFacilities,
  useRateableVisits,
  useSubmitComplaint,
  useSubmitFeedback,
  type PortalComplaint,
  type RateableVisit,
} from '../../api/complaints';
import {
  Alert,
  Badge,
  Button,
  Card,
  DefinitionList,
  Dialog,
  EmptyState,
  ErrorAlert,
  formValues,
  PageHeader,
  QueryView,
  SelectField,
  TabPanel,
  Table,
  Tabs,
  TextAreaField,
} from '../../components/ui';
import { formatDate, formatDateTime } from '../../format';
import { t } from '../../i18n';

type TabId = 'feedback' | 'mine' | 'new';

/**
 * Portal: rate recent visits anonymously, follow complaints (and escalate them to the Ministry
 * within 30 days of the answer), and make a new complaint.
 */
export function PortalComplaintsPage() {
  const [params, setParams] = useSearchParams();
  const requested = params.get('tab') as TabId | null;
  const [tab, setTab] = useState<TabId>(
    requested && ['feedback', 'mine', 'new'].includes(requested)
      ? requested
      : params.get('complaint')
        ? 'mine'
        : 'feedback',
  );
  return (
    <>
      <PageHeader
        title={t('Complaints and feedback')}
        subtitle={t(
          'Tell us how your care went. Ratings are anonymous; a complaint is answered in writing within 30 days.',
        )}
      />
      <Tabs
        label={t('Complaints and feedback')}
        tabs={[
          { id: 'feedback', label: t('Rate your recent visits') },
          { id: 'mine', label: t('My complaints') },
          { id: 'new', label: t('Make a complaint') },
        ]}
        active={tab}
        onChange={(id) => {
          setTab(id);
          setParams({}, { replace: true });
        }}
      />
      <TabPanel id={tab}>
        {tab === 'feedback' && <RateVisits />}
        {tab === 'mine' && <MyComplaints openId={params.get('complaint')} />}
        {tab === 'new' && <NewComplaint onDone={() => setTab('mine')} />}
      </TabPanel>
    </>
  );
}

/* ------------------------------------------------------------------------------ ratings -- */

function RateVisits() {
  const visits = useRateableVisits();
  const [rating, setRating] = useState<RateableVisit | null>(null);
  const [thanks, setThanks] = useState(false);
  return (
    <Card title={t('Rate your recent visits')}>
      <p className="muted">
        {t(
          'Your rating is anonymous: it is stored without your name or the date of your visit, and results are shown only when enough people have answered.',
        )}
      </p>
      {thanks && (
        <Alert tone="success" title={t('Thank you for your feedback')}>
          {t('It helps the facility improve care for everyone.')}
        </Alert>
      )}
      <QueryView query={visits}>
        {(d) =>
          d.items.length === 0 ? (
            <EmptyState title={t('No visits to rate')}>
              {t('Visits from the last 30 days that you have not rated appear here.')}
            </EmptyState>
          ) : (
            <ul className="stack" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {d.items.map((v) => (
                <li
                  key={`${v.setting}-${v.visitId}`}
                  className="card"
                  style={{
                    padding: '0.75rem 1rem',
                    display: 'flex',
                    gap: '1rem',
                    flexWrap: 'wrap',
                    alignItems: 'center',
                  }}
                >
                  <div style={{ flex: 1, minWidth: '12rem' }}>
                    <strong>{v.facilityName}</strong>
                    <div className="muted">
                      {settingLabel(v.setting)}
                      {v.unitName ? ` · ${v.unitName}` : ''} · {formatDate(v.endedAt)}
                    </div>
                  </div>
                  <Button
                    onClick={() => {
                      setThanks(false);
                      setRating(v);
                    }}
                  >
                    {t('Rate this visit')}
                  </Button>
                </li>
              ))}
            </ul>
          )
        }
      </QueryView>
      <Dialog
        open={rating !== null}
        onClose={() => setRating(null)}
        title={t('Rate this visit')}
        wide
      >
        {rating && (
          <RatingForm
            visit={rating}
            onDone={() => {
              setRating(null);
              setThanks(true);
            }}
          />
        )}
      </Dialog>
    </Card>
  );
}

function ScaleField({
  name,
  legend,
  required,
}: {
  name: string;
  legend: string;
  required?: boolean;
}) {
  return (
    <fieldset className="rating-scale" style={{ border: 0, padding: 0, margin: '0 0 0.75rem' }}>
      <legend style={{ fontWeight: 600, marginBottom: '0.25rem' }}>
        {legend}
        {required && <span aria-hidden="true"> *</span>}
      </legend>
      <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
        {[1, 2, 3, 4, 5].map((n) => (
          <label key={n} style={{ display: 'inline-flex', gap: '0.3rem', alignItems: 'center' }}>
            <input type="radio" name={name} value={n} required={required} />
            {n === 1 ? t('1 – very poor') : n === 5 ? t('5 – very good') : String(n)}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function RatingForm({ visit, onDone }: { visit: RateableVisit; onDone: () => void }) {
  const submit = useSubmitFeedback();
  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const v = formValues(e.currentTarget);
    const scores = Object.fromEntries(
      FEEDBACK_ITEMS.filter((i) => v[i]).map((i) => [i, Number(v[i])]),
    );
    submit.mutate(
      {
        setting: visit.setting,
        visitId: visit.visitId,
        overall: Number(v.overall),
        scores,
        wouldRecommend: v.wouldRecommend === '' ? null : v.wouldRecommend === 'yes',
        comment: v.comment || null,
      },
      { onSuccess: onDone },
    );
  }
  return (
    <form onSubmit={onSubmit}>
      <p>
        <strong>{visit.facilityName}</strong> · {settingLabel(visit.setting)} ·{' '}
        {formatDate(visit.endedAt)}
      </p>
      <ScaleField name="overall" legend={t('Overall, how was your care?')} required />
      <p className="muted">{t('The questions below are optional.')}</p>
      {FEEDBACK_ITEMS.map((i) => (
        <ScaleField key={i} name={i} legend={feedbackItemLabel(i)} />
      ))}
      <SelectField
        label={t('Would you recommend this facility to friends and family?')}
        name="wouldRecommend"
        placeholder={t('Prefer not to say')}
        options={[
          { value: 'yes', label: t('Yes') },
          { value: 'no', label: t('No') },
        ]}
      />
      <TextAreaField
        label={t('Anything else you would like to tell us?')}
        name="comment"
        maxLength={1000}
        rows={3}
        hint={t(
          'Do not write names or details that could identify you or others – comments are read by the facility.',
        )}
      />
      <ErrorAlert error={submit.error} />
      <div className="form-actions">
        <Button type="submit" loading={submit.isPending}>
          {t('Send anonymously')}
        </Button>
      </div>
    </form>
  );
}

/* --------------------------------------------------------------------------- complaints -- */

function MyComplaints({ openId }: { openId: string | null }) {
  const mine = useMyComplaints();
  const [open, setOpen] = useState<string | null>(openId);
  return (
    <Card title={t('My complaints')}>
      <QueryView query={mine}>
        {(d) => {
          const current = d.items.find((c) => c.id === open) ?? null;
          return d.items.length === 0 ? (
            <EmptyState title={t('No complaints')}>
              {t('Complaints you make about care at a facility appear here with their answer.')}
            </EmptyState>
          ) : (
            <>
              <Table caption={t('My complaints')}>
                <thead>
                  <tr>
                    <th>{t('Reference|complaint')}</th>
                    <th>{t('Facility')}</th>
                    <th>{t('Subject')}</th>
                    <th>{t('Submitted')}</th>
                    <th>{t('Status')}</th>
                    <th>
                      <span className="sr-only">{t('Actions')}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {d.items.map((c) => (
                    <tr key={c.id}>
                      <td>
                        <code>{c.reference}</code>
                      </td>
                      <td>{c.facilityName}</td>
                      <td>{categoryLabel(c.category)}</td>
                      <td>{formatDate(c.createdAt)}</td>
                      <td>
                        <Badge tone={complaintStatusTone(c.status)}>
                          {complaintStatusLabel(c.status)}
                        </Badge>
                      </td>
                      <td>
                        <Button size="sm" variant="secondary" onClick={() => setOpen(c.id)}>
                          {t('Open|action')}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
              <Dialog
                open={current !== null}
                onClose={() => setOpen(null)}
                title={current ? t('Complaint {reference}', { reference: current.reference }) : ''}
                wide
              >
                {current && <MyComplaintView complaint={current} />}
              </Dialog>
            </>
          );
        }}
      </QueryView>
    </Card>
  );
}

function MyComplaintView({ complaint: c }: { complaint: PortalComplaint }) {
  const action = usePortalComplaintAction(c.id);
  const [escalating, setEscalating] = useState(false);
  return (
    <div className="stack">
      <DefinitionList
        items={[
          [t('Facility'), c.facilityName],
          [t('Subject'), categoryLabel(c.category)],
          [t('Submitted'), formatDateTime(c.createdAt)],
          [
            t('Status'),
            <Badge key="s" tone={complaintStatusTone(c.status)}>
              {complaintStatusLabel(c.status)}
            </Badge>,
          ],
          [
            t('Answer due by'),
            c.respondedAt
              ? t('Answered on {date}', { date: formatDate(c.respondedAt) })
              : formatDate(c.responseDueAt),
          ],
        ]}
      />
      <section>
        <h3>{t('Your complaint')}</h3>
        <p style={{ whiteSpace: 'pre-wrap' }}>{c.description}</p>
        {c.desiredOutcome && (
          <p className="muted" style={{ whiteSpace: 'pre-wrap' }}>
            <strong>{t('What you would like to happen')}:</strong> {c.desiredOutcome}
          </p>
        )}
      </section>
      {c.response && (
        <section>
          <h3>{t('Answer from the facility')}</h3>
          {c.outcome && <p>{outcomeLabel(c.outcome)}</p>}
          <p style={{ whiteSpace: 'pre-wrap' }}>{c.response}</p>
        </section>
      )}
      {c.escalatedAt && (
        <section>
          <h3>{t('Escalated to the Ministry of Health')}</h3>
          <p className="muted">{formatDate(c.escalatedAt)}</p>
          {c.escalationReason && <p style={{ whiteSpace: 'pre-wrap' }}>{c.escalationReason}</p>}
          {c.ministryDecision ? (
            <>
              <h4>{t('Decision of the Ministry')}</h4>
              <p style={{ whiteSpace: 'pre-wrap' }}>{c.ministryDecision}</p>
            </>
          ) : (
            <p>{t('The Ministry is reviewing how the facility handled your complaint.')}</p>
          )}
        </section>
      )}
      {c.outcome === 'WITHDRAWN' && <p className="muted">{t('You withdrew this complaint.')}</p>}
      <ErrorAlert error={action.error} />
      {c.canEscalate && !escalating && (
        <Alert tone="info" title={t('Not satisfied with the answer?')}>
          {t('You can ask the Ministry of Health to review it until {date}.', {
            date: formatDate(c.escalateUntil!),
          })}{' '}
          <Button size="sm" variant="secondary" onClick={() => setEscalating(true)}>
            {t('Escalate to the Ministry')}
          </Button>
        </Alert>
      )}
      {escalating && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            action.mutate(
              { action: 'escalate', body: { reason: formValues(e.currentTarget).reason } },
              { onSuccess: () => setEscalating(false) },
            );
          }}
        >
          <TextAreaField
            label={t('Why are you not satisfied with the answer?')}
            name="reason"
            required
            minLength={10}
            maxLength={2000}
          />
          <div className="form-actions">
            <Button variant="secondary" onClick={() => setEscalating(false)}>
              {t('Cancel')}
            </Button>
            <Button type="submit" loading={action.isPending}>
              {t('Escalate to the Ministry')}
            </Button>
          </div>
        </form>
      )}
      {c.canWithdraw && (
        <div className="form-actions">
          <Button
            variant="secondary"
            loading={action.isPending}
            onClick={() => {
              if (window.confirm(t('Withdraw this complaint? It will be closed.'))) {
                action.mutate({ action: 'withdraw' });
              }
            }}
          >
            {t('Withdraw complaint')}
          </Button>
        </div>
      )}
    </div>
  );
}

function NewComplaint({ onDone }: { onDone: () => void }) {
  const facilities = usePortalFacilities();
  const submit = useSubmitComplaint();
  const [done, setDone] = useState<{
    reference: string;
    responseDueAt: string;
    hadRecentCare: boolean;
  } | null>(null);
  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const v = formValues(e.currentTarget);
    submit.mutate(
      {
        facilityId: v.facilityId,
        category: v.category,
        description: v.description,
        desiredOutcome: v.desiredOutcome || null,
      },
      { onSuccess: (r) => setDone(r) },
    );
  }
  if (done) {
    return (
      <Card title={t('Make a complaint')}>
        <Alert
          tone="success"
          title={t('Your complaint {reference} was sent', { reference: done.reference })}
        >
          {t(
            'The facility will confirm it within 5 working days and answer in writing by {date}.',
            {
              date: formatDate(done.responseDueAt),
            },
          )}
        </Alert>
        {!done.hadRecentCare && (
          <p className="muted">
            {t(
              'We could not find care for you at this facility in the last two years. The facility may contact you for details.',
            )}
          </p>
        )}
        <div className="form-actions">
          <Button onClick={onDone}>{t('See my complaints')}</Button>
        </div>
      </Card>
    );
  }
  return (
    <Card title={t('Make a complaint')}>
      <p className="muted">
        {t(
          'A complaint is a formal request for the facility to look into what happened and answer you. It never affects the care you receive.',
        )}
      </p>
      <QueryView query={facilities}>
        {(d) => {
          const visited = d.items.filter((f) => f.visited);
          const others = d.items.filter((f) => !f.visited);
          return (
            <form onSubmit={onSubmit}>
              <div className="field">
                <label htmlFor="complaint-facility">
                  {t('Facility')}
                  <span className="required" aria-hidden="true">
                    {' '}
                    *
                  </span>
                </label>
                <select id="complaint-facility" name="facilityId" required defaultValue="">
                  <option value="" disabled>
                    {t('Choose…')}
                  </option>
                  {visited.length > 0 && (
                    <optgroup label={t('Where you had care recently')}>
                      {visited.map((f) => (
                        <option key={f.id} value={f.id}>
                          {f.name}
                        </option>
                      ))}
                    </optgroup>
                  )}
                  <optgroup label={t('Other facilities')}>
                    {others.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.name}
                      </option>
                    ))}
                  </optgroup>
                </select>
              </div>
              <SelectField
                label={t('What is it about?')}
                name="category"
                required
                placeholder={t('Choose…')}
                options={COMPLAINT_CATEGORIES.map((c) => ({ value: c, label: categoryLabel(c) }))}
              />
              <TextAreaField
                label={t('What happened?')}
                name="description"
                required
                minLength={20}
                maxLength={5000}
                rows={6}
                hint={t('When and where it happened, and who was involved if you know.')}
              />
              <TextAreaField
                label={t('What would you like to happen?')}
                name="desiredOutcome"
                maxLength={2000}
                rows={3}
              />
              <ErrorAlert error={submit.error} />
              <div className="form-actions">
                <Button type="submit" loading={submit.isPending}>
                  {t('Send complaint')}
                </Button>
              </div>
            </form>
          );
        }}
      </QueryView>
    </Card>
  );
}
