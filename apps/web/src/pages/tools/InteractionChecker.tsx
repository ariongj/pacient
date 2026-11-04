import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../../api/client';
import {
  SEVERITIES,
  severityLabel,
  type AlertSeverity,
  type Interaction,
  type SafetyAlert,
} from '../../api/safety';
import { itemName, type CatalogItem } from '../../api/stock';
import { useUser } from '../../auth/AuthContext';
import {
  Alert,
  Button,
  Card,
  Dialog,
  EmptyState,
  ErrorAlert,
  PageHeader,
  Pagination,
  QueryView,
  SelectField,
  TabPanel,
  Table,
  Tabs,
  TextAreaField,
  TextField,
} from '../../components/ui';
import { t } from '../../i18n';
import { CatalogPicker } from '../pharmacy/CatalogPicker';
import { SafetyAlertList, SeverityBadge } from './SafetyAlerts';

interface Entry {
  medication: string;
  catalogItemId?: string;
}

interface ListResult {
  medications: { medication: string; ingredients: string[] }[];
  pairwise: (SafetyAlert & { medications: string[] })[];
  patient?: { medication: string; alerts: SafetyAlert[] }[];
}

type TabId = 'checker' | 'database';

/**
 * Interaction checker: pick 2–10 medicines and see interactions and duplicate therapy between
 * them – optionally also against a patient's record (?patient=<id>). The Ministry maintains the
 * interaction database on the second tab.
 */
export function InteractionChecker() {
  const [params] = useSearchParams();
  const patientId = params.get('patient');
  const [tab, setTab] = useState<TabId>('checker');
  return (
    <>
      <PageHeader
        title={t('Interaction checker')}
        subtitle={t(
          'Check medicines for interactions, duplicate therapy and – for a patient – allergies, kidney function, age and pregnancy.',
        )}
      />
      <Tabs<TabId>
        label={t('Interaction checker')}
        active={tab}
        onChange={setTab}
        tabs={[
          { id: 'checker', label: t('Check medicines') },
          { id: 'database', label: t('Interaction database') },
        ]}
      />
      <TabPanel id={tab}>
        {tab === 'checker' ? <Checker patientId={patientId} /> : <Database />}
      </TabPanel>
    </>
  );
}

function Checker({ patientId }: { patientId: string | null }) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [free, setFree] = useState('');
  const [picked, setPicked] = useState<CatalogItem | null>(null);
  const run = useMutation({
    mutationFn: () =>
      api<ListResult>('/safety/check-list', {
        method: 'POST',
        body: { medications: entries, patientId: patientId ?? undefined },
      }),
  });

  function add(entry: Entry) {
    const name = entry.medication.trim();
    if (name.length < 2 || entries.length >= 10) return;
    if (entries.some((e) => e.medication.toLowerCase() === name.toLowerCase())) return;
    setEntries((list) => [...list, { ...entry, medication: name }]);
    run.reset();
  }

  return (
    <div className="stack">
      <Card title={t('Medicines to check')}>
        {patientId && (
          <Alert tone="info" title={t('Patient mode')}>
            {t(
              'Each medicine is also checked against this patient’s medicines, allergies, kidney function, age and pregnancy.',
            )}
          </Alert>
        )}
        <CatalogPicker
          label={t('Add from the national catalogue')}
          value={picked}
          onChange={(item) => {
            if (item) {
              add({ medication: itemName(item), catalogItemId: item.id });
              setPicked(null);
            }
          }}
        />
        <form
          className="row"
          style={{ alignItems: 'flex-end', flexWrap: 'wrap' }}
          onSubmit={(e) => {
            e.preventDefault();
            add({ medication: free });
            setFree('');
          }}
        >
          <TextField
            label={t('Or type a medicine name (also brand names)')}
            value={free}
            onChange={(e) => setFree(e.target.value)}
            maxLength={200}
          />
          <Button type="submit" variant="secondary" disabled={free.trim().length < 2}>
            {t('Add')}
          </Button>
        </form>
        {entries.length > 0 ? (
          <ul className="checker-list" aria-label={t('Medicines to check')}>
            {entries.map((e) => (
              <li key={e.medication}>
                {e.medication}
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={t('Remove {name}', { name: e.medication })}
                  onClick={() => {
                    setEntries((list) => list.filter((x) => x !== e));
                    run.reset();
                  }}
                >
                  ×
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">{t('Add at least two medicines (up to ten).')}</p>
        )}
        <div className="form-actions">
          <Button
            onClick={() => run.mutate()}
            loading={run.isPending}
            disabled={entries.length < (patientId ? 1 : 2)}
          >
            {t('Check')}
          </Button>
        </div>
        <ErrorAlert error={run.error} />
      </Card>

      {run.data && (
        <Card title={t('Results')}>
          <ul className="list">
            {run.data.medications.map((m) => (
              <li key={m.medication}>
                <strong>{m.medication}</strong>{' '}
                <span className="muted">
                  {t('Active ingredients: {list}', { list: m.ingredients.join(', ') || '—' })}
                </span>
              </li>
            ))}
          </ul>
          <h3>{t('Between these medicines')}</h3>
          {run.data.pairwise.length ? (
            <SafetyAlertList alerts={run.data.pairwise} />
          ) : (
            <Alert tone="success" title={t('No interactions found between these medicines')} />
          )}
          {run.data.patient && (
            <>
              <h3>{t('For this patient')}</h3>
              {run.data.patient.map((p) => (
                <div key={p.medication}>
                  <strong>{p.medication}</strong>
                  {p.alerts.length ? (
                    <SafetyAlertList alerts={p.alerts} />
                  ) : (
                    <p className="muted">{t('No alerts for this patient.')}</p>
                  )}
                </div>
              ))}
            </>
          )}
          <p className="muted">
            {t(
              'Decision support based on a curated demo knowledge set – not a validated clinical database. Always use professional judgement.',
            )}
          </p>
        </Card>
      )}
    </div>
  );
}

interface InteractionPage {
  items: Interaction[];
  page: number;
  totalPages: number;
  total: number;
  canEdit: boolean;
}

function Database() {
  const user = useUser();
  const [q, setQ] = useState('');
  const [severity, setSeverity] = useState<'' | AlertSeverity>('');
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<Interaction | 'new' | null>(null);
  const list = useQuery({
    queryKey: ['safety', 'interactions', q, severity, page],
    queryFn: () =>
      api<InteractionPage>('/safety/interactions', {
        query: {
          q: q || undefined,
          severity: severity || undefined,
          page,
          pageSize: 25,
          includeInactive: user.role === 'MINISTRY' ? 'true' : undefined,
        },
      }),
  });
  return (
    <Card
      title={t('Interaction database')}
      actions={
        list.data?.canEdit ? (
          <Button size="sm" onClick={() => setEditing('new')}>
            {t('Add interaction')}
          </Button>
        ) : undefined
      }
    >
      <p className="muted">
        {t(
          'Pairs of active ingredients that interact. Maintained by the Ministry of Health; the demo set is curated and not a validated clinical database.',
        )}
      </p>
      <div className="form-grid">
        <TextField
          label={t('Search ingredient')}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setPage(1);
          }}
        />
        <SelectField
          label={t('Severity')}
          value={severity}
          onChange={(e) => {
            setSeverity(e.target.value as AlertSeverity | '');
            setPage(1);
          }}
          placeholder={t('All')}
          options={SEVERITIES.map((s) => ({ value: s, label: severityLabel(s) }))}
        />
      </div>
      <QueryView query={list}>
        {(data) =>
          data.items.length === 0 ? (
            <EmptyState title={t('No interactions found')} />
          ) : (
            <>
              <Table caption={t('Interaction database')}>
                <thead>
                  <tr>
                    <th>{t('Ingredients')}</th>
                    <th>{t('Severity')}</th>
                    <th>{t('Effect')}</th>
                    <th>{t('What to do')}</th>
                    {data.canEdit && (
                      <th>
                        <span className="sr-only">{t('Actions')}</span>
                      </th>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((i) => (
                    <tr key={i.id} className={i.isActive ? undefined : 'muted'}>
                      <td>
                        <strong>{i.ingredientA}</strong> + <strong>{i.ingredientB}</strong>
                        {!i.isActive && <div className="muted">{t('Inactive')}</div>}
                      </td>
                      <td>
                        <SeverityBadge alert={i} />
                      </td>
                      <td>{i.effectTranslated}</td>
                      <td>{i.managementTranslated}</td>
                      {data.canEdit && (
                        <td>
                          <Button size="sm" variant="secondary" onClick={() => setEditing(i)}>
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
        <InteractionDialog
          interaction={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </Card>
  );
}

function InteractionDialog({
  interaction,
  onClose,
}: {
  interaction: Interaction | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      interaction
        ? api(`/safety/interactions/${interaction.id}`, { method: 'PATCH', body })
        : api('/safety/interactions', { method: 'POST', body }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['safety', 'interactions'] });
      onClose();
    },
  });

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const body: Record<string, unknown> = {
      severity: f.get('severity'),
      effect: String(f.get('effect') ?? '').trim(),
      management: String(f.get('management') ?? '').trim(),
    };
    if (interaction) body.isActive = f.get('isActive') === 'on';
    else {
      body.ingredientA = String(f.get('ingredientA') ?? '').trim();
      body.ingredientB = String(f.get('ingredientB') ?? '').trim();
    }
    save.mutate(body);
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={interaction ? t('Edit interaction') : t('Add interaction')}
      wide
    >
      <form onSubmit={onSubmit}>
        {interaction ? (
          <p>
            <strong>{interaction.ingredientA}</strong> + <strong>{interaction.ingredientB}</strong>
          </p>
        ) : (
          <div className="form-grid">
            <TextField
              label={t('First ingredient (INN)')}
              name="ingredientA"
              required
              minLength={2}
              maxLength={100}
            />
            <TextField
              label={t('Second ingredient (INN)')}
              name="ingredientB"
              required
              minLength={2}
              maxLength={100}
            />
          </div>
        )}
        <SelectField
          label={t('Severity')}
          name="severity"
          required
          defaultValue={interaction?.severity ?? 'MODERATE'}
          options={SEVERITIES.map((s) => ({ value: s, label: severityLabel(s) }))}
        />
        <TextAreaField
          label={t('Effect (English source text)')}
          name="effect"
          required
          minLength={5}
          maxLength={500}
          rows={2}
          defaultValue={interaction?.effect ?? ''}
        />
        <TextAreaField
          label={t('What to do (English source text)')}
          name="management"
          required
          minLength={5}
          maxLength={500}
          rows={2}
          defaultValue={interaction?.management ?? ''}
        />
        {interaction && (
          <label className="checkbox">
            <input type="checkbox" name="isActive" defaultChecked={interaction.isActive} />
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
