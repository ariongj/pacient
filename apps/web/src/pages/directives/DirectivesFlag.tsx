import {
  kindLabel,
  kindShort,
  useDirectiveFlags,
  useEdDirectiveFlags,
  type DirectiveFlag,
} from '../../api/directives';
import { Badge } from '../../components/ui';
import { formatDate } from '../../format';
import { t } from '../../i18n';

/**
 * Prominent banner in the patient chart for active DNACPR / ceiling-of-care decisions. The text
 * says what applies (never colour alone) and links to the directives tab.
 */
export function DirectivesBanner({
  patientId,
  enabled,
  onOpen,
}: {
  patientId: string;
  enabled: boolean;
  onOpen: () => void;
}) {
  const flags = useDirectiveFlags(patientId, enabled);
  const items = flags.data?.items ?? [];
  if (!items.length) return null;
  return (
    <section
      className="alert alert-danger"
      aria-label={t('Treatment decisions in place')}
      style={{ marginTop: '0.75rem' }}
    >
      <strong>{t('Treatment decisions in place')}</strong>
      <ul style={{ margin: '0.25rem 0 0', paddingLeft: '1.2rem' }}>
        {items.map((f) => (
          <li key={f.id}>
            <strong>{kindLabel(f.kind)}</strong>
            {f.kind === 'TREATMENT_ESCALATION' ? ` – ${f.summary}` : ''}
            {f.reviewDue && (
              <>
                {' '}
                <Badge tone="warning">
                  {t('Review due since {date}', { date: formatDate(f.reviewDate) })}
                </Badge>
              </>
            )}
          </li>
        ))}
      </ul>
      <button type="button" className="btn btn-secondary btn-sm no-print" onClick={onOpen}>
        {t('Open wishes and directives')}
      </button>
    </section>
  );
}

/** Badges on an emergency department card (not shown on the big public screen). */
export function EdDirectiveBadges({ patientId }: { patientId: string }) {
  const flags = useEdDirectiveFlags();
  const items: DirectiveFlag[] = flags.data?.get(patientId) ?? [];
  if (!items.length) return null;
  return (
    <span className="row" style={{ gap: '0.25rem', flexWrap: 'wrap' }}>
      {items.map((f) => (
        <Badge key={f.id} tone="danger">
          {kindShort(f.kind)}
          {f.reviewDue ? ` · ${t('review due')}` : ''}
        </Badge>
      ))}
    </span>
  );
}
