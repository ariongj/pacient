import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/client';
import {
  allergyLabel,
  DIET_TYPES,
  dietDescription,
  dietLabel,
  mealLabel,
  MEALS,
  riskLabel,
  riskTone,
  todayIso,
  useKitchen,
  useScreeningDue,
  useWard,
  type DietLine,
  type Meal,
} from '../../api/nutrition';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Grid,
  PageHeader,
  QueryView,
  SelectField,
  Stat,
  TabPanel,
  Table,
  Tabs,
  TextField,
} from '../../components/ui';
import { formatDateTime, formatFullDate } from '../../format';
import { t, tn } from '../../i18n';
import './nutrition.css';

type Tab = 'kitchen' | 'ward' | 'due' | 'legend';
const WARD_TYPES = 'GENERAL_WARD,SURGICAL_WARD,ICU,MATERNITY,PAEDIATRIC,NEONATAL';

/** Patient name; unidentified patients show their temporary code. */
const nameOf = (l: { patientName: string; temporaryIdentity?: string | null }) =>
  l.temporaryIdentity === 'UNIDENTIFIED'
    ? t('Unknown patient {code}', { code: l.patientName.split(' ').slice(1).join(' ') })
    : l.patientName;

function NpoBadge({ line }: { line: Pick<DietLine, 'npo'> }) {
  if (!line.npo) return null;
  return (
    <Badge tone="danger">
      {line.npo.level === 'FULL'
        ? t('Nothing by mouth (operation)')
        : t('No food from {time} · clear fluids until {fluids}', {
            time: line.npo.solidsFromLocal,
            fluids: line.npo.fluidsFromLocal,
          })}
    </Badge>
  );
}

function Restrictions({ line }: { line: Pick<DietLine, 'restrictions' | 'foodAllergies' | 'fluidLimitMl'> }) {
  if (!line.restrictions.length && !line.foodAllergies.length && !line.fluidLimitMl) return <>—</>;
  return (
    <div className="nutrition-tags">
      {line.foodAllergies.map((a) => (
        <Badge key={`a-${a}`} tone="danger">
          {t('Allergy: {allergen}', { allergen: allergyLabel(a) })}
        </Badge>
      ))}
      {line.restrictions.map((r) => (
        <Badge key={`r-${r}`} tone="warning">
          {r}
        </Badge>
      ))}
      {line.fluidLimitMl ? (
        <Badge tone="info">{t('Fluids max {ml} ml/day', { ml: line.fluidLimitMl })}</Badge>
      ) : null}
    </div>
  );
}

function KitchenTab() {
  const [meal, setMeal] = useState<Meal>(() => {
    const h = new Date().getHours();
    return h < 10 ? 'BREAKFAST' : h < 15 ? 'LUNCH' : 'DINNER';
  });
  const [date, setDate] = useState(todayIso());
  const list = useKitchen(meal, date);
  return (
    <div className="stack">
      <div className="search-bar no-print">
        <SelectField
          label={t('Meal')}
          value={meal}
          onChange={(e) => setMeal(e.currentTarget.value as Meal)}
          options={MEALS.map((m) => ({ value: m, label: mealLabel(m) }))}
        />
        <TextField
          label={t('Date')}
          type="date"
          value={date}
          onChange={(e) => setDate(e.currentTarget.value || todayIso())}
        />
        <Button variant="secondary" onClick={() => window.print()}>
          {t('Print meal list')}
        </Button>
      </div>
      <QueryView query={list}>
        {(k) => (
          <>
            <h2 className="print-only">
              {t('Meal list')} · {mealLabel(k.meal)} {k.mealTime} · {formatFullDate(new Date(k.servedAt))}
            </h2>
            <Card title={t('Totals to prepare')}>
              <Grid min={150}>
                <Stat label={t('Patients')} value={k.count} />
                {Object.entries(k.totals)
                  .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
                  .map(([diet, n]) => (
                    <Stat
                      key={diet}
                      label={dietLabel(diet)}
                      value={n ?? 0}
                      tone={diet === 'NIL_BY_MOUTH' ? 'danger' : undefined}
                    />
                  ))}
              </Grid>
            </Card>
            {k.wards.length === 0 ? (
              <EmptyState title={t('No admitted patients')} />
            ) : (
              k.wards.map((w) => (
                <Card
                  key={w.unitId}
                  title={`${w.unitName} · ${tn(w.patients.length, '{count} patient', '{count} patients')}`}
                >
                  <Table caption={t('Meal list for {ward}', { ward: w.unitName })}>
                    <thead>
                      <tr>
                        <th>{t('Bed')}</th>
                        <th>{t('Patient')}</th>
                        <th>{t('Diet')}</th>
                        <th>{t('Restrictions and allergies')}</th>
                        <th>{t('Note')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {w.patients.map((p) => (
                        <tr key={p.admissionId} className={p.npo ? 'nutrition-npo' : undefined}>
                          <td>{p.bedLabel ?? t('No bed')}</td>
                          <td>
                            <strong>{nameOf(p)}</strong>
                            <div className="muted">{t('{age} y', { age: p.ageYears })}</div>
                          </td>
                          <td>
                            <strong>{dietLabel(p.dietType)}</strong>
                            {!p.hasOrder && !p.npo && (
                              <div className="muted">{t('No diet ordered – normal menu')}</div>
                            )}
                            <div>
                              <NpoBadge line={p} />
                            </div>
                          </td>
                          <td>
                            <Restrictions line={p} />
                          </td>
                          <td>{p.notes ?? '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                </Card>
              ))
            )}
          </>
        )}
      </QueryView>
    </div>
  );
}

function WardTab() {
  const units = useQuery({
    queryKey: ['hospital', 'units', 'wards'],
    queryFn: () =>
      api<{ items: { id: string; name: string }[] }>('/hospital/units', {
        query: { type: WARD_TYPES },
      }).then((r) => r.items),
  });
  const [unitId, setUnitId] = useState<string>('');
  const selected = unitId || units.data?.[0]?.id;
  const ward = useWard(selected);
  return (
    <div className="stack">
      <QueryView query={units}>
        {(list) =>
          list.length === 0 ? (
            <EmptyState title={t('No wards are set up at this facility')} />
          ) : (
            <SelectField
              label={t('Ward')}
              value={selected}
              onChange={(e) => setUnitId(e.currentTarget.value)}
              options={list.map((u) => ({ value: u.id, label: u.name }))}
            />
          )
        }
      </QueryView>
      {selected && (
        <QueryView query={ward}>
          {(items) =>
            items.length === 0 ? (
              <EmptyState title={t('No admitted patients')} />
            ) : (
              <Table caption={t('Nutrition on the ward')}>
                <thead>
                  <tr>
                    <th>{t('Bed')}</th>
                    <th>{t('Patient')}</th>
                    <th>{t('Diet')}</th>
                    <th>{t('Restrictions and allergies')}</th>
                    <th>{t('Screening')}</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((p) => (
                    <tr key={p.admissionId}>
                      <td>{p.bedLabel ?? t('No bed')}</td>
                      <td>
                        <Link to={`/doctor/patients/${p.patientId}?tab=nutrition`}>{nameOf(p)}</Link>
                        <div className="muted">{t('{age} y', { age: p.ageYears })}</div>
                      </td>
                      <td>
                        {dietLabel(p.dietType)}
                        <div>
                          <NpoBadge line={p} />
                        </div>
                      </td>
                      <td>
                        <Restrictions line={p} />
                      </td>
                      <td>
                        {p.screening && (
                          <Badge tone={riskTone(p.screening.risk)}>
                            {riskLabel(p.screening.risk)} ({p.screening.score})
                          </Badge>
                        )}
                        {p.screeningState !== 'DONE' && (
                          <Badge tone={p.screeningState === 'OVERDUE' ? 'danger' : 'warning'}>
                            {p.screeningState === 'OVERDUE' ? t('Screening overdue') : t('Screening due')}
                          </Badge>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )
          }
        </QueryView>
      )}
    </div>
  );
}

function DueTab() {
  const due = useScreeningDue();
  return (
    <QueryView query={due}>
      {(items) =>
        items.length === 0 ? (
          <EmptyState title={t('All admitted patients have been screened')} />
        ) : (
          <Table caption={t('Nutrition screening due')}>
            <thead>
              <tr>
                <th>{t('Patient')}</th>
                <th>{t('Ward')}</th>
                <th>{t('Admitted')}</th>
                <th>{t('Due by')}</th>
                <th>{t('Tool')}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((i) => (
                <tr key={i.admissionId}>
                  <td>
                    <Link to={`/doctor/patients/${i.patientId}?tab=nutrition`}>{i.patientName}</Link>
                    <div className="muted">{t('{age} y', { age: i.ageYears })}</div>
                  </td>
                  <td>
                    {i.unitName}
                    {i.bedLabel ? ` · ${i.bedLabel}` : ''}
                  </td>
                  <td>{formatDateTime(i.admittedAt)}</td>
                  <td>
                    {formatDateTime(i.dueBy)}{' '}
                    {i.screeningState === 'OVERDUE' && <Badge tone="danger">{t('Overdue')}</Badge>}
                  </td>
                  <td>{i.recommendedTool === 'STRONGKIDS' ? 'STRONGkids' : 'NRS-2002'}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )
      }
    </QueryView>
  );
}

function LegendTab() {
  return (
    <Card title={t('Diet types')}>
      <ul className="list">
        {DIET_TYPES.map((d) => (
          <li key={d}>
            <strong>{dietLabel(d)}</strong> – <span className="muted">{dietDescription(d)}</span>
          </li>
        ))}
      </ul>
      <p className="muted">
        {t(
          'Before a scheduled operation patients automatically get nothing to eat from 6 hours and nothing to drink from 2 hours before, unless the doctor orders otherwise. The normal diet resumes when the operation is completed or cancelled.',
        )}
      </p>
    </Card>
  );
}

/** Kitchen meal lists, ward nutrition overview and screenings due. */
export function NutritionPage() {
  const [tab, setTab] = useState<Tab>('kitchen');
  return (
    <>
      <PageHeader
        title={t('Nutrition')}
        subtitle={t('Diets, meal lists for the kitchen and malnutrition screening.')}
      />
      <div className="no-print">
        <Tabs<Tab>
          label={t('Nutrition sections')}
          active={tab}
          onChange={setTab}
          tabs={[
            { id: 'kitchen', label: t('Meal list') },
            { id: 'ward', label: t('Ward overview') },
            { id: 'due', label: t('Screening due') },
            { id: 'legend', label: t('Diet types') },
          ]}
        />
      </div>
      <TabPanel id={tab}>
        {tab === 'kitchen' && <KitchenTab />}
        {tab === 'ward' && <WardTab />}
        {tab === 'due' && <DueTab />}
        {tab === 'legend' && <LegendTab />}
      </TabPanel>
    </>
  );
}
