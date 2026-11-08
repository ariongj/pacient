import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useBoard, useTeamStats, type Board, type BoardVisit } from '../../api/homecare';
import { useUser } from '../../auth/AuthContext';
import {
  Alert,
  Button,
  Card,
  EmptyState,
  Grid,
  PageHeader,
  QueryView,
  SelectField,
  Stat,
  Table,
  TabPanel,
  Tabs,
  TextField,
} from '../../components/ui';
import { formatDate, formatDateTime, formatNumber, formatTime } from '../../format';
import { t } from '../../i18n';
import {
  EpisodeDialog,
  EpisodeStatusBadge,
  taskList,
  VisitActions,
  VisitDialogs,
  VisitStatusBadge,
} from './HomeCareComponents';

/**
 * Community nursing. Team members see the day list per nurse (in visit order, with addresses and
 * access notes), visits that need attention and the team's episodes; directors see team activity
 * without names.
 */
export function HomeCarePage() {
  const user = useUser();
  if (user.role === 'DIRECTOR') {
    return (
      <>
        <PageHeader
          title={t('Home care')}
          subtitle={t('Community nursing teams of your facility: activity without patient names.')}
        />
        <TeamStatsView />
      </>
    );
  }
  return <TeamBoard />;
}

const kosovoToday = () =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Belgrade',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());

function TeamBoard() {
  const [params, setParams] = useSearchParams();
  const [teamId, setTeamId] = useState<string | undefined>();
  const [date, setDate] = useState(kosovoToday());
  const [tab, setTab] = useState<'day' | 'episodes'>('day');
  const board = useBoard(teamId, date);
  const openEpisode = params.get('episode');
  const [visitDialog, setVisitDialog] =
    useState<Parameters<typeof VisitDialogs>[0]['dialog']>(null);
  const setOpenEpisode = (id: string | null) => {
    const next = new URLSearchParams(params);
    if (id) next.set('episode', id);
    else next.delete('episode');
    setParams(next, { replace: true });
  };
  return (
    <>
      <PageHeader
        title={t('Home care')}
        subtitle={t('The team’s home visits, in the order of the planned times.')}
      />
      <QueryView query={board}>
        {(b) =>
          !b.team ? (
            <Card>
              <EmptyState title={t('You are not a member of a community nursing team')}>
                {t('Doctors refer patients to home care from the patient’s chart (Home care tab).')}
              </EmptyState>
            </Card>
          ) : (
            <>
              <div className="search-bar">
                {b.teams.length > 1 && (
                  <SelectField
                    label={t('Team')}
                    value={b.team.id}
                    onChange={(e) => setTeamId(e.target.value)}
                    options={b.teams.map((tm) => ({ value: tm.id, label: tm.name }))}
                  />
                )}
                <TextField
                  label={t('Day')}
                  type="date"
                  value={date}
                  onChange={(e) => e.target.value && setDate(e.target.value)}
                />
                <Button variant="secondary" onClick={() => setDate(kosovoToday())}>
                  {t('Today')}
                </Button>
              </div>
              {(b.attention?.length ?? 0) > 0 && (
                <Alert tone="warning" title={t('Visits that need attention')}>
                  <ul style={{ margin: 0, paddingLeft: '1.2rem' }}>
                    {b.attention!.map((v) => (
                      <li key={v.id}>
                        {v.patientName} – {formatDateTime(v.scheduledFor)} (
                        {v.assignedTo ?? t('Not assigned')}
                        ):{' '}
                        {v.checkOutOverdue
                          ? t('started {time} and not checked out', {
                              time: formatDateTime(v.startedAt),
                            })
                          : t('not started or recorded')}
                      </li>
                    ))}
                  </ul>
                </Alert>
              )}
              <Tabs
                label={t('Home care')}
                active={tab}
                onChange={setTab}
                tabs={[
                  { id: 'day', label: t('Day list') },
                  {
                    id: 'episodes',
                    label: t('Patients'),
                    count: b.episodes?.length,
                  },
                ]}
              />
              <TabPanel id={tab}>
                {tab === 'day' ? (
                  <DayList board={b} onOpenVisit={setVisitDialog} onOpenEpisode={setOpenEpisode} />
                ) : (
                  <EpisodeList board={b} onOpen={setOpenEpisode} />
                )}
              </TabPanel>
              <VisitDialogs
                dialog={visitDialog}
                onClose={() => setVisitDialog(null)}
                teamId={b.team.id}
              />
            </>
          )
        }
      </QueryView>
      <EpisodeDialog id={openEpisode} onClose={() => setOpenEpisode(null)} />
    </>
  );
}

function DayList({
  board,
  onOpenVisit,
  onOpenEpisode,
}: {
  board: Board;
  onOpenVisit: Parameters<typeof VisitActions>[0]['onOpen'];
  onOpenEpisode: (id: string) => void;
}) {
  const groups = board.byNurse ?? [];
  if (!groups.some((g) => g.visits.length)) {
    return (
      <Card>
        <EmptyState title={t('No visits planned for this day')} />
      </Card>
    );
  }
  return (
    <div className="stack">
      {groups
        .filter((g) => g.visits.length)
        .map((g) => (
          <Card
            key={g.nurseId ?? 'none'}
            title={g.nurse ?? t('Not assigned')}
            actions={
              <span className="muted">{t('{count} visits', { count: g.visits.length })}</span>
            }
          >
            <Table caption={g.nurse ?? t('Not assigned')}>
              <thead>
                <tr>
                  <th>{t('Time')}</th>
                  <th>{t('Patient')}</th>
                  <th>{t('Address for visits')}</th>
                  <th>{t('Tasks')}</th>
                  <th>{t('Status')}</th>
                  <th>
                    <span className="sr-only">{t('Actions')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {g.visits.map((v: BoardVisit) => (
                  <tr key={v.id}>
                    <td>{formatTime(v.scheduledFor)}</td>
                    <td>
                      <Button size="sm" variant="ghost" onClick={() => onOpenEpisode(v.episodeId)}>
                        {v.patientName}
                      </Button>
                      {v.phone && <div className="muted">{v.phone}</div>}
                    </td>
                    <td>
                      {v.address ?? '—'}
                      {v.accessNotes && <div className="muted">{v.accessNotes}</div>}
                    </td>
                    <td>{taskList(v.tasks)}</td>
                    <td>
                      <VisitStatusBadge v={v} />
                    </td>
                    <td>
                      <VisitActions visit={v} onOpen={onOpenVisit} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Card>
        ))}
    </div>
  );
}

function EpisodeList({ board, onOpen }: { board: Board; onOpen: (id: string) => void }) {
  const items = board.episodes ?? [];
  return (
    <Card>
      {items.length === 0 ? (
        <EmptyState title={t('No patients in home care')} />
      ) : (
        <Table caption={t('Patients')}>
          <thead>
            <tr>
              <th>{t('Patient')}</th>
              <th>{t('Reason for referral')}</th>
              <th>{t('Needs')}</th>
              <th>{t('Status')}</th>
              <th>{t('Referred by')}</th>
              <th>
                <span className="sr-only">{t('Actions')}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((e) => (
              <tr key={e.id}>
                <td>{e.patientName}</td>
                <td>{e.reason}</td>
                <td>{taskList(e.tasks)}</td>
                <td>
                  <EpisodeStatusBadge status={e.status} />
                  <div className="muted">{formatDate(e.startedAt ?? e.createdAt)}</div>
                </td>
                <td>{e.referredBy ?? '—'}</td>
                <td>
                  <Button
                    size="sm"
                    variant={e.status === 'REFERRED' ? 'primary' : 'secondary'}
                    onClick={() => onOpen(e.id)}
                  >
                    {e.status === 'REFERRED' ? t('Review referral') : t('Open|action')}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}

function TeamStatsView() {
  const stats = useTeamStats();
  return (
    <QueryView query={stats}>
      {(s) =>
        s.teams.length === 0 ? (
          <Card>
            <EmptyState title={t('No community nursing team')}>
              {t('Create a unit of the type “Community nursing” under Wards & units.')}
            </EmptyState>
          </Card>
        ) : (
          <div className="stack">
            {s.teams.map((team) => (
              <Card key={team.id} title={team.name}>
                <Grid>
                  <Stat label={t('New referrals')} value={formatNumber(team.referred)} />
                  <Stat label={t('Active episodes')} value={formatNumber(team.active)} />
                  <Stat label={t('On hold')} value={formatNumber(team.onHold)} />
                  <Stat
                    label={t('Discharged in the last 12 months')}
                    value={formatNumber(team.dischargedLast12Months)}
                  />
                  <Stat
                    label={t('Average length of care (days)')}
                    value={
                      team.averageEpisodeDays === null ? '—' : formatNumber(team.averageEpisodeDays)
                    }
                  />
                </Grid>
                {team.weeks.length > 0 && (
                  <Table caption={t('Visits per week')}>
                    <thead>
                      <tr>
                        <th>{t('Week of')}</th>
                        <th className="num">{t('Planned|visit')}</th>
                        <th className="num">{t('Done|visit')}</th>
                        <th className="num">{t('Missed|visit')}</th>
                        <th className="num">{t('Cancelled|visit')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {team.weeks.map((w) => (
                        <tr key={w.week}>
                          <td>{formatDate(w.week)}</td>
                          <td className="num">{formatNumber(w.planned)}</td>
                          <td className="num">{formatNumber(w.done)}</td>
                          <td className="num">{formatNumber(w.missed)}</td>
                          <td className="num">{formatNumber(w.cancelled)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                )}
              </Card>
            ))}
          </div>
        )
      }
    </QueryView>
  );
}
