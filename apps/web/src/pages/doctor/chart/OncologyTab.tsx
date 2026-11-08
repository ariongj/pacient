import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '../../../api/client';
import {
  BASES_OF_DIAGNOSIS,
  BASIS_LABEL,
  ICD10_CANCER,
  LATERALITIES,
  LATERALITY_LABEL,
  MORPHOLOGY,
  RECOMMENDATION_LABEL,
  REVIEW_STATUS_LABEL,
  REVIEW_TONE,
  STAGE_LABEL,
  STAGES,
  TOPOGRAPHY,
  TUMOUR_GROUP_LABEL,
  WARNING_LABEL,
  useAddToMeeting,
  useMarkDuplicate,
  useMarkInformed,
  useMeetings,
  useOncologyDefinitions,
  usePatientOncology,
  useRegisterCancer,
  useUpdateCancer,
  useWithdrawCancer,
  type BasisOfDiagnosis,
  type CancerCase,
  type CaseFields,
  type CaseWarning,
  type ChartReview,
  type Definitions,
  type Laterality,
  type Stage,
} from '../../../api/oncology';
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
  compact,
  formValues,
} from '../../../components/ui';
import { formatDate, formatDateTime } from '../../../format';
import { t } from '../../../i18n';
import { useChartRole } from './shared';

const today = () => new Date().toISOString().slice(0, 10);

function siteLabel(defs: Definitions | undefined, topography: string) {
  const g = defs?.siteGroups.find((s) => s.code === topography.slice(0, 3));
  return g ? t(g.label) : null;
}
function morphologyLabel(defs: Definitions | undefined, code: string) {
  const m = defs?.morphologies.find((x) => x.code === code);
  return m ? t(m.label) : null;
}
const tnm = (c: { tnmT?: string | null; tnmN?: string | null; tnmM?: string | null }) =>
  [c.tnmT, c.tnmN, c.tnmM].filter(Boolean).join(' ') || null;

function Warnings({ warnings }: { warnings: CaseWarning[] }) {
  if (!warnings.length) return null;
  return (
    <Alert tone="warning" title={t('Check the coding')}>
      <ul>
        {warnings.map((w, i) => (
          <li key={`${w.code}-${i}`}>{t(WARNING_LABEL[w.code] ?? w.message)}</li>
        ))}
      </ul>
    </Alert>
  );
}

/* ------------------------------------------------------------------ register ------------ */

function RegisterDialog({
  patientId,
  defs,
  open,
  onClose,
}: {
  patientId: string;
  defs: Definitions;
  open: boolean;
  onClose: () => void;
}) {
  const register = useRegisterCancer(patientId);
  const [group, setGroup] = useState('');
  const [topography, setTopography] = useState('');
  const [icd10, setIcd10] = useState('');
  const [laterality, setLaterality] = useState<Laterality | ''>('');
  const [pending, setPending] = useState<(CaseFields & { duplicateOn?: string }) | null>(null);
  const [created, setCreated] = useState<CancerCase | null>(null);
  const paired = defs.pairedSiteGroups.includes(topography.slice(0, 3) || group);

  const close = () => {
    register.reset();
    setPending(null);
    setCreated(null);
    setGroup('');
    setTopography('');
    setIcd10('');
    setLaterality('');
    onClose();
  };
  const send = (body: CaseFields, confirmNotDuplicate = false) =>
    register.mutate(
      { ...body, confirmNotDuplicate },
      {
        onSuccess: (c) => {
          setPending(null);
          setCreated(c);
        },
        onError: (e) => {
          if (e instanceof ApiError && e.code === 'POSSIBLE_DUPLICATE') {
            const d = e.details as { diagnosedOn?: string } | undefined;
            setPending({ ...body, duplicateOn: d?.diagnosedOn });
          }
        },
      },
    );

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const v = formValues(e.currentTarget);
    const body = compact({
      diagnosedOn: v.diagnosedOn,
      icd10: v.icd10?.toUpperCase(),
      topography: v.topography?.toUpperCase(),
      morphology: v.morphology,
      laterality: (v.laterality || 'NOT_APPLICABLE') as Laterality,
      basisOfDiagnosis: v.basisOfDiagnosis as BasisOfDiagnosis,
      tnmT: v.tnmT,
      tnmN: v.tnmN,
      tnmM: v.tnmM,
      stage: (v.stage || undefined) as Stage | undefined,
      tnmEdition: v.tnmEdition,
    }) as CaseFields;
    send(body);
  };

  const duplicate =
    register.error instanceof ApiError && register.error.code === 'POSSIBLE_DUPLICATE';
  return (
    <Dialog open={open} onClose={close} title={t('Register a cancer')} wide>
      {created ? (
        <div className="stack">
          <Alert tone="success" title={t('The cancer was registered')} />
          <Warnings warnings={created.warnings} />
          <div className="form-actions">
            <Button onClick={close}>{t('Close')}</Button>
          </div>
        </div>
      ) : pending ? (
        <div className="stack">
          <Alert tone="warning" title={t('Possible duplicate registration')}>
            {t(
              'A cancer of the same site was registered for this patient on {date}, within three months. Register this one only if it is a different primary tumour (for example the other side).',
              { date: formatDate(pending.duplicateOn ?? null) },
            )}
          </Alert>
          <div className="form-actions">
            <Button variant="secondary" onClick={close}>
              {t('Do not register')}
            </Button>
            <Button loading={register.isPending} onClick={() => send(pending, true)}>
              {t('It is a different primary tumour – register')}
            </Button>
          </div>
        </div>
      ) : (
        <form className="stack" onSubmit={submit}>
          <p className="muted">
            {t(
              'Register each primary tumour once, coded with ICD-O-3. Metastases and recurrences are not new registrations.',
            )}
          </p>
          <div className="form-grid">
            <TextField
              label={t('Date of diagnosis')}
              name="diagnosedOn"
              type="date"
              max={today()}
              defaultValue={today()}
              required
              hint={t('Date of the first histological or cytological confirmation')}
            />
            <SelectField
              label={t('Site group')}
              value={group}
              placeholder={t('Choose the site')}
              options={defs.siteGroups.map((s) => ({
                value: s.code,
                label: `${s.code} – ${t(s.label)}`,
              }))}
              onChange={(e) => {
                const g = e.target.value;
                setGroup(g);
                if (!topography.startsWith(g)) setTopography(g ? `${g}.9` : '');
                if (g && !icd10) setIcd10(g === 'C44' ? '' : g);
              }}
            />
            <TextField
              label={t('Topography (ICD-O-3)')}
              name="topography"
              value={topography}
              onChange={(e) => setTopography(e.target.value.toUpperCase())}
              pattern={TOPOGRAPHY.source}
              placeholder="C50.4"
              required
              hint={t('Subsite after the dot; .9 when not specified')}
            />
            <TextField
              label={t('ICD-10 code')}
              name="icd10"
              value={icd10}
              onChange={(e) => setIcd10(e.target.value.toUpperCase())}
              pattern={ICD10_CANCER.source}
              placeholder="C50.4"
              required
              hint={t('C00–C97 or D00–D09')}
            />
            <TextField
              label={t('Morphology (ICD-O-3)')}
              name="morphology"
              list="oncology-morphologies"
              pattern={MORPHOLOGY.source}
              placeholder="8500/3"
              required
              hint={t('Histology code with behaviour: /2 in situ, /3 malignant')}
            />
            <datalist id="oncology-morphologies">
              {defs.morphologies.map((m) => (
                <option key={m.code} value={m.code}>
                  {t(m.label)}
                </option>
              ))}
            </datalist>
            <SelectField
              label={t('Laterality')}
              name="laterality"
              value={laterality}
              onChange={(e) => setLaterality(e.target.value as Laterality)}
              required={paired}
              placeholder={paired ? t('Choose the side') : t('Not a paired organ')}
              options={LATERALITIES.filter((l) => l !== 'NOT_APPLICABLE').map((l) => ({
                value: l,
                label: t(LATERALITY_LABEL[l]),
              }))}
              hint={paired ? t('Required for a paired organ') : undefined}
            />
            <SelectField
              label={t('Basis of diagnosis')}
              name="basisOfDiagnosis"
              required
              defaultValue="HISTOLOGY"
              options={BASES_OF_DIAGNOSIS.filter((b) => b !== 'DEATH_CERTIFICATE_ONLY').map(
                (b) => ({
                  value: b,
                  label: t(BASIS_LABEL[b]),
                }),
              )}
            />
          </div>
          <fieldset className="form-grid">
            <legend>{t('TNM and stage (optional)')}</legend>
            <TextField label="T" name="tnmT" placeholder="cT2" maxLength={6} />
            <TextField label="N" name="tnmN" placeholder="N1" maxLength={6} />
            <TextField label="M" name="tnmM" placeholder="M0" maxLength={6} />
            <SelectField
              label={t('Stage')}
              name="stage"
              placeholder={t('Not staged yet')}
              options={STAGES.map((s) => ({ value: s, label: t(STAGE_LABEL[s]) }))}
            />
            <TextField label={t('TNM edition')} name="tnmEdition" defaultValue="8" maxLength={10} />
          </fieldset>
          {!duplicate && <ErrorAlert error={register.error} />}
          <div className="form-actions">
            <Button variant="secondary" onClick={close}>
              {t('Cancel')}
            </Button>
            <Button type="submit" loading={register.isPending}>
              {t('Register')}
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

/* ------------------------------------------------------------------ change ------------- */

type CaseAction = { kind: 'stage' | 'withdraw' | 'duplicate'; c: CancerCase };

function CaseActionDialog({
  patientId,
  action,
  cases,
  onClose,
}: {
  patientId: string;
  action: CaseAction | null;
  cases: CancerCase[];
  onClose: () => void;
}) {
  const update = useUpdateCancer(patientId);
  const withdraw = useWithdrawCancer(patientId);
  const duplicate = useMarkDuplicate(patientId);
  const [warnings, setWarnings] = useState<CaseWarning[] | null>(null);
  const close = () => {
    update.reset();
    withdraw.reset();
    duplicate.reset();
    setWarnings(null);
    onClose();
  };
  if (!action) return null;
  const { c } = action;
  const others = cases.filter((x) => x.id !== c.id && x.status === 'ACTIVE');
  const title =
    action.kind === 'stage'
      ? t('Update staging')
      : action.kind === 'withdraw'
        ? t('Withdraw the registration')
        : t('Mark as duplicate');
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const v = formValues(e.currentTarget);
    if (action.kind === 'stage') {
      update.mutate(
        {
          id: c.id,
          tnmT: v.tnmT || null,
          tnmN: v.tnmN || null,
          tnmM: v.tnmM || null,
          stage: (v.stage || null) as Stage | null,
          tnmEdition: v.tnmEdition || null,
        },
        {
          onSuccess: (r) => (r.warnings.length ? setWarnings(r.warnings) : close()),
        },
      );
    } else if (action.kind === 'withdraw') {
      withdraw.mutate({ id: c.id, reason: v.reason! }, { onSuccess: close });
    } else {
      duplicate.mutate(
        { id: c.id, duplicateOfId: v.duplicateOfId!, reason: v.reason! },
        { onSuccess: close },
      );
    }
  };
  const pending = update.isPending || withdraw.isPending || duplicate.isPending;
  return (
    <Dialog open onClose={close} title={title}>
      {warnings ? (
        <div className="stack">
          <Alert tone="success" title={t('Saved')} />
          <Warnings warnings={warnings} />
          <div className="form-actions">
            <Button onClick={close}>{t('Close')}</Button>
          </div>
        </div>
      ) : (
        <form className="stack" onSubmit={submit}>
          {action.kind === 'stage' && (
            <div className="form-grid">
              <TextField label="T" name="tnmT" defaultValue={c.tnmT ?? ''} maxLength={6} />
              <TextField label="N" name="tnmN" defaultValue={c.tnmN ?? ''} maxLength={6} />
              <TextField label="M" name="tnmM" defaultValue={c.tnmM ?? ''} maxLength={6} />
              <SelectField
                label={t('Stage')}
                name="stage"
                defaultValue={c.stage ?? ''}
                placeholder={t('Not staged yet')}
                options={STAGES.map((s) => ({ value: s, label: t(STAGE_LABEL[s]) }))}
              />
              <TextField
                label={t('TNM edition')}
                name="tnmEdition"
                defaultValue={c.tnmEdition ?? '8'}
                maxLength={10}
              />
            </div>
          )}
          {action.kind === 'withdraw' && (
            <p>
              {t(
                'Withdraw only a registration made in error (for example a benign tumour after pathology review). It stays in the audit log but no longer counts in the statistics.',
              )}
            </p>
          )}
          {action.kind === 'duplicate' &&
            (others.length === 0 ? (
              <Alert tone="info">{t('The patient has no other active registration.')}</Alert>
            ) : (
              <SelectField
                label={t('Duplicate of')}
                name="duplicateOfId"
                required
                options={others.map((o) => ({
                  value: o.id,
                  label: `${o.topography} · ${o.morphology} · ${formatDate(o.diagnosedOn)}`,
                }))}
              />
            ))}
          {action.kind !== 'stage' && (
            <TextAreaField
              label={t('Reason')}
              name="reason"
              required
              minLength={10}
              maxLength={500}
              rows={3}
              hint={t('At least {count} characters. Recorded in the audit log.', { count: 10 })}
            />
          )}
          <ErrorAlert error={update.error ?? withdraw.error ?? duplicate.error} />
          <div className="form-actions">
            <Button variant="secondary" onClick={close}>
              {t('Cancel')}
            </Button>
            <Button
              type="submit"
              variant={action.kind === 'stage' ? 'primary' : 'danger'}
              loading={pending}
              disabled={action.kind === 'duplicate' && others.length === 0}
            >
              {action.kind === 'stage' ? t('Save') : title}
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

/* ------------------------------------------------------------------ tumour board -------- */

function AddToBoardDialog({
  patientId,
  cases,
  open,
  onClose,
}: {
  patientId: string;
  cases: CancerCase[];
  open: boolean;
  onClose: () => void;
}) {
  const meetings = useMeetings('upcoming');
  const add = useAddToMeeting(patientId);
  const close = () => {
    add.reset();
    onClose();
  };
  const planned = (meetings.data?.items ?? []).filter((m) => m.status === 'PLANNED');
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const v = formValues(e.currentTarget);
    add.mutate(
      {
        meetingId: v.meetingId!,
        cancerCaseId: v.cancerCaseId || undefined,
        question: v.question!,
        summary: v.summary || undefined,
      },
      { onSuccess: close },
    );
  };
  return (
    <Dialog open={open} onClose={close} title={t('Add to a tumour board')} wide>
      <QueryView query={meetings}>
        {() =>
          planned.length === 0 ? (
            <div className="stack">
              <EmptyState title={t('No tumour board is planned')}>
                {t('Schedule a meeting on the Cancer registry page first.')}
              </EmptyState>
              <div className="form-actions">
                <Link to="/oncology">{t('Open the cancer registry')}</Link>
              </div>
            </div>
          ) : (
            <form className="stack" onSubmit={submit}>
              <SelectField
                label={t('Meeting')}
                name="meetingId"
                required
                options={planned.map((m) => ({
                  value: m.id,
                  label: `${formatDateTime(m.scheduledFor)} · ${t(TUMOUR_GROUP_LABEL[m.tumourGroup])} · ${m.chair ?? ''}`,
                }))}
              />
              <SelectField
                label={t('Cancer')}
                name="cancerCaseId"
                placeholder={t('Not linked to a registration')}
                options={cases
                  .filter((c) => c.status === 'ACTIVE')
                  .map((c) => ({
                    value: c.id,
                    label: `${c.topography} · ${c.morphology} · ${formatDate(c.diagnosedOn)}`,
                  }))}
              />
              <TextField
                label={t('Question for the tumour board')}
                name="question"
                required
                minLength={5}
                maxLength={500}
              />
              <TextAreaField
                label={t('Clinical summary')}
                name="summary"
                rows={5}
                maxLength={5000}
                hint={t(
                  'Seen only by the chair, you and the patient’s care team. Others of the facility see the patient’s name on the agenda.',
                )}
              />
              <ErrorAlert error={add.error} />
              <div className="form-actions">
                <Button variant="secondary" onClick={close}>
                  {t('Cancel')}
                </Button>
                <Button type="submit" loading={add.isPending}>
                  {t('Add to the agenda')}
                </Button>
              </div>
            </form>
          )
        }
      </QueryView>
    </Dialog>
  );
}

function Reviews({
  patientId,
  reviews,
  isDoctor,
}: {
  patientId: string;
  reviews: ChartReview[];
  isDoctor: boolean;
}) {
  const informed = useMarkInformed(patientId);
  if (!reviews.length) return <EmptyState title={t('Not discussed at a tumour board')} />;
  return (
    <>
      <Table caption={t('Tumour board history')}>
        <thead>
          <tr>
            <th scope="col">{t('Meeting')}</th>
            <th scope="col">{t('Question')}</th>
            <th scope="col">{t('Status')}</th>
            <th scope="col">{t('Recommendation')}</th>
            <th scope="col">{t('Patient informed')}</th>
          </tr>
        </thead>
        <tbody>
          {reviews.map((r) => (
            <tr key={r.id}>
              <td>
                <Link to={`/oncology?meeting=${r.meeting.id}`}>
                  {formatDateTime(r.meeting.scheduledFor)}
                </Link>
                <div className="muted">{t(TUMOUR_GROUP_LABEL[r.meeting.tumourGroup])}</div>
              </td>
              <td>
                {r.question}
                <div className="muted">{t('Referred by {name}', { name: r.referredBy })}</div>
              </td>
              <td>
                <Badge tone={REVIEW_TONE[r.status]}>{t(REVIEW_STATUS_LABEL[r.status])}</Badge>
              </td>
              <td>
                {r.recommendation ? (
                  <>
                    <strong>{t(RECOMMENDATION_LABEL[r.recommendation])}</strong>
                    <div>{r.recommendationText}</div>
                  </>
                ) : (
                  '—'
                )}
              </td>
              <td>
                {r.patientInformedAt ? (
                  formatDateTime(r.patientInformedAt)
                ) : r.status === 'DISCUSSED' && isDoctor ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={informed.isPending && informed.variables === r.id}
                    onClick={() => informed.mutate(r.id)}
                  >
                    {t('Mark as informed')}
                  </Button>
                ) : (
                  '—'
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
      <ErrorAlert error={informed.error} />
    </>
  );
}

/* ------------------------------------------------------------------ tab ----------------- */

const STATUS_BADGE = {
  ACTIVE: null,
  DUPLICATE: { tone: 'neutral', label: 'Duplicate' },
  WITHDRAWN: { tone: 'neutral', label: 'Withdrawn' },
} as const;

export function OncologyTab({ patientId }: { patientId: string }) {
  const { isDoctor } = useChartRole();
  const data = usePatientOncology(patientId);
  const defs = useOncologyDefinitions();
  const [registering, setRegistering] = useState(false);
  const [boarding, setBoarding] = useState(false);
  const [action, setAction] = useState<CaseAction | null>(null);
  return (
    <QueryView query={data}>
      {({ cases, reviews }) => (
        <div className="stack">
          <Card
            title={t('Cancers')}
            actions={
              isDoctor && defs.data ? (
                <Button size="sm" onClick={() => setRegistering(true)}>
                  {t('Register a cancer')}
                </Button>
              ) : null
            }
          >
            {cases.length === 0 ? (
              <EmptyState title={t('No cancer registered')} />
            ) : (
              <Table caption={t('Cancers')}>
                <thead>
                  <tr>
                    <th scope="col">{t('Diagnosed')}</th>
                    <th scope="col">{t('Site|cancer')}</th>
                    <th scope="col">{t('Morphology')}</th>
                    <th scope="col">{t('Stage')}</th>
                    <th scope="col">{t('Basis of diagnosis')}</th>
                    {isDoctor && <th scope="col">{t('Actions')}</th>}
                  </tr>
                </thead>
                <tbody>
                  {cases.map((c) => {
                    const badge = STATUS_BADGE[c.status];
                    return (
                      <tr key={c.id} className={c.status === 'ACTIVE' ? '' : 'muted'}>
                        <td>
                          {formatDate(c.diagnosedOn)}
                          {badge && (
                            <div>
                              <Badge tone={badge.tone}>{t(badge.label)}</Badge>
                            </div>
                          )}
                        </td>
                        <td>
                          <code>{c.topography}</code> {siteLabel(defs.data, c.topography)}
                          <div className="muted">
                            ICD-10 <code>{c.icd10}</code>
                            {c.laterality !== 'NOT_APPLICABLE' &&
                              ` · ${t(LATERALITY_LABEL[c.laterality])}`}
                          </div>
                        </td>
                        <td>
                          <code>{c.morphology}</code> {morphologyLabel(defs.data, c.morphology)}
                        </td>
                        <td>
                          {c.stage ? t(STAGE_LABEL[c.stage]) : t('Not staged yet')}
                          {tnm(c) && (
                            <div className="muted">
                              {tnm(c)}
                              {c.tnmEdition && ` (${t('TNM edition {n}', { n: c.tnmEdition })})`}
                            </div>
                          )}
                        </td>
                        <td>
                          {t(BASIS_LABEL[c.basisOfDiagnosis])}
                          {c.status === 'ACTIVE' && c.warnings.length > 0 && (
                            <div>
                              <Badge tone="warning">
                                {t(WARNING_LABEL[c.warnings[0]!.code] ?? c.warnings[0]!.message)}
                              </Badge>
                            </div>
                          )}
                        </td>
                        {isDoctor && (
                          <td>
                            {c.status === 'ACTIVE' && (
                              <div className="row">
                                <Button
                                  size="sm"
                                  variant="secondary"
                                  onClick={() => setAction({ kind: 'stage', c })}
                                >
                                  {t('Update staging')}
                                </Button>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  onClick={() => setAction({ kind: 'duplicate', c })}
                                >
                                  {t('Mark as duplicate')}
                                </Button>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  onClick={() => setAction({ kind: 'withdraw', c })}
                                >
                                  {t('Withdraw|registration')}
                                </Button>
                              </div>
                            )}
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </Table>
            )}
          </Card>
          <Card
            title={t('Tumour boards')}
            actions={
              isDoctor ? (
                <Button size="sm" variant="secondary" onClick={() => setBoarding(true)}>
                  {t('Add to a tumour board')}
                </Button>
              ) : null
            }
          >
            <Reviews patientId={patientId} reviews={reviews} isDoctor={isDoctor} />
          </Card>
          {defs.data && (
            <RegisterDialog
              patientId={patientId}
              defs={defs.data}
              open={registering}
              onClose={() => setRegistering(false)}
            />
          )}
          {boarding && (
            <AddToBoardDialog
              patientId={patientId}
              cases={cases}
              open={boarding}
              onClose={() => setBoarding(false)}
            />
          )}
          <CaseActionDialog
            patientId={patientId}
            action={action}
            cases={cases}
            onClose={() => setAction(null)}
          />
        </div>
      )}
    </QueryView>
  );
}
