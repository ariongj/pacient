import { decisionShort, useRegistryStats, type CountRow } from '../../api/directives';
import { RankedBars } from '../../components/charts';
import { Card, Grid, PageHeader, QueryView, Stat, Table } from '../../components/ui';
import { formatMonth, formatNumber, humanize } from '../../format';
import { t } from '../../i18n';

const num = (n: number | null) => (n === null ? t('Too few to show') : formatNumber(n));
const pct = (n: number | null) => (n === null ? '—' : `${formatNumber(n)} %`);

/**
 * National organ donation registry (Ministry): aggregate figures only, small numbers suppressed.
 * Individual decisions are never shown here; clinicians consult the register for one person,
 * for a stated purpose, and each check is audited.
 */
export function OrganDonationRegistryPage() {
  const stats = useRegistryStats();
  return (
    <>
      <PageHeader
        title={t('Organ donation registry')}
        subtitle={t(
          'Current decisions of living adults. Aggregate figures only, with small numbers suppressed; individual decisions are consulted only by the treating doctor and every check is recorded.',
        )}
      />
      <QueryView query={stats}>
        {(s) => (
          <>
            <Grid>
              <Stat label={t('Registered decisions')} value={num(s.registered)} />
              <Stat label={t('Registered donors')} value={num(s.donors)} tone="success" />
              <Stat label={t('Donors among registered')} value={pct(s.donorPctOfRegistered)} />
              <Stat
                label={t('Adults who registered a decision')}
                value={pct(s.registeredPctOfAdults)}
                hint={t('of {n} adults', { n: formatNumber(s.adultPopulation) })}
              />
            </Grid>
            <Grid min={320}>
              <Card title={t('Decisions')}>
                <RankedBars
                  label={t('Decisions')}
                  rows={s.byDecision.map((d) => ({
                    key: d.decision,
                    label: decisionShort(d.decision),
                    value: d.count,
                    suppressed: d.count === null,
                  }))}
                />
              </Card>
              <Card title={t('By age band')}>
                <BreakdownTable rows={s.byAgeBand} caption={t('By age band')} />
              </Card>
              <Card title={t('By sex')}>
                <BreakdownTable
                  rows={s.bySex.map((r) => ({ ...r, key: humanize(r.key) }))}
                  caption={t('By sex')}
                />
              </Card>
            </Grid>
            <Card title={t('By municipality')}>
              <BreakdownTable rows={s.byMunicipality} caption={t('By municipality')} />
            </Card>
            <Card title={t('Decisions recorded per month (last 12 months)')}>
              {s.byMonth.length === 0 ? (
                <p className="muted">{t('No decisions recorded in this period.')}</p>
              ) : (
                <Table caption={t('Decisions recorded per month (last 12 months)')}>
                  <thead>
                    <tr>
                      <th scope="col">{t('Month')}</th>
                      <th scope="col" className="num">
                        {decisionShort('DONOR')}
                      </th>
                      <th scope="col" className="num">
                        {decisionShort('DONOR_SOME')}
                      </th>
                      <th scope="col" className="num">
                        {decisionShort('NOT_DONOR')}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {s.byMonth.map((m) => (
                      <tr key={m.month}>
                        <td>{formatMonth(m.month.slice(0, 7))}</td>
                        <td className="num">{num(m.DONOR)}</td>
                        <td className="num">{num(m.DONOR_SOME)}</td>
                        <td className="num">{num(m.NOT_DONOR)}</td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
              <p className="muted">
                {t('Counts below {n} are not shown.', { n: s.smallCellThreshold })}
              </p>
            </Card>
          </>
        )}
      </QueryView>
    </>
  );
}

function BreakdownTable({ rows, caption }: { rows: CountRow[]; caption: string }) {
  if (!rows.length) return <p className="muted">{t('No data yet.')}</p>;
  return (
    <Table caption={caption}>
      <thead>
        <tr>
          <th scope="col">{t('Group')}</th>
          <th scope="col" className="num">
            {t('Registered')}
          </th>
          <th scope="col" className="num">
            {t('Donors')}
          </th>
          <th scope="col" className="num">
            {t('Donors %')}
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key}>
            <td>{r.key}</td>
            <td className="num">{num(r.registered)}</td>
            <td className="num">{num(r.donors)}</td>
            <td className="num">{pct(r.donorPct)}</td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}
