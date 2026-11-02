import { useState } from 'react';
import type { CorrectionRequest } from '../../../api/types';
import {
  Button,
  Card,
  Dialog,
  EmptyState,
  ErrorAlert,
  formValues,
  QueryView,
  SelectField,
  StatusBadge,
  TextAreaField,
} from '../../../components/ui';
import { formatDateTime, humanize } from '../../../format';
import { useChartMutation, useChartRole } from './shared';
import { useSection } from './useSection';
import { t } from '../../../i18n';

export function CorrectionsTab({ patientId }: { patientId: string }) {
  const list = useSection<CorrectionRequest>(patientId, 'correction-requests');
  const [resolving, setResolving] = useState<CorrectionRequest | null>(null);
  const resolve = useChartMutation(
    patientId,
    ({ id, ...body }: { id: string; status: string; response: string }) => ({
      path: `/correction-requests/${id}`,
      method: 'PATCH',
      body,
    }),
    () => setResolving(null),
  );

  const { isDoctor } = useChartRole();

  return (
    <Card title={t('Correction requests from the patient')}>
      <p className="muted">
        {t(
          'Patients cannot edit their record. Review each request; if a change is needed, make it in the relevant section yourself so it is attributed to you, then answer the request.',
        )}
      </p>
      <QueryView query={list}>
        {(items) =>
          items.length === 0 ? (
            <EmptyState title={t('No correction requests')} />
          ) : (
            <ul className="list">
              {items.map((c) => (
                <li key={c.id}>
                  <div className="row-between">
                    <span>
                      <strong>{humanize(c.section)}</strong>{' '}
                      <span className="muted">· {formatDateTime(c.createdAt)}</span>
                    </span>
                    <StatusBadge value={c.status} />
                  </div>
                  <div style={{ whiteSpace: 'pre-wrap' }}>{c.description}</div>
                  {c.response && (
                    <div className="addendum">
                      <strong>{t('Response')}</strong> — {c.resolvedBy} ·{' '}
                      {formatDateTime(c.resolvedAt)}
                      <div>{c.response}</div>
                    </div>
                  )}
                  {c.status === 'OPEN' && isDoctor && (
                    <Button size="sm" variant="secondary" onClick={() => setResolving(c)}>
                      {t('Respond')}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )
        }
      </QueryView>
      <Dialog
        open={resolving !== null}
        onClose={() => setResolving(null)}
        title={t('Respond to correction request')}
      >
        {resolving && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const v = formValues(e.currentTarget);
              resolve.mutate({
                id: resolving.id,
                status: v.status ?? 'ACCEPTED',
                response: v.response ?? '',
              });
            }}
          >
            <div className="note">{resolving.description}</div>
            <SelectField
              label={t('Decision')}
              name="status"
              required
              options={[
                { value: 'ACCEPTED', label: t('Accepted — record corrected') },
                { value: 'REJECTED', label: t('Declined — record is accurate') },
              ]}
            />
            <TextAreaField
              label={t('Response to the patient')}
              name="response"
              required
              minLength={5}
              maxLength={4000}
              hint={t('The patient sees this response in their portal.')}
            />
            <ErrorAlert error={resolve.error} />
            <div className="form-actions">
              <Button variant="secondary" onClick={() => setResolving(null)}>
                {t('Cancel')}
              </Button>
              <Button type="submit" loading={resolve.isPending}>
                {t('Send response')}
              </Button>
            </div>
          </form>
        )}
      </Dialog>
    </Card>
  );
}
