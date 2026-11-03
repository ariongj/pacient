import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  bedStatusLabel,
  sexShort,
  shortAge,
  sourceLabel,
  unitTypeLabel,
  useBoard,
  type BoardBed,
  type BoardStay,
  type BoardUnit,
} from '../../api/hospital';
import { useUser } from '../../auth/AuthContext';
import { Badge, Button, Card, EmptyState, PageHeader, QueryView, Tabs } from '../../components/ui';
import { formatDate, fullName } from '../../format';
import { t } from '../../i18n';
import { AdmitDialog, BedStatusActions, DischargeDialog, TransferDialog } from './dialogs';
import './hospital.css';

type Action =
  | { kind: 'admit'; unitId?: string; bedId?: string }
  | { kind: 'transfer'; stay: BoardStay; bedId: string | null }
  | { kind: 'discharge'; stay: BoardStay }
  | null;

function StayLines({ stay, base }: { stay: BoardStay; base: string | null }) {
  const name = fullName(stay);
  const dueToday =
    stay.expectedDischargeAt && new Date(stay.expectedDischargeAt).getTime() < endOfToday();
  return (
    <>
      <span className="bed-patient">
        {base ? <Link to={`${base}/patients/${stay.patientId}`}>{name}</Link> : name}
        {stay.temporaryIdentity && (
          <>
            {' '}
            <Badge tone="warning">{t('Temporary ID')}</Badge>
          </>
        )}
      </span>
      <span className="bed-meta">
        {shortAge(stay.dateOfBirth)} · {sexShort(stay.sex)} ·{' '}
        {t('Day {count} in hospital', { count: stay.daysInHospital + 1 })}
      </span>
      <span className="bed-meta">
        {stay.attendingDoctorName}
        {stay.source !== 'ELECTIVE' ? ` · ${sourceLabel(stay.source)}` : ''}
      </span>
      {stay.reason && <span className="bed-meta">{stay.reason}</span>}
      {stay.expectedDischargeAt && (
        <span className="bed-meta">
          {dueToday ? (
            <Badge tone="info">{t('Discharge expected today')}</Badge>
          ) : (
            t('Expected discharge {date}', { date: formatDate(stay.expectedDischargeAt) })
          )}
        </span>
      )}
    </>
  );
}

const endOfToday = () => {
  const d = new Date();
  d.setHours(23, 59, 59, 999);
  return d.getTime();
};

function BedCard({
  bed,
  canAdmit,
  canBedStatus,
  canMove,
  base,
  onAction,
}: {
  bed: BoardBed;
  canAdmit: boolean;
  canBedStatus: boolean;
  canMove: boolean;
  base: string | null;
  onAction: (a: Action) => void;
}) {
  const tone =
    bed.status === 'AVAILABLE'
      ? 'success'
      : bed.status === 'OCCUPIED'
        ? 'info'
        : bed.status === 'CLEANING'
          ? 'warning'
          : 'neutral';
  return (
    <article
      className={`bed-card bed-${bed.stay ? 'OCCUPIED' : bed.status} ${bed.stay?.mine ? 'bed-mine' : ''}`}
      aria-label={t('Bed {label}', { label: bed.label })}
    >
      <h3>
        <span>{t('Bed {label}', { label: bed.label })}</span>
        <Badge tone={tone}>{bedStatusLabel(bed.stay ? 'OCCUPIED' : bed.status)}</Badge>
      </h3>
      {bed.stay ? (
        <StayLines stay={bed.stay} base={base} />
      ) : (
        bed.note && <span className="bed-meta">{bed.note}</span>
      )}
      <div className="bed-actions">
        {bed.stay && canMove && (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => onAction({ kind: 'transfer', stay: bed.stay!, bedId: bed.id })}
          >
            {t('Transfer')}
          </Button>
        )}
        {bed.stay && canAdmit && (
          <Button size="sm" onClick={() => onAction({ kind: 'discharge', stay: bed.stay! })}>
            {t('Discharge')}
          </Button>
        )}
        {!bed.stay && bed.status === 'AVAILABLE' && canAdmit && (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => onAction({ kind: 'admit', bedId: bed.id })}
          >
            {t('Admit here')}
          </Button>
        )}
        {!bed.stay && canBedStatus && <BedStatusActions bedId={bed.id} status={bed.status} />}
      </div>
    </article>
  );
}

function UnitBoard({
  unit,
  canAdmit,
  canBedStatus,
  canMove,
  base,
  onAction,
}: {
  unit: BoardUnit;
  canAdmit: boolean;
  canBedStatus: boolean;
  canMove: boolean;
  base: string | null;
  onAction: (a: Action) => void;
}) {
  const pct = unit.total ? Math.round((unit.occupied / unit.total) * 100) : 0;
  return (
    <Card
      title={
        <>
          {unit.name} <span className="muted">· {unitTypeLabel(unit.type)}</span>
        </>
      }
      actions={
        canAdmit ? (
          <Button size="sm" onClick={() => onAction({ kind: 'admit', unitId: unit.id })}>
            {t('Admit a patient')}
          </Button>
        ) : undefined
      }
    >
      <div className="stack" style={{ gap: '0.75rem' }}>
        <div>
          <div className="row-between">
            <span>
              {t('{occupied} of {total} beds occupied · {available} free', {
                occupied: unit.occupied,
                total: unit.total,
                available: unit.available,
              })}
            </span>
            <strong>{pct}%</strong>
          </div>
          <div
            className={`occupancy-bar ${pct >= 90 ? 'high' : ''}`}
            role="img"
            aria-label={t('{pct}% occupied', { pct })}
          >
            <span style={{ width: `${pct}%` }} />
          </div>
        </div>
        <div className="bed-grid">
          {unit.beds.map((b) => (
            <BedCard
              key={b.id}
              bed={b}
              canAdmit={canAdmit}
              canBedStatus={canBedStatus}
              canMove={canMove}
              base={base}
              onAction={onAction}
            />
          ))}
        </div>
        {unit.withoutBed.length > 0 && (
          <div className="stack" style={{ gap: '0.5rem' }}>
            <h3 style={{ margin: 0, fontSize: '1rem' }}>
              {t('Admitted without a bed (rooming-in or waiting for a bed)')}
            </h3>
            <div className="bed-grid">
              {unit.withoutBed.map((s) => (
                <article key={s.admissionId} className="bed-card bed-OCCUPIED">
                  <StayLines stay={s} base={base} />
                  <div className="bed-actions">
                    {canMove && (
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => onAction({ kind: 'transfer', stay: s, bedId: null })}
                      >
                        {t('Assign a bed')}
                      </Button>
                    )}
                    {canAdmit && (
                      <Button size="sm" onClick={() => onAction({ kind: 'discharge', stay: s })}>
                        {t('Discharge')}
                      </Button>
                    )}
                  </div>
                </article>
              ))}
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}

/** The facility's bed board: who is in which bed, free beds, cleaning, admissions and discharges. */
export function BedBoard() {
  const user = useUser();
  const [mine, setMine] = useState(false);
  const [tab, setTab] = useState<string>('all');
  const [action, setAction] = useState<Action>(null);
  const board = useBoard(mine);
  const isDoctor = user.role === 'DOCTOR';
  const isNurse = user.role === 'NURSE';
  const base = isDoctor ? '/doctor' : isNurse ? '/nurse' : null;
  const canBedStatus = ['NURSE', 'RECEPTION', 'DIRECTOR'].includes(user.role);

  return (
    <>
      <PageHeader
        title={t('Wards & beds')}
        subtitle={t(
          'Live bed board of {facility}. Directors and reception see who is in which bed, never the clinical reason.',
          { facility: user.facility?.name ?? '' },
        )}
        actions={
          <>
            {isDoctor && (
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={mine}
                  onChange={(e) => setMine(e.currentTarget.checked)}
                />
                <span>{t('Only my patients')}</span>
              </label>
            )}
            {isDoctor && (
              <Button onClick={() => setAction({ kind: 'admit' })}>{t('Admit a patient')}</Button>
            )}
          </>
        }
      />
      <QueryView query={board}>
        {(data) => {
          if (!data.units.length) {
            return (
              <EmptyState title={t('No wards yet')}>
                {user.role === 'DIRECTOR'
                  ? t('Create wards and beds under Wards & units.')
                  : t('The facility director has not set up wards yet.')}
              </EmptyState>
            );
          }
          const total = data.units.reduce((a, u) => a + u.total, 0);
          const occupied = data.units.reduce((a, u) => a + u.occupied, 0);
          const available = data.units.reduce((a, u) => a + u.available, 0);
          const shown = tab === 'all' ? data.units : data.units.filter((u) => u.id === tab);
          const canFor = (unit: BoardUnit) => ({
            canAdmit: isDoctor,
            canMove: isDoctor || (isNurse && data.myUnitIds.includes(unit.id)),
          });
          return (
            <div className="stack">
              <p className="muted" style={{ margin: 0 }}>
                {t('{occupied} of {total} beds occupied, {available} free across all wards.', {
                  occupied,
                  total,
                  available,
                })}
              </p>
              <Tabs
                label={t('Wards')}
                active={tab}
                onChange={setTab}
                tabs={[
                  { id: 'all', label: t('All wards') },
                  ...data.units.map((u) => ({ id: u.id, label: u.name, count: u.occupied })),
                ]}
              />
              {shown.map((u) => (
                <UnitBoard
                  key={u.id}
                  unit={u}
                  {...canFor(u)}
                  canBedStatus={canBedStatus}
                  base={base}
                  onAction={setAction}
                />
              ))}
            </div>
          );
        }}
      </QueryView>
      {isDoctor && (
        <AdmitDialog
          open={action?.kind === 'admit'}
          onClose={() => setAction(null)}
          preset={
            action?.kind === 'admit'
              ? {
                  unitId:
                    action.unitId ??
                    (action.bedId
                      ? board.data?.units.find((u) => u.beds.some((b) => b.id === action.bedId))?.id
                      : undefined),
                  bedId: action.bedId,
                }
              : undefined
          }
        />
      )}
      {action?.kind === 'transfer' && (
        <TransferDialog
          open
          onClose={() => setAction(null)}
          admissionId={action.stay.admissionId}
          patientId={action.stay.patientId}
          currentBedId={action.bedId}
        />
      )}
      {action?.kind === 'discharge' && (
        <DischargeDialog
          open
          onClose={() => setAction(null)}
          admissionId={action.stay.admissionId}
          patientId={action.stay.patientId}
        />
      )}
    </>
  );
}
