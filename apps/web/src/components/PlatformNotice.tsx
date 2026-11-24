import { useEffect, useState } from 'react';
import { usePlatformInfo } from '../api/platform';
import { formatDateTime } from '../format';
import { t } from '../i18n';
import { Alert } from './ui';

/** The longest delay a browser timer accepts (about 24.8 days); longer waits are chained. */
const MAX_TIMER_MS = 2_147_483_647;

/**
 * The operator's notice to every signed-in user (e.g. planned maintenance), when one is set. It
 * disappears at its end time without waiting for the next refresh, and is never printed: it has
 * no place on a discharge summary or a report.
 */
export function PlatformNotice() {
  const info = usePlatformInfo();
  const notice = info.data?.notice;
  const until = notice?.until ? new Date(notice.until).getTime() : null;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (until === null || until <= now) return;
    const timer = window.setTimeout(
      () => setNow(Date.now()),
      Math.min(Math.max(until - Date.now(), 0), MAX_TIMER_MS),
    );
    return () => window.clearTimeout(timer);
  }, [until, now]);

  if (!notice || (until !== null && until <= now)) return null;
  return (
    <div className="no-print">
      <Alert tone={notice.tone === 'WARNING' ? 'warning' : 'info'}>
        {notice.text}
        {notice.until && (
          <span className="muted">
            {' '}
            ({t('until {date}', { date: formatDateTime(notice.until) })})
          </span>
        )}
      </Alert>
    </div>
  );
}
