import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  downloadPack,
  useBackEntry,
  useDowntimePacks,
  useDowntimeStatus,
  useEndDowntime,
  useGeneratePack,
  useStartDowntime,
  type DowntimePack,
} from '../../api/downtime';
import { useUser } from '../../auth/AuthContext';
import {
  Alert,
  Badge,
  Button,
  Card,
  Dialog,
  EmptyState,
  ErrorAlert,
  PageHeader,
  QueryView,
  SelectField,
  TabPanel,
  Table,
  Tabs,
  TextField,
} from '../../components/ui';
import { formatDateTime } from '../../format';
import { t, tn } from '../../i18n';

type Tab = 'packs' | 'back-entry' | 'procedure';

const LOCALES = [
  { value: '', label: 'Director’s language' },
  { value: 'sq', label: 'Albanian' },
  { value: 'sr', label: 'Serbian' },
  { value: 'en', label: 'English' },
];

export function DowntimePage() {
  const user = useUser();
  const isDirector = user.role === 'DIRECTOR';
  const canBackEnter = ['DIRECTOR', 'DOCTOR', 'NURSE'].includes(user.role);
  const [tab, setTab] = useState<Tab>('packs');
  const status = useDowntimeStatus();

  const tabs: { id: Tab; label: string }[] = [
    { id: 'packs', label: t('Downtime packs') },
    ...(canBackEnter ? [{ id: 'back-entry' as Tab, label: t('Back-entry checklist') }] : []),
    { id: 'procedure', label: t('What to do') },
  ];

  return (
    <>
      <PageHeader
        title={t('Downtime kit')}
        subtitle={t(
          'Printable patient lists for working on paper when the system is unavailable, and the facility’s downtime status.',
        )}
      />
      <QueryView query={status}>
        {(s) => <StatusCard status={s} isDirector={isDirector} />}
      </QueryView>
      <Tabs tabs={tabs} active={tab} onChange={setTab} label={t('Downtime kit')} />
      <TabPanel id={tab}>
        {tab === 'packs' && <PacksPanel isDirector={isDirector} />}
        {tab === 'back-entry' && canBackEnter && <BackEntryPanel role={user.role} />}
        {tab === 'procedure' && <ProcedurePanel />}
      </TabPanel>
    </>
  );
}

function StatusCard({
  status,
  isDirector,
}: {
  status: NonNullable<ReturnType<typeof useDowntimeStatus>['data']>;
  isDirector: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [note, setNote] = useState('');
  const start = useStartDowntime();
  const end = useEndDowntime();

  return (
    <Card
      title={t('Status')}
      actions={
        isDirector &&
        (status.active ? (
          <Button variant="secondary" onClick={() => setConfirmEnd(true)}>
            {t('End downtime')}
          </Button>
        ) : (
          <Button variant="danger" onClick={() => setOpen(true)}>
            {t('Start downtime procedures')}
          </Button>
        ))
      }
    >
      {status.active ? (
        <Alert tone="danger" title={t('Downtime procedures in effect')}>
          {t('Since {time}.', { time: formatDateTime(status.since) })}{' '}
          {status.note && <span>{status.note}</span>}
        </Alert>
      ) : (
        <p>
          <Badge tone="success">{t('Normal operation')}</Badge>{' '}
          {status.lastWindow && (
            <span className="muted">
              {t('Last downtime: {since} – {end}.', {
                since: formatDateTime(status.lastWindow.since),
                end: formatDateTime(status.lastWindow.endedAt),
              })}
            </span>
          )}
        </p>
      )}
      <p className="muted">
        {status.latestPack
          ? t('Latest pack: {time}, {count}.', {
              time: formatDateTime(status.latestPack.generatedAt),
              count: tn(status.latestPack.patientCount, '{count} inpatient', '{count} inpatients'),
            })
          : t('No downtime pack has been generated yet.')}
      </p>
      <ErrorAlert error={start.error ?? end.error} />

      <Dialog open={open} onClose={() => setOpen(false)} title={t('Start downtime procedures')}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            start.mutate(note, {
              onSuccess: () => {
                setOpen(false);
                setNote('');
              },
            });
          }}
        >
          <p>
            {t(
              'All staff of the facility are notified and see a red banner. The system keeps working – this tells everyone to record on paper and back-enter afterwards.',
            )}
          </p>
          <TextField
            label={t('Note for staff (optional)')}
            hint={t('For example the reason and the expected end. No patient information.')}
            maxLength={300}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <ErrorAlert error={start.error} />
          <div className="form-actions">
            <Button variant="secondary" onClick={() => setOpen(false)}>
              {t('Cancel')}
            </Button>
            <Button type="submit" variant="danger" loading={start.isPending}>
              {t('Start downtime procedures')}
            </Button>
          </div>
        </form>
      </Dialog>

      <Dialog open={confirmEnd} onClose={() => setConfirmEnd(false)} title={t('End downtime')}>
        <p>
          {t(
            'Staff are notified that the system is back and that paper records must now be back-entered.',
          )}
        </p>
        <ErrorAlert error={end.error} />
        <div className="form-actions">
          <Button variant="secondary" onClick={() => setConfirmEnd(false)}>
            {t('Cancel')}
          </Button>
          <Button
            loading={end.isPending}
            onClick={() => end.mutate(undefined, { onSuccess: () => setConfirmEnd(false) })}
          >
            {t('End downtime')}
          </Button>
        </div>
      </Dialog>
    </Card>
  );
}

function PacksPanel({ isDirector }: { isDirector: boolean }) {
  const packs = useDowntimePacks();
  const generate = useGeneratePack();
  const [locale, setLocale] = useState('');
  const [downloading, setDownloading] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<unknown>(null);

  const download = async (p: DowntimePack) => {
    setDownloading(p.id);
    setDownloadError(null);
    try {
      await downloadPack(p);
    } catch (err) {
      setDownloadError(err);
    } finally {
      setDownloading(null);
    }
  };

  return (
    <Card
      title={t('Downtime packs')}
      actions={
        isDirector && (
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <SelectField
              label={t('Language')}
              value={locale}
              onChange={(e) => setLocale(e.target.value)}
              options={LOCALES.map((l) => ({ value: l.value, label: t(l.label) }))}
            />
            <Button
              loading={generate.isPending}
              onClick={() => generate.mutate((locale || undefined) as 'sq' | 'sr' | 'en' | undefined)}
            >
              {t('Generate now')}
            </Button>
          </div>
        )
      }
    >
      <Alert tone="warning">
        {t(
          'Packs contain confidential patient information. Download them only to a protected facility computer (the ward downtime PC), never to a personal device, and print only when the system is down. Every download is recorded.',
        )}
      </Alert>
      <ErrorAlert error={generate.error ?? downloadError} />
      <QueryView query={packs}>
        {({ data, ageEnabled }) =>
          data.length === 0 ? (
            <EmptyState title={t('No downtime packs yet')}>
              {t('A new pack is generated every hour.')}
            </EmptyState>
          ) : (
            <>
              <p className="muted">
                {t('A new pack is generated every hour; the last 48 are kept.')}{' '}
                {ageEnabled
                  ? t('Copies for the offline key are synchronised to the ward downtime PCs.')
                  : t('Offline-key copies for ward downtime PCs are not configured.')}
              </p>
              <Table caption={t('Downtime packs')}>
                <thead>
                  <tr>
                    <th>{t('Generated')}</th>
                    <th>{t('Inpatients')}</th>
                    <th>{t('Copy')}</th>
                    <th>{t('Checksum (SHA-256)')}</th>
                    <th>
                      <span className="sr-only">{t('Actions')}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.map((p) => (
                    <tr key={p.id}>
                      <td>{formatDateTime(p.generatedAt)}</td>
                      <td>{p.patientCount}</td>
                      <td>
                        {p.kind === 'HTML_AES' ? (
                          <Badge tone="info">{t('Server copy')}</Badge>
                        ) : (
                          <Badge tone="neutral">{t('Offline-key copy')}</Badge>
                        )}
                      </td>
                      <td>
                        <code title={p.sha256}>{p.sha256.slice(0, 12)}…</code>
                      </td>
                      <td>
                        {p.kind === 'HTML_AES' && (
                          <Button
                            size="sm"
                            variant="secondary"
                            loading={downloading === p.id}
                            onClick={() => void download(p)}
                          >
                            {t('Download')}
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </>
          )
        }
      </QueryView>
    </Card>
  );
}

function BackEntryPanel({ role }: { role: string }) {
  const checklist = useBackEntry();
  const chartLink = (patientId: string) =>
    role === 'NURSE' ? `/nurse/patients/${patientId}` : `/doctor/patients/${patientId}`;

  return (
    <Card title={t('Back-entry checklist')}>
      <p>
        {t(
          'Enter every paper record with the time it actually happened. Medicine administrations accept the real administration time; add the note “Back-entered after downtime”.',
        )}
      </p>
      <QueryView query={checklist}>
        {({ window, patients }) =>
          !window ? (
            <EmptyState title={t('No downtime recorded')}>
              {t('The checklist appears once downtime procedures have been used.')}
            </EmptyState>
          ) : (
            <>
              <p className="muted">
                {window.active
                  ? t('Downtime in progress since {since}.', {
                      since: formatDateTime(window.since),
                    })
                  : t('Downtime from {since} to {end}.', {
                      since: formatDateTime(window.since),
                      end: formatDateTime(window.endedAt),
                    })}
              </p>
              {patients.length === 0 ? (
                <EmptyState title={t('No inpatients during the downtime')} />
              ) : (
                <Table caption={t('Back-entry checklist')}>
                  <thead>
                    <tr>
                      <th>{t('Ward')}</th>
                      <th>{t('Bed')}</th>
                      <th>{t('Patient')}</th>
                      <th>{t('Medicines entered for the period')}</th>
                      <th>{t('Observations entered for the period')}</th>
                      <th>
                        <span className="sr-only">{t('Actions')}</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {patients.map((p) => (
                      <tr key={p.admissionId}>
                        <td>{p.unitName}</td>
                        <td>{p.bed ?? '—'}</td>
                        <td>
                          {p.firstName} {p.lastName}
                          <br />
                          <span className="muted">{p.nationalId}</span>
                        </td>
                        <td>
                          {p.administrations}
                          {p.administrationsBackEntered > 0 && (
                            <span className="muted">
                              {' '}
                              ({t('{count} back-entered', {
                                count: p.administrationsBackEntered,
                              })})
                            </span>
                          )}
                        </td>
                        <td>{p.observations}</td>
                        <td>
                          {role !== 'DIRECTOR' && (
                            <Link className="btn btn-secondary btn-sm" to={chartLink(p.patientId)}>
                              {t('Open record')}
                            </Link>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </>
          )
        }
      </QueryView>
    </Card>
  );
}

function ProcedurePanel() {
  return (
    <Card title={t('What to do')}>
      <h3>{t('Before an outage')}</h3>
      <ul>
        <li>{t('Check that the ward downtime PC shows a pack from the last hour.')}</li>
        <li>{t('Keep paper medicine charts, observation charts and request forms ready.')}</li>
      </ul>
      <h3>{t('During downtime')}</h3>
      <ul>
        <li>{t('Open the latest pack on the downtime PC and print your ward.')}</li>
        <li>
          {t(
            'Record every medicine given, every observation and every new patient on paper, with the time.',
          )}
        </li>
        <li>{t('Check allergies and identity with the patient – the pack may be up to an hour old.')}</li>
      </ul>
      <h3>{t('After downtime')}</h3>
      <ul>
        <li>{t('Back-enter paper records with the time they happened, using the checklist.')}</li>
        <li>{t('Keep the paper records with the patient’s file; shred printed packs.')}</li>
      </ul>
    </Card>
  );
}
