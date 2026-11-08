import { useState } from 'react';
import { usePatientSepsis, sourceLabel } from '../../../api/sepsis';
import { useUser } from '../../../auth/AuthContext';
import { Alert, Button, Card, Dialog, EmptyState, QueryView } from '../../../components/ui';
import { formatDateTime } from '../../../format';
import { t } from '../../../i18n';
import {
  BundlePanel,
  FlagList,
  ScreenForm,
  SepsisStatusBadge,
} from '../../sepsis/SepsisComponents';

/** The patient's sepsis screens: the open one with its bundle, then the history. */
export function SepsisTab({ patientId }: { patientId: string }) {
  const user = useUser();
  const query = usePatientSepsis(patientId);
  const [screening, setScreening] = useState<string | 'new' | null>(null);
  const canAct = user.role === 'DOCTOR' || user.role === 'NURSE';
  return (
    <QueryView query={query}>
      {(data) => {
        const open = data.items.find((s) => s.open);
        const history = data.items.filter((s) => s !== open);
        return (
          <div className="stack">
            <Card
              title={t('Sepsis')}
              actions={
                canAct && !open ? (
                  <Button size="sm" onClick={() => setScreening('new')}>
                    {t('Screen for sepsis')}
                  </Button>
                ) : undefined
              }
            >
              {!open && <p className="muted">{t('No open sepsis screen.')}</p>}
              {open?.status === 'PENDING' && (
                <Alert tone="info" title={t('Screen needed')}>
                  <p>
                    {t('A raised early warning score at {time} prompted a sepsis screen.', {
                      time: formatDateTime(open.createdAt),
                    })}
                  </p>
                  {canAct && (
                    <Button size="sm" onClick={() => setScreening(open.id)}>
                      {t('Screen now')}
                    </Button>
                  )}
                </Alert>
              )}
              {open && open.status !== 'PENDING' && (
                <div className="stack">
                  {open.suspectedSource && (
                    <p>
                      {t('Suspected source')}: {sourceLabel(open.suspectedSource)}
                    </p>
                  )}
                  <FlagList flags={open.flags} />
                  <BundlePanel
                    patientId={patientId}
                    screen={open}
                    canReview={user.role === 'DOCTOR'}
                    target={data.targetMinutes}
                  />
                </div>
              )}
            </Card>
            <Card title={t('Earlier screens')}>
              {history.length === 0 ? (
                <EmptyState title={t('No earlier sepsis screens')} />
              ) : (
                <ul className="stack" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                  {history.map((s) => (
                    <li key={s.id} className="stack" style={{ gap: '0.25rem' }}>
                      <div className="row" style={{ gap: '0.5rem', flexWrap: 'wrap' }}>
                        <SepsisStatusBadge status={s.status} />
                        <span>{formatDateTime(s.screenedAt ?? s.createdAt)}</span>
                        {s.screenedBy && <span className="muted">{s.screenedBy}</span>}
                        {s.bundleStartedAt && (
                          <span className="muted">
                            {t('Sepsis Six: {done} of 6', { done: s.stepsDone })}
                          </span>
                        )}
                      </div>
                      {s.flags.length > 0 && <FlagList flags={s.flags} />}
                      {s.notes && <p className="muted">{s.notes}</p>}
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            <Dialog
              open={screening !== null}
              onClose={() => setScreening(null)}
              title={t('Sepsis screen')}
              wide
            >
              {data.latestVitals && (
                <p className="muted">
                  {t('Latest observations: {time}', {
                    time: formatDateTime(data.latestVitals.recordedAt),
                  })}
                </p>
              )}
              <ScreenForm
                patientId={patientId}
                screenId={screening && screening !== 'new' ? screening : undefined}
                suggested={data.suggestedFlags}
                onDone={() => setScreening(null)}
              />
            </Dialog>
          </div>
        );
      }}
    </QueryView>
  );
}
