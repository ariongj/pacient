import { usePlatformInfo } from '../api/platform';
import { formatDateTime } from '../format';
import { t } from '../i18n';
import { Alert } from './ui';

/** The operator's notice to every signed-in user (e.g. planned maintenance), when one is set. */
export function PlatformNotice() {
  const info = usePlatformInfo();
  const notice = info.data?.notice;
  if (!notice) return null;
  return (
    <Alert tone={notice.tone === 'WARNING' ? 'warning' : 'info'}>
      {notice.text}
      {notice.until && (
        <span className="muted">
          {' '}
          ({t('until {date}', { date: formatDateTime(notice.until) })})
        </span>
      )}
    </Alert>
  );
}
