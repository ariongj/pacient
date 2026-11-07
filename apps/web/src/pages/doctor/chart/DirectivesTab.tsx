import { useState, type FormEvent } from 'react';
import {
  decisionShort,
  kindLabel,
  kindShort,
  organLabel,
  purposeLabel,
  useCheckDonation,
  usePatientDirectives,
  useRecordDirective,
  useRecordDonationInPerson,
  summaryText,
  useRevokeDirective,
  type CheckPurpose,
  type Directive,
  type DirectiveKind,
} from '../../../api/directives';
import {
  Alert,
  Badge,
  Button,
  Card,
  DefinitionList,
  Dialog,
  EmptyState,
  ErrorAlert,
  QueryView,
  SelectField,
  TextAreaField,
  TextField,
} from '../../../components/ui';
import { formatDate, formatDateTime } from '../../../format';
import { t } from '../../../i18n';
import { DonationForm, ReasonDialog } from '../../directives/DonationForm';
import { useChartRole } from './shared';

/** Who can revoke each kind (mirrors the API: doctors any kind, nurses a healthcare proxy). */
const canRevoke = (role: { isDoctor: boolean; isNurse: boolean }, kind: DirectiveKind) =>
  role.isDoctor || (role.isNurse && kind === 'HEALTHCARE_PROXY');

/** Advance directives, resuscitation decisions and the organ donation register for one patient. */
export function DirectivesTab({ patientId }: { patientId: string }) {
  const role = useChartRole();
  const list = usePatientDirectives(patientId);
  const [recording, setRecording] = useState(false);
  const [revoking, setRevoking] = useState<Directive | null>(null);
  const revoke = useRevokeDirective();

  return (
    <>
      <Card
        title={t('Advance directives and resuscitation decisions')}
        actions={
          list.data && list.data.canRecord.length > 0 ? (
            <Button size="sm" onClick={() => setRecording(true)}>
              {t('Record a decision')}
            </Button>
          ) : undefined
        }
      >
        <QueryView query={list}>
          {(d) => {
            const active = d.items.filter((i) => i.status === 'ACTIVE');
            const revoked = d.items.filter((i) => i.status === 'REVOKED');
            return (
              <>
                {active.length === 0 ? (
                  <EmptyState title={t('No active directives')}>
                    {t(
                      'Without a recorded decision, full treatment including resuscitation is the default.',
                    )}
                  </EmptyState>
                ) : (
                  <ul className="stack" style={{ listStyle: 'none', padding: 0 }}>
                    {active.map((i) => (
                      <li key={i.id}>
                        <DirectiveCard
                          item={i}
                          onRevoke={canRevoke(role, i.kind) ? () => setRevoking(i) : undefined}
                        />
                      </li>
                    ))}
                  </ul>
                )}
                {revoked.length > 0 && (
                  <details style={{ marginTop: '1rem' }}>
                    <summary>{t('Revoked decisions ({count})', { count: revoked.length })}</summary>
                    <ul className="stack" style={{ listStyle: 'none', padding: 0 }}>
                      {revoked.map((i) => (
                        <li key={i.id}>
                          <DirectiveCard item={i} />
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
                <RecordDirectiveDialog
                  open={recording}
                  kinds={d.canRecord}
                  patientId={patientId}
                  onClose={() => setRecording(false)}
                />
              </>
            );
          }}
        </QueryView>
      </Card>
      <DonationRegisterCard
        patientId={patientId}
        registrable={list.data?.donationRegistrable ?? false}
      />
      <ReasonDialog
        open={revoking !== null}
        title={t('Revoke decision')}
        intro={
          revoking
            ? t('Revoke “{kind}”? The decision stays in the history with your reason.', {
                kind: kindLabel(revoking.kind),
              })
            : undefined
        }
        submitLabel={t('Revoke')}
        submitting={revoke.isPending}
        error={revoke.error}
        onClose={() => {
          setRevoking(null);
          revoke.reset();
        }}
        onSubmit={(reason) =>
          revoking &&
          revoke.mutate({ id: revoking.id, reason }, { onSuccess: () => setRevoking(null) })
        }
      />
    </>
  );
}

function DirectiveCard({ item: i, onRevoke }: { item: Directive; onRevoke?: () => void }) {
  const limiting = i.kind === 'DNACPR' || i.kind === 'TREATMENT_ESCALATION';
  return (
    <article
      className="card"
      style={{
        padding: '0.75rem 1rem',
        borderLeft: limiting && i.status === 'ACTIVE' ? '4px solid var(--danger)' : undefined,
      }}
    >
      <div
        className="row"
        style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.5rem' }}
      >
        <div className="row" style={{ gap: '0.5rem', flexWrap: 'wrap' }}>
          <Badge tone={limiting ? 'danger' : 'info'}>{kindShort(i.kind)}</Badge>
          <strong>{kindLabel(i.kind)}</strong>
          {i.status === 'REVOKED' && <Badge tone="neutral">{t('Revoked')}</Badge>}
          {i.reviewDue && <Badge tone="warning">{t('Review due|directive')}</Badge>}
        </div>
        {onRevoke && (
          <Button size="sm" variant="secondary" onClick={onRevoke}>
            {t('Revoke')}
          </Button>
        )}
      </div>
      <p style={{ margin: '0.5rem 0' }}>{summaryText(i.summary)}</p>
      <DefinitionList
        items={[
          ...(i.proxyName
            ? ([
                [
                  t('Healthcare proxy'),
                  `${i.proxyName}${i.proxyPhone ? ` · ${i.proxyPhone}` : ''}`,
                ],
              ] as [string, string][])
            : []),
          ...(i.discussedWith
            ? ([[t('Discussed with'), i.discussedWith]] as [string, string][])
            : []),
          ...(i.reviewDate
            ? ([[t('Review by'), formatDate(i.reviewDate)]] as [string, string][])
            : []),
          [
            t('Recorded'),
            i.selfRegistered
              ? t('{date} · by the patient in the portal', { date: formatDateTime(i.createdAt) })
              : `${formatDateTime(i.createdAt)} · ${i.createdByName}`,
          ],
          ...(i.status === 'REVOKED'
            ? ([
                [
                  t('Revoked'),
                  `${formatDateTime(i.revokedAt)}${i.revokeReason ? ` – ${i.revokeReason}` : ''}`,
                ],
              ] as [string, string][])
            : []),
        ]}
      />
    </article>
  );
}

function RecordDirectiveDialog({
  open,
  kinds,
  patientId,
  onClose,
}: {
  open: boolean;
  kinds: DirectiveKind[];
  patientId: string;
  onClose: () => void;
}) {
  const record = useRecordDirective(patientId);
  const [kind, setKind] = useState<DirectiveKind | ''>('');
  const close = () => {
    setKind('');
    record.reset();
    onClose();
  };
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const v = (k: string) => String(f.get(k) ?? '').trim() || undefined;
    if (!kind) return;
    record.mutate(
      {
        kind,
        summary: v('summary') ?? '',
        discussedWith: v('discussedWith'),
        proxyName: v('proxyName'),
        proxyPhone: v('proxyPhone'),
        reviewDate: v('reviewDate'),
      },
      { onSuccess: close },
    );
  }
  const clinicalDecision = kind === 'DNACPR' || kind === 'TREATMENT_ESCALATION';
  return (
    <Dialog open={open} onClose={close} title={t('Record a decision')} wide>
      <form onSubmit={submit} className="stack">
        <SelectField
          label={t('Kind of decision')}
          value={kind}
          onChange={(e) => setKind(e.target.value as DirectiveKind)}
          placeholder={t('Choose…')}
          options={kinds.map((k) => ({ value: k, label: kindLabel(k) }))}
          required
        />
        {kind === 'DNACPR' && (
          <Alert tone="info" title={t('Before recording a DNACPR decision')}>
            {t(
              'Discuss the decision with the patient (or, if they lack capacity, those close to them) and record who took part. It applies only to CPR: all other treatment continues.',
            )}
          </Alert>
        )}
        {kind && (
          <>
            <TextAreaField
              label={
                kind === 'TREATMENT_ESCALATION'
                  ? t('Agreed ceiling of care')
                  : kind === 'ADVANCE_REFUSAL'
                    ? t('Treatment refused and circumstances')
                    : kind === 'HEALTHCARE_PROXY'
                      ? t('Relationship and what the proxy should be consulted on')
                      : t('Decision and clinical reasons')
              }
              name="summary"
              required
              minLength={5}
              maxLength={2000}
              rows={4}
            />
            {kind === 'HEALTHCARE_PROXY' && (
              <div className="form-grid">
                <TextField label={t('Proxy’s name')} name="proxyName" required maxLength={200} />
                <TextField label={t('Proxy’s phone')} name="proxyPhone" maxLength={40} />
              </div>
            )}
            <div className="form-grid">
              <TextField
                label={t('Discussed with')}
                name="discussedWith"
                required={clinicalDecision}
                maxLength={300}
                hint={t('For example: the patient, a family member, the healthcare proxy.')}
              />
              <TextField label={t('Review by')} name="reviewDate" type="date" />
            </div>
          </>
        )}
        <ErrorAlert error={record.error} />
        <div className="form-actions">
          <Button variant="secondary" onClick={close}>
            {t('Cancel')}
          </Button>
          <Button type="submit" loading={record.isPending} disabled={!kind}>
            {t('Record')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** The register is consulted explicitly, for a stated purpose (audited), or updated in person. */
function DonationRegisterCard({
  patientId,
  registrable,
}: {
  patientId: string;
  registrable: boolean;
}) {
  const role = useChartRole();
  const check = useCheckDonation(patientId);
  const inPerson = useRecordDonationInPerson(patientId);
  const [checking, setChecking] = useState(false);
  const [recording, setRecording] = useState(false);
  const [purpose, setPurpose] = useState<CheckPurpose | ''>('');
  const [note, setNote] = useState('');
  const [saved, setSaved] = useState(false);
  const result = check.data;

  return (
    <Card title={t('Organ donation register')}>
      <p className="muted">
        {t(
          'The organ donation decision is not part of the routine record. Check the register only for end-of-life care or transplant coordination: every check is recorded and the patient can see it.',
        )}
      </p>
      {result && (
        <Alert
          tone="info"
          title={t('Register checked {time}', { time: formatDateTime(result.checkedAt) })}
        >
          {result.current ? (
            <>
              <p>
                <strong>{decisionShort(result.current.decision)}</strong>
                {result.current.organs?.length
                  ? ` – ${result.current.organs.map(organLabel).join(', ')}`
                  : ''}
              </p>
              <p>
                {t('Registered {date}', { date: formatDate(result.current.createdAt) })}
                {result.current.familyInformed ? ` · ${t('Family informed')}` : ''}
              </p>
              {result.current.faithOrBeliefNote && <p>{result.current.faithOrBeliefNote}</p>}
            </>
          ) : (
            <p>{t('No decision is registered. Talk to the family about the person’s wishes.')}</p>
          )}
        </Alert>
      )}
      {saved && <Alert tone="success" title={t('The decision was recorded.')} />}
      <div className="row" style={{ gap: '0.5rem', flexWrap: 'wrap' }}>
        {role.isDoctor && (
          <Button variant="secondary" onClick={() => setChecking(true)}>
            {t('Check organ donation register')}
          </Button>
        )}
        {registrable && (role.isDoctor || role.isNurse) && (
          <Button variant="secondary" onClick={() => setRecording(true)}>
            {t('Record a decision in person')}
          </Button>
        )}
      </div>
      <Dialog
        open={checking}
        onClose={() => {
          setChecking(false);
          check.reset();
        }}
        title={t('Check organ donation register')}
      >
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            if (!purpose) return;
            check.mutate(
              { purpose, ...(note.trim() ? { note: note.trim() } : {}) },
              { onSuccess: () => setChecking(false) },
            );
          }}
        >
          <SelectField
            label={t('Purpose|organ donation check')}
            value={purpose}
            onChange={(e) => setPurpose(e.target.value as CheckPurpose)}
            placeholder={t('Choose…')}
            options={(['END_OF_LIFE_CARE', 'TRANSPLANT_COORDINATION'] as const).map((p) => ({
              value: p,
              label: purposeLabel(p),
            }))}
            required
          />
          <TextAreaField
            label={t('Note (optional)')}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={300}
            rows={2}
          />
          <p className="muted">
            {t('This check is recorded under your name and shown in the patient’s access log.')}
          </p>
          <ErrorAlert error={check.error} />
          <div className="form-actions">
            <Button variant="secondary" onClick={() => setChecking(false)}>
              {t('Cancel')}
            </Button>
            <Button type="submit" loading={check.isPending} disabled={!purpose}>
              {t('Check register')}
            </Button>
          </div>
        </form>
      </Dialog>
      <Dialog
        open={recording}
        onClose={() => {
          setRecording(false);
          inPerson.reset();
        }}
        title={t('Record a decision in person')}
      >
        <DonationForm
          inPerson
          submitting={inPerson.isPending}
          error={inPerson.error}
          onCancel={() => setRecording(false)}
          onSubmit={(body) =>
            inPerson.mutate(body, {
              onSuccess: () => {
                setRecording(false);
                setSaved(true);
              },
            })
          }
        />
      </Dialog>
    </Card>
  );
}
