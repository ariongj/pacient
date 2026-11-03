import { Link } from 'react-router-dom';
import { hasImages, viewerPath } from '../../api/pacs';
import { t } from '../../i18n';

/** "View images" link shown when the examination has images in the archive. */
export function ViewImagesButton({
  order,
  variant = 'secondary',
}: {
  order: { id: string };
  variant?: 'secondary' | 'ghost' | 'primary';
}) {
  if (!hasImages(order)) return null;
  return (
    <Link className={`btn btn-${variant} btn-sm`} to={viewerPath(order.id)}>
      {t('View images')}
    </Link>
  );
}
