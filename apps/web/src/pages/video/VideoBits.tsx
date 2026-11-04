import { Link } from 'react-router-dom';
import type { AppointmentMode } from '../../api/telemedicine';
import { t } from '../../i18n';

/** "Join video visit" button for an appointment whose video room is open. */
export function JoinVideoLink({
  appointmentId,
  waiting,
}: {
  appointmentId: string;
  waiting?: boolean;
}) {
  return (
    <Link
      to={`/video/${appointmentId}`}
      className="btn btn-primary btn-sm"
      style={{ marginTop: '0.35rem' }}
    >
      {waiting ? t('Patient is waiting – join') : t('Join video visit')}
    </Link>
  );
}

/** In person or video – radio group used when booking. */
export function ModeChoice({
  value,
  onChange,
}: {
  value: AppointmentMode;
  onChange: (mode: AppointmentMode) => void;
}) {
  return (
    <fieldset>
      <legend>{t('Type of visit')}</legend>
      <div className="row" style={{ flexWrap: 'wrap', gap: '1rem' }}>
        {(['IN_PERSON', 'VIDEO'] as const).map((m) => (
          <label key={m} className="checkbox">
            <input
              type="radio"
              name="visit-mode"
              value={m}
              checked={value === m}
              onChange={() => onChange(m)}
            />
            <span>
              {m === 'VIDEO' ? t('Video visit (from home)') : t('In person at the facility')}
            </span>
          </label>
        ))}
      </div>
      {value === 'VIDEO' && (
        <p className="muted" style={{ margin: '0.35rem 0 0' }}>
          {t(
            'You need a phone or computer with a camera and microphone. Join from Appointments up to 15 minutes before the start.',
          )}
        </p>
      )}
    </fieldset>
  );
}
