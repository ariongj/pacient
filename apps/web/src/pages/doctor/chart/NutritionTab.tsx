import { useState, type FormEvent } from 'react';
import {
  allergyLabel,
  DIET_TYPES,
  dietDescription,
  dietLabel,
  riskLabel,
  riskTone,
  useOrderDiet,
  usePatientNutrition,
  useScreen,
  type DietType,
  type PatientNutrition,
} from '../../../api/nutrition';
import {
  Alert,
  Badge,
  Button,
  Card,
  Dialog,
  EmptyState,
  ErrorAlert,
  QueryView,
  SelectField,
  Table,
  TextAreaField,
  TextField,
} from '../../../components/ui';
import { formatDateTime } from '../../../format';
import { t } from '../../../i18n';
import { useChartRole } from './shared';
import '../../nutrition/nutrition.css';

function DietDialog({
  patientId,
  data,
  open,
  onClose,
}: {
  patientId: string;
  data: PatientNutrition;
  open: boolean;
  onClose: () => void;
}) {
  const [diet, setDiet] = useState<DietType>(data.current?.dietType ?? 'NORMAL');
  const order = useOrderDiet(patientId, onClose);
  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const restrictions = String(f.get('restrictions') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const fluid = String(f.get('fluidLimitMl') ?? '').trim();
    order.mutate({
      admissionId: data.admission!.id,
      dietType: diet,
      restrictions,
      fluidLimitMl: fluid ? Number(fluid) : null,
      notes: String(f.get('notes') ?? '').trim() || null,
      reason: String(f.get('reason') ?? '').trim() || null,
    });
  }
  return (
    <Dialog open={open} onClose={onClose} title={t('Order diet')} wide>
      <form onSubmit={onSubmit}>
        <div className="form-grid">
          <SelectField
            label={t('Diet')}
            required
            value={diet}
            onChange={(e) => setDiet(e.currentTarget.value as DietType)}
            options={DIET_TYPES.map((d) => ({ value: d, label: dietLabel(d) }))}
          />
          <TextField
            label={t('Fluid limit (ml per day)')}
            name="fluidLimitMl"
            type="number"
            min={100}
            max={10000}
            defaultValue={data.current?.fluidLimitMl ?? ''}
          />
        </div>
        <p className="muted">{dietDescription(diet)}</p>
        <TextField
          label={t('Restrictions')}
          name="restrictions"
          hint={t('Separate with commas, e.g. no pork, no added sugar')}
          defaultValue={data.current?.restrictions?.join(', ') ?? ''}
          maxLength={600}
        />
        <TextField label={t('Reason')} name="reason" maxLength={300} />
        <TextAreaField label={t('Note for the kitchen')} name="notes" maxLength={500} rows={2} />
        {data.foodAllergies.length > 0 && (
          <Alert
            tone="warning"
            title={t('Food allergies are added to the meal list automatically')}
          >
            {data.foodAllergies.map(allergyLabel).join(', ')}
          </Alert>
        )}
        <ErrorAlert error={order.error} />
        <div className="form-actions">
          <Button variant="secondary" onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button type="submit" loading={order.isPending}>
            {t('Save diet')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

const NRS_STATUS = [
  { v: 0, label: () => t('Normal nutritional status') },
  {
    v: 1,
    label: () =>
      t('Mild: weight loss >5 % in 3 months, or intake 50–75 % of normal in the last week'),
  },
  {
    v: 2,
    label: () =>
      t(
        'Moderate: weight loss >5 % in 2 months, or BMI 18.5–20.5 and impaired condition, or intake 25–60 %',
      ),
  },
  {
    v: 3,
    label: () =>
      t(
        'Severe: weight loss >5 % in 1 month, or BMI <18.5 and impaired condition, or intake 0–25 %',
      ),
  },
];
const NRS_SEVERITY = [
  { v: 0, label: () => t('Normal nutritional requirements') },
  {
    v: 1,
    label: () => t('Mild: hip fracture, chronic disease with complications, diabetes, cancer'),
  },
  { v: 2, label: () => t('Moderate: major abdominal surgery, stroke, severe pneumonia') },
  {
    v: 3,
    label: () => t('Severe: head injury, bone-marrow transplant, intensive care (APACHE >10)'),
  },
];
const KIDS = [
  {
    key: 'poorNutritionalStatus',
    points: 1,
    label: () => t('Poor nutritional status on clinical assessment'),
  },
  {
    key: 'highRiskDisease',
    points: 2,
    label: () =>
      t('Underlying illness with a high risk of malnutrition, or major surgery expected'),
  },
  {
    key: 'intakeOrLosses',
    points: 1,
    label: () =>
      t(
        'Excessive diarrhoea or vomiting, reduced intake, earlier nutritional support, or pain affecting intake',
      ),
  },
  {
    key: 'weightLoss',
    points: 1,
    label: () => t('Weight loss, or no weight gain in infants, in recent weeks'),
  },
];

function ScreeningDialog({
  patientId,
  data,
  open,
  onClose,
}: {
  patientId: string;
  data: PatientNutrition;
  open: boolean;
  onClose: () => void;
}) {
  const child = data.recommendedTool === 'STRONGKIDS';
  const [status, setStatus] = useState(0);
  const [severity, setSeverity] = useState(0);
  const [kids, setKids] = useState<Record<string, boolean>>({});
  const screen = useScreen(patientId, onClose);
  const ageAdj = !child && data.ageYears >= 70 ? 1 : 0;
  const score = child
    ? KIDS.reduce((s, k) => s + (kids[k.key] ? k.points : 0), 0)
    : status + severity + ageAdj;
  const risk = child
    ? score === 0
      ? 'LOW'
      : score <= 3
        ? 'MEDIUM'
        : 'HIGH'
    : score >= 3
      ? 'HIGH'
      : 'LOW';
  function submit() {
    screen.mutate(
      child
        ? {
            tool: 'STRONGKIDS',
            answers: Object.fromEntries(KIDS.map((k) => [k.key, Boolean(kids[k.key])])),
          }
        : { tool: 'NRS2002', answers: { nutritionalStatus: status, diseaseSeverity: severity } },
    );
  }
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={child ? t('Nutrition screening (STRONGkids)') : t('Nutrition screening (NRS-2002)')}
      wide
    >
      <div className="nutrition-steps">
        {child ? (
          <fieldset>
            <legend>{t('Questions')}</legend>
            {KIDS.map((k) => (
              <label key={k.key} className="checkbox">
                <input
                  type="checkbox"
                  checked={Boolean(kids[k.key])}
                  onChange={(e) => setKids((s) => ({ ...s, [k.key]: e.currentTarget.checked }))}
                />
                <span>
                  {k.label()} <span className="muted">({t('{n} points', { n: k.points })})</span>
                </span>
              </label>
            ))}
          </fieldset>
        ) : (
          <>
            <fieldset>
              <legend>{t('Impaired nutritional status')}</legend>
              {NRS_STATUS.map((o) => (
                <label key={o.v} className="checkbox">
                  <input
                    type="radio"
                    name="status"
                    checked={status === o.v}
                    onChange={() => setStatus(o.v)}
                  />
                  <span>
                    <strong>{o.v}</strong> – {o.label()}
                  </span>
                </label>
              ))}
            </fieldset>
            <fieldset>
              <legend>{t('Severity of disease')}</legend>
              {NRS_SEVERITY.map((o) => (
                <label key={o.v} className="checkbox">
                  <input
                    type="radio"
                    name="severity"
                    checked={severity === o.v}
                    onChange={() => setSeverity(o.v)}
                  />
                  <span>
                    <strong>{o.v}</strong> – {o.label()}
                  </span>
                </label>
              ))}
            </fieldset>
            {ageAdj > 0 && <p className="muted">{t('Age 70 or older: +1 point.')}</p>}
          </>
        )}
      </div>
      <p>
        {t('Score')}: <span className="nutrition-score">{score}</span>{' '}
        <Badge tone={riskTone(risk)}>{riskLabel(risk)}</Badge>
      </p>
      {risk === 'HIGH' && (
        <Alert tone="warning">
          {t(
            'At risk of malnutrition: the attending doctor will be notified to arrange a dietitian review.',
          )}
        </Alert>
      )}
      <ErrorAlert error={screen.error} />
      <div className="form-actions">
        <Button variant="secondary" onClick={onClose}>
          {t('Cancel')}
        </Button>
        <Button loading={screen.isPending} onClick={submit}>
          {t('Save screening')}
        </Button>
      </div>
    </Dialog>
  );
}

/** Diet, food allergies, fasting before surgery and malnutrition screening for one patient. */
export function NutritionTab({ patientId }: { patientId: string }) {
  const q = usePatientNutrition(patientId);
  const { isDoctor, isNurse } = useChartRole();
  const canWrite = isDoctor || isNurse;
  const [ordering, setOrdering] = useState(false);
  const [screening, setScreening] = useState(false);
  return (
    <QueryView query={q}>
      {(d) => (
        <div className="stack">
          <Card
            title={t('Diet')}
            actions={
              canWrite && d.admission ? (
                <Button size="sm" onClick={() => setOrdering(true)}>
                  {t('Change diet')}
                </Button>
              ) : undefined
            }
          >
            {!d.admission ? (
              <p className="muted">{t('Diets are ordered during a hospital stay.')}</p>
            ) : (
              <>
                <p>
                  <strong>{dietLabel(d.current?.dietType ?? 'NORMAL')}</strong>
                  {!d.current && <span className="muted"> – {t('no diet ordered yet')}</span>}
                </p>
                {d.current?.restrictions?.length ? (
                  <p className="nutrition-tags">
                    {d.current.restrictions.map((r) => (
                      <Badge key={r} tone="warning">
                        {r}
                      </Badge>
                    ))}
                  </p>
                ) : null}
                {d.current?.fluidLimitMl ? (
                  <p>{t('Fluids max {ml} ml/day', { ml: d.current.fluidLimitMl })}</p>
                ) : null}
              </>
            )}
            {d.npo && (
              <Alert
                tone="danger"
                title={t('Fasting before operation: {procedure}', { procedure: d.npo.procedure })}
              >
                {t('No food from {time}, no fluids from {fluids} (operation at {at}).', {
                  time: d.npo.solidsFromLocal,
                  fluids: d.npo.fluidsFromLocal,
                  at: formatDateTime(d.npo.operationAt),
                })}
              </Alert>
            )}
            {d.foodAllergies.length > 0 && (
              <p className="nutrition-tags">
                {d.foodAllergies.map((a) => (
                  <Badge key={a} tone="danger">
                    {t('Allergy: {allergen}', { allergen: allergyLabel(a) })}
                  </Badge>
                ))}
              </p>
            )}
          </Card>

          {d.screeningState !== null && (
            <Card
              title={t('Malnutrition screening')}
              actions={
                canWrite ? (
                  <Button size="sm" variant="secondary" onClick={() => setScreening(true)}>
                    {t('Screen now')}
                  </Button>
                ) : undefined
              }
            >
              {d.screeningState !== 'DONE' && (
                <Alert tone={d.screeningState === 'OVERDUE' ? 'danger' : 'warning'}>
                  {d.screeningState === 'OVERDUE'
                    ? t('Screening is overdue: it should be done within 48 hours of admission.')
                    : t('Screening is due within 48 hours of admission.')}
                </Alert>
              )}
              {d.screenings.length === 0 ? (
                <EmptyState title={t('No screenings yet')} />
              ) : (
                <Table caption={t('Malnutrition screenings')}>
                  <thead>
                    <tr>
                      <th>{t('Date')}</th>
                      <th>{t('Tool')}</th>
                      <th>{t('Score')}</th>
                      <th>{t('Risk')}</th>
                      <th>{t('By')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.screenings.map((s) => (
                      <tr key={s.id}>
                        <td>{formatDateTime(s.screenedAt)}</td>
                        <td>
                          {s.tool === 'STRONGKIDS'
                            ? 'STRONGkids'
                            : s.tool === 'NRS2002'
                              ? 'NRS-2002'
                              : 'MUST'}
                        </td>
                        <td>{s.score}</td>
                        <td>
                          <Badge tone={riskTone(s.risk)}>{riskLabel(s.risk)}</Badge>
                        </td>
                        <td>{s.screenedBy}</td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </Card>
          )}

          <Card title={t('Diet history')}>
            {d.history.length === 0 ? (
              <EmptyState title={t('No diet orders')} />
            ) : (
              <Table caption={t('Diet history')}>
                <thead>
                  <tr>
                    <th>{t('Diet')}</th>
                    <th>{t('From')}</th>
                    <th>{t('Until')}</th>
                    <th>{t('Ordered by')}</th>
                  </tr>
                </thead>
                <tbody>
                  {d.history.map((h) => (
                    <tr key={h.id}>
                      <td>
                        {dietLabel(h.dietType)}
                        {h.reason && <div className="muted">{h.reason}</div>}
                      </td>
                      <td>{formatDateTime(h.startsAt)}</td>
                      <td>{h.endsAt ? formatDateTime(h.endsAt) : t('Current')}</td>
                      <td>{h.orderedBy}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>

          {ordering && d.admission && (
            <DietDialog patientId={patientId} data={d} open onClose={() => setOrdering(false)} />
          )}
          {screening && (
            <ScreeningDialog
              patientId={patientId}
              data={d}
              open
              onClose={() => setScreening(false)}
            />
          )}
        </div>
      )}
    </QueryView>
  );
}
