import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api } from '../../api/client';
import {
  AGE_GROUPS,
  ageGroupLabel,
  ROUTES,
  routeLabel,
  RULE_UNITS,
  ruleLimit,
  useDoseRules,
  type DoseRule,
} from '../../api/dosing';
import { useUser } from '../../auth/AuthContext';
import {
  Alert,
  Button,
  Card,
  Dialog,
  EmptyState,
  ErrorAlert,
  Pagination,
  QueryView,
  SelectField,
  Table,
  TextAreaField,
  TextField,
} from '../../components/ui';
import { t } from '../../i18n';

/**
 * Dose limits by ingredient, route and age group, used by the dose-range checks while prescribing.
 * Everyone on the clinical staff can read them; only the Ministry of Health edits them (audited).
 */
export function DoseRulesTab() {
  const user = useUser();
  const [q, setQ] = useState('');
  const [ageGroup, setAgeGroup] = useState('');
  const [route, setRoute] = useState('');
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<DoseRule | 'new' | null>(null);
  const list = useDoseRules({
    q,
    ageGroup,
    route,
    page,
    includeInactive: user.role === 'MINISTRY',
  });
  const reset = () => setPage(1);

  return (
    <Card
      title={t('Dose rules')}
      actions={
        list.data?.canEdit ? (
          <Button size="sm" onClick={() => setEditing('new')}>
            {t('Add dose rule')}
          </Button>
        ) : undefined
      }
    >
      <Alert tone="warning" title={list.data?.disclaimer ?? t('Demo dose limits – verify against a licensed reference')}>
        {t(
          'Maximum single and daily doses used to check structured prescriptions. Per-kg limits use the latest weight from vital signs; older adults and children fall back to the adult limits where they have no rule of their own.',
        )}
      </Alert>
      <div className="form-grid">
        <TextField
          label={t('Search ingredient')}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            reset();
          }}
        />
        <SelectField
          label={t('Age group')}
          value={ageGroup}
          onChange={(e) => {
            setAgeGroup(e.target.value);
            reset();
          }}
          placeholder={t('All')}
          options={AGE_GROUPS.map((g) => ({ value: g, label: ageGroupLabel(g) }))}
        />
        <SelectField
          label={t('Route')}
          value={route}
          onChange={(e) => {
            setRoute(e.target.value);
            reset();
          }}
          placeholder={t('All')}
          options={ROUTES.map((r) => ({ value: r.toUpperCase(), label: routeLabel(r) }))}
        />
      </div>
      <QueryView query={list}>
        {(data) =>
          data.items.length === 0 ? (
            <EmptyState title={t('No dose rules found')} />
          ) : (
            <>
              <Table caption={t('Dose rules')}>
                <thead>
                  <tr>
                    <th>{t('Ingredient')}</th>
                    <th>{t('Route')}</th>
                    <th>{t('Age group')}</th>
                    <th>{t('Max per dose')}</th>
                    <th>{t('Max per day')}</th>
                    <th>{t('Absolute max per day')}</th>
                    <th>{t('Note')}</th>
                    {data.canEdit && (
                      <th>
                        <span className="sr-only">{t('Actions')}</span>
                      </th>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((r) => (
                    <tr key={r.id} className={r.isActive ? undefined : 'muted'}>
                      <td>
                        <strong>{r.ingredient}</strong>
                        {!r.isActive && <div className="muted">{t('Inactive')}</div>}
                      </td>
                      <td>{routeLabel(r.route)}</td>
                      <td>{ageGroupLabel(r.ageGroup)}</td>
                      <td>{ruleLimit(r.maxSingleDose, r)}</td>
                      <td>{ruleLimit(r.maxDailyDose, r)}</td>
                      <td>
                        {r.absoluteMaxDaily ? ruleLimit(r.absoluteMaxDaily, { ...r, perKg: false }) : '–'}
                      </td>
                      <td>{r.noteTranslated ?? ''}</td>
                      {data.canEdit && (
                        <td>
                          <Button size="sm" variant="secondary" onClick={() => setEditing(r)}>
                            {t('Edit')}
                          </Button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </Table>
              <Pagination page={data.page} totalPages={data.totalPages} onChange={setPage} />
            </>
          )
        }
      </QueryView>
      {editing && (
        <DoseRuleDialog rule={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />
      )}
    </Card>
  );
}

const limitOf = (f: FormData, key: string) => {
  const v = String(f.get(key) ?? '')
    .trim()
    .replace(',', '.');
  return v ? Number(v) : null;
};

function DoseRuleDialog({ rule, onClose }: { rule: DoseRule | null; onClose: () => void }) {
  const qc = useQueryClient();
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      rule
        ? api(`/safety/dose-rules/${rule.id}`, { method: 'PATCH', body })
        : api('/safety/dose-rules', { method: 'POST', body }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['safety', 'dose-rules'] });
      onClose();
    },
  });

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const body: Record<string, unknown> = {
      unit: f.get('unit'),
      perKg: f.get('perKg') === 'on',
      maxSingleDose: limitOf(f, 'maxSingleDose'),
      maxDailyDose: limitOf(f, 'maxDailyDose'),
      absoluteMaxDaily: limitOf(f, 'absoluteMaxDaily'),
      note: String(f.get('note') ?? '').trim() || null,
    };
    if (rule) body.isActive = f.get('isActive') === 'on';
    else {
      body.ingredient = String(f.get('ingredient') ?? '').trim();
      body.route = f.get('route');
      body.ageGroup = f.get('ageGroup');
    }
    save.mutate(body);
  }

  const num = (v: string | null | undefined) => (v ? String(Number(v)) : '');

  return (
    <Dialog open onClose={onClose} title={rule ? t('Edit dose rule') : t('Add dose rule')} wide>
      <form onSubmit={onSubmit}>
        {rule ? (
          <p>
            <strong>{rule.ingredient}</strong> · {routeLabel(rule.route)} ·{' '}
            {ageGroupLabel(rule.ageGroup)}
          </p>
        ) : (
          <div className="form-grid">
            <TextField
              label={t('Ingredient (INN)')}
              name="ingredient"
              required
              minLength={2}
              maxLength={100}
            />
            <SelectField
              label={t('Route')}
              name="route"
              required
              defaultValue="ORAL"
              options={ROUTES.map((r) => ({ value: r.toUpperCase(), label: routeLabel(r) }))}
            />
            <SelectField
              label={t('Age group')}
              name="ageGroup"
              required
              defaultValue="ADULT"
              options={AGE_GROUPS.map((g) => ({ value: g, label: ageGroupLabel(g) }))}
            />
          </div>
        )}
        <div className="form-grid">
          <SelectField
            label={t('Unit')}
            name="unit"
            required
            defaultValue={rule?.unit ?? 'mg'}
            options={RULE_UNITS.map((u) => ({ value: u, label: u }))}
          />
          <TextField
            label={t('Max per dose')}
            name="maxSingleDose"
            inputMode="decimal"
            defaultValue={num(rule?.maxSingleDose)}
          />
          <TextField
            label={t('Max per day')}
            name="maxDailyDose"
            inputMode="decimal"
            defaultValue={num(rule?.maxDailyDose)}
          />
          <TextField
            label={t('Absolute max per day')}
            name="absoluteMaxDaily"
            inputMode="decimal"
            defaultValue={num(rule?.absoluteMaxDaily)}
            hint={t('Cap even when dosed per kg (e.g. paracetamol 4000 mg).')}
          />
        </div>
        <label className="checkbox">
          <input type="checkbox" name="perKg" defaultChecked={rule?.perKg ?? false} />
          {t('Limits are per kg of body weight')}
        </label>
        <TextAreaField
          label={t('Note (English source text)')}
          name="note"
          maxLength={300}
          rows={2}
          defaultValue={rule?.note ?? ''}
          hint={t('Shown to the prescriber as what to do when the limit is exceeded.')}
        />
        {rule && (
          <label className="checkbox">
            <input type="checkbox" name="isActive" defaultChecked={rule.isActive} />
            {t('Active (used in safety checks)')}
          </label>
        )}
        <ErrorAlert error={save.error} />
        <div className="form-actions">
          <Button variant="secondary" onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button type="submit" loading={save.isPending}>
            {t('Save')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
