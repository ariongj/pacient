import { precautionGuidance, precautionLabel, type Precaution } from '../../api/infection';
import { Badge } from '../../components/ui';

/** Isolation precautions: text and a glyph (never colour alone), guidance on hover and for screen readers. */
export function IsolationBadge({
  precaution,
  reason,
}: {
  precaution: Precaution;
  reason?: string | null;
}) {
  const guidance = precautionGuidance(precaution);
  return (
    <span title={guidance} className="badge-wrap">
      <Badge tone="danger">
        {precautionLabel(precaution)}
        {reason ? ` · ${reason}` : ''}
      </Badge>
      <span className="sr-only">{guidance}</span>
    </span>
  );
}
