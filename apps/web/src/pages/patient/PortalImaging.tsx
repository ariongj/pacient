import { ViewImagesButton } from '../imaging/ViewImagesButton';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';
import { modalityLabel, type PatientImagingReport } from '../../api/imaging';
import { Alert, Card, EmptyState, PageHeader, QueryView } from '../../components/ui';
import { formatDate } from '../../format';
import { t } from '../../i18n';
import { usePatientId } from './shared';

/** Imaging reports the doctor has reviewed and released, conclusion first. */
export function PortalImaging() {
  const id = usePatientId();
  const q = useQuery({
    queryKey: ['imaging', 'portal', id],
    queryFn: () =>
      api<{ items: PatientImagingReport[] }>(`/imaging/patients/${id}/orders`).then((r) => r.items),
  });
  return (
    <>
      <PageHeader title={t('Imaging')} subtitle={t('X-ray, CT, MRI and ultrasound reports')} />
      <Alert tone="info">
        {t(
          'Reports appear here after your doctor has reviewed them. Medical terms can sound worrying out of context – your doctor will explain what the result means for you.',
        )}
      </Alert>
      <QueryView query={q}>
        {(items) =>
          items.length === 0 ? (
            <Card>
              <EmptyState title={t('No imaging reports yet')} />
            </Card>
          ) : (
            <div className="stack">
              {items.map((r) => (
                <Card
                  key={r.id}
                  title={t('{modality} · {bodyPart}', {
                    modality: modalityLabel(r.modality),
                    bodyPart: r.bodyPart,
                  })}
                >
                  <p className="muted">
                    {t('Examination on {date}', { date: formatDate(r.performedAt) })} ·{' '}
                    {t('Requested by {name}', { name: r.orderedBy })}
                  </p>
                  <h3>{t('Conclusion')}</h3>
                  <p>
                    <strong>{r.impression}</strong>
                  </p>
                  <p>
                    <ViewImagesButton order={r} />
                  </p>
                  <details>
                    <summary>{t('Full report')}</summary>
                    <p style={{ whiteSpace: 'pre-wrap' }}>{r.findings}</p>
                    <p className="muted">
                      {t('Reported by {name} on {date}', {
                        name: r.reportedBy ?? '—',
                        date: formatDate(r.reportedAt),
                      })}
                    </p>
                  </details>
                </Card>
              ))}
            </div>
          )
        }
      </QueryView>
    </>
  );
}
