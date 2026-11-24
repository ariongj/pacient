import { useState, type FormEvent } from 'react';
import {
  centsToInput,
  formatMoney,
  inputToCents,
  savePlan,
  useBillingMutation,
  usePlans,
  type Plan,
} from '../../api/subscriptions';
import {
  Alert,
  Badge,
  Button,
  Dialog,
  EmptyState,
  ErrorAlert,
  formValues,
  PageHeader,
  QueryView,
  Table,
  TextAreaField,
  TextField,
} from '../../components/ui';
import { formatNumber } from '../../format';
import { t } from '../../i18n';

function PlanForm({ plan, onDone }: { plan?: Plan; onDone: () => void }) {
  const [problem, setProblem] = useState<string | null>(null);
  const mutation = useBillingMutation(savePlan);
  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const v = formValues(e.currentTarget);
    const monthly = inputToCents(v.monthly ?? '');
    const yearly = inputToCents(v.yearly ?? '');
    if (monthly === null || yearly === null || Number.isNaN(monthly) || Number.isNaN(yearly)) {
      setProblem(t('Enter the price as an amount, e.g. 149.00'));
      return;
    }
    const features = (v.features ?? '')
      .split('\n')
      .map((f) => f.trim())
      .filter(Boolean);
    if (features.length > 10) {
      setProblem(t('At most 10 features, one per line.'));
      return;
    }
    setProblem(null);
    mutation.mutate(
      {
        id: plan?.id,
        body: {
          code: v.code,
          name: v.name,
          description: v.description || null,
          monthlyPriceCents: monthly,
          yearlyPriceCents: yearly,
          seatLimit: v.seatLimit ? Number(v.seatLimit) : null,
          features,
          sortOrder: v.sortOrder ? Number(v.sortOrder) : 0,
          isActive: v.isActive === 'yes',
        },
      },
      { onSuccess: onDone },
    );
  }
  return (
    <form onSubmit={onSubmit}>
      <div className="form-grid">
        <TextField
          label={t('Code')}
          name="code"
          required
          pattern="[A-Za-z0-9\-]{2,40}"
          defaultValue={plan?.code}
          hint={t('Letters, digits and dashes, e.g. CLINIC')}
        />
        <TextField
          label={t('Name|thing')}
          name="name"
          required
          minLength={2}
          maxLength={120}
          defaultValue={plan?.name}
        />
        <TextField
          label={t('Monthly price (€)')}
          name="monthly"
          type="number"
          min={0}
          step="0.01"
          required
          defaultValue={centsToInput(plan?.monthlyPriceCents)}
        />
        <TextField
          label={t('Yearly price (€)')}
          name="yearly"
          type="number"
          min={0}
          step="0.01"
          required
          defaultValue={centsToInput(plan?.yearlyPriceCents)}
          hint={t('E.g. ten monthly prices for a year paid at once')}
        />
        <TextField
          label={t('Staff accounts included')}
          name="seatLimit"
          type="number"
          min={1}
          max={100000}
          defaultValue={plan?.seatLimit ?? ''}
          hint={t('Empty: no limit. Patients never count.')}
        />
        <TextField
          label={t('Order in lists')}
          name="sortOrder"
          type="number"
          min={0}
          max={1000}
          defaultValue={plan?.sortOrder ?? 0}
        />
      </div>
      <TextAreaField
        label={t('Description')}
        name="description"
        maxLength={1000}
        rows={2}
        defaultValue={plan?.description ?? ''}
      />
      <TextAreaField
        label={t('Features')}
        name="features"
        rows={4}
        defaultValue={plan?.features.join('\n') ?? ''}
        hint={t('One per line, at most 10; shown to the facility’s directors.')}
      />
      <label className="checkbox">
        <input
          type="checkbox"
          name="isActive"
          value="yes"
          defaultChecked={plan?.isActive ?? true}
        />
        {t('Offered to new subscriptions')}
      </label>
      {plan && (
        <p className="muted">
          {t(
            'Running subscriptions keep their agreed price and number of staff accounts; a new price or limit applies to new subscriptions and plan changes.',
          )}
        </p>
      )}
      {problem && <Alert tone="danger" title={problem} />}
      <ErrorAlert error={mutation.error} />
      <div className="form-actions">
        <Button variant="secondary" onClick={onDone}>
          {t('Cancel')}
        </Button>
        <Button type="submit" loading={mutation.isPending}>
          {plan ? t('Save changes') : t('Create plan')}
        </Button>
      </div>
    </form>
  );
}

/** What facilities can subscribe to. */
export function Plans() {
  const query = usePlans();
  const [editing, setEditing] = useState<Plan | 'new' | null>(null);
  const toggle = useBillingMutation(savePlan);
  return (
    <>
      <PageHeader
        title={t('Plans')}
        subtitle={t('What facilities can subscribe to.')}
        actions={<Button onClick={() => setEditing('new')}>{t('New plan')}</Button>}
      />
      <ErrorAlert error={toggle.error} />
      <QueryView query={query}>
        {(plans) =>
          plans.length === 0 ? (
            <EmptyState title={t('No plans yet')}>
              {t('Create the plans facilities can subscribe to.')}
            </EmptyState>
          ) : (
            <Table caption={t('Plans')}>
              <thead>
                <tr>
                  <th scope="col">{t('Plan')}</th>
                  <th scope="col">{t('Monthly')}</th>
                  <th scope="col">{t('Yearly')}</th>
                  <th scope="col">{t('Staff accounts included')}</th>
                  <th scope="col">{t('Subscriptions')}</th>
                  <th scope="col">{t('Status')}</th>
                  <th scope="col">
                    <span className="sr-only">{t('Actions')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {plans.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <strong>{p.name}</strong> <span className="muted">{p.code}</span>
                      {p.description && <div className="muted">{p.description}</div>}
                      {p.features.length > 0 && (
                        <ul
                          className="muted"
                          style={{ margin: '0.25rem 0 0', paddingLeft: '1.1rem' }}
                        >
                          {p.features.map((f) => (
                            <li key={f}>{f}</li>
                          ))}
                        </ul>
                      )}
                    </td>
                    <td>{formatMoney(p.monthlyPriceCents, p.currency)}</td>
                    <td>{formatMoney(p.yearlyPriceCents, p.currency)}</td>
                    <td>{p.seatLimit === null ? t('No limit') : formatNumber(p.seatLimit)}</td>
                    <td>{formatNumber(p.subscribers ?? 0)}</td>
                    <td>
                      {p.isActive ? (
                        <Badge tone="success">{t('Offered')}</Badge>
                      ) : (
                        <Badge>{t('Not offered')}</Badge>
                      )}
                    </td>
                    <td>
                      <div className="row">
                        <Button size="sm" variant="secondary" onClick={() => setEditing(p)}>
                          {t('Edit')}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          loading={toggle.isPending && toggle.variables?.id === p.id}
                          onClick={() =>
                            toggle.mutate({ id: p.id, body: { isActive: !p.isActive } })
                          }
                        >
                          {p.isActive ? t('Stop offering') : t('Offer again')}
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )
        }
      </QueryView>
      <Dialog
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing === 'new' ? t('New plan') : t('Edit plan')}
        wide
      >
        {editing !== null && (
          <PlanForm
            plan={editing === 'new' ? undefined : editing}
            onDone={() => setEditing(null)}
          />
        )}
      </Dialog>
    </>
  );
}
