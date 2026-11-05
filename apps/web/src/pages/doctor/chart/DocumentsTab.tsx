import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  CATEGORY_LABELS,
  checkFile,
  formatBytes,
  openDocument,
  uploadDocument,
  type DocumentCategory,
  type PatientDocument,
} from '../../../api/documents';
import { useUser } from '../../../auth/AuthContext';
import {
  Badge,
  Button,
  Card,
  Dialog,
  EmptyState,
  ErrorAlert,
  QueryView,
  SelectField,
  Table,
  TextAreaField,
  TextField,
} from '../../../components/ui';
import { formatDateTime, humanize } from '../../../format';
import { useChartMutation, useChartRole } from './shared';
import { useSection } from './useSection';
import { t } from '../../../i18n';
import {
  DocumentHistoryDialog,
  NewVersionDialog,
  VersionBadge,
} from '../../shared/DocumentVersions';

const STAFF_CATEGORIES = (Object.keys(CATEGORY_LABELS) as DocumentCategory[]).filter(
  (c) => c !== 'PATIENT_PROVIDED',
);

/**
 * Documents in the record: scanned letters, reports, photos and signed forms. Staff decide what is
 * shared with the patient; documents are never deleted, only marked "entered in error".
 */
export function DocumentsTab({ patientId }: { patientId: string }) {
  const user = useUser();
  const { isDoctor, isNurse } = useChartRole();
  const list = useSection<PatientDocument>(patientId, 'documents');
  const qc = useQueryClient();
  const [uploading, setUploading] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [inError, setInError] = useState<PatientDocument | null>(null);
  const [openError, setOpenError] = useState<unknown>(null);
  const [history, setHistory] = useState<PatientDocument | null>(null);
  const [replacing, setReplacing] = useState<PatientDocument | null>(null);

  const upload = useMutation({
    mutationFn: (v: { file: File; meta: Parameters<typeof uploadDocument>[2] }) =>
      uploadDocument(patientId, v.file, v.meta),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['patient', patientId] });
      setUploading(false);
    },
  });
  const share = useChartMutation(
    patientId,
    (v: { id: string; visibleToPatient?: boolean; confidentialFromGuardians?: boolean }) => {
      const { id, ...body } = v;
      return { path: `/documents/${id}`, method: 'PATCH', body };
    },
  );
  const markInError = useChartMutation(
    patientId,
    (v: { id: string; reason: string }) => ({
      path: `/documents/${v.id}/entered-in-error`,
      method: 'POST',
      body: { reason: v.reason },
    }),
    () => setInError(null),
  );

  function onUpload(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const file = form.get('file') as File | null;
    const problem = checkFile(file);
    setFileError(problem);
    if (problem || !file) return;
    upload.mutate({
      file,
      meta: {
        category: form.get('category') as DocumentCategory,
        title: String(form.get('title') ?? '').trim() || undefined,
        visibleToPatient: form.get('visibleToPatient') === 'on',
        confidentialFromGuardians: form.get('confidentialFromGuardians') === 'on',
      },
    });
  }

  const canUpload = isDoctor || isNurse;

  return (
    <Card
      title={t('Documents')}
      actions={
        canUpload ? (
          <Button
            size="sm"
            onClick={() => {
              upload.reset();
              setFileError(null);
              setUploading(true);
            }}
          >
            {t('Upload document')}
          </Button>
        ) : undefined
      }
    >
      <p className="muted">
        {t(
          'Letters, reports, photos and signed forms. Files are checked, encrypted and every opening is recorded in the patient’s access log. Documents are shown to the patient only when shared.',
        )}
      </p>
      <ErrorAlert error={share.error ?? openError} />
      <QueryView query={list}>
        {(items) =>
          items.length === 0 ? (
            <EmptyState title={t('No documents yet')} />
          ) : (
            <Table caption={t('Documents')}>
              <thead>
                <tr>
                  <th>{t('Document')}</th>
                  <th>{t('Added')}</th>
                  <th>{t('Sharing')}</th>
                  <th>
                    <span className="sr-only">{t('Actions')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((d) => {
                  const current = d.status === 'CURRENT';
                  const canMark = current && (d.uploadedById === user.id || isDoctor);
                  return (
                    <tr key={d.id} className={current ? undefined : 'muted'}>
                      <td>
                        <strong>{current ? d.title : <s>{d.title}</s>}</strong>
                        <div className="row" style={{ gap: '0.35rem', flexWrap: 'wrap' }}>
                          <Badge tone={d.source === 'PATIENT' ? 'warning' : 'neutral'}>
                            {CATEGORY_LABELS[d.category]}
                          </Badge>
                          <VersionBadge doc={d} />
                          {!current && <Badge tone="danger">{t('Entered in error')}</Badge>}
                        </div>
                        <div className="muted">
                          {d.fileName} · {formatBytes(d.sizeBytes)}
                          {d.scanStatus === 'CLEAN' ? ` · ${t('scanned')}` : ''}
                        </div>
                        {!current && d.errorReason && (
                          <div className="muted">
                            {t('Reason: {reason}', { reason: d.errorReason })}
                          </div>
                        )}
                      </td>
                      <td>
                        {formatDateTime(d.createdAt)}
                        <div className="muted">
                          {d.uploadedBy}
                          {d.source === 'PATIENT'
                            ? ` (${t('patient / guardian')})`
                            : ` (${humanize(d.uploadedByRole)})`}
                        </div>
                      </td>
                      <td>
                        <div className="stack" style={{ gap: '0.35rem' }}>
                          {d.visibleToPatient ? (
                            <Badge tone="info">{t('Visible to patient')}</Badge>
                          ) : (
                            <Badge tone="neutral">{t('Care team only')}</Badge>
                          )}
                          {d.confidentialFromGuardians && (
                            <Badge tone="warning">{t('Hidden from guardians')}</Badge>
                          )}
                        </div>
                      </td>
                      <td>
                        <div className="stack" style={{ gap: '0.35rem' }}>
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => {
                              setOpenError(null);
                              openDocument(d).catch(setOpenError);
                            }}
                          >
                            {t('Open|action')}
                          </Button>
                          {d.version > 1 && (
                            <Button size="sm" variant="secondary" onClick={() => setHistory(d)}>
                              {t('Version history')}
                            </Button>
                          )}
                          {canUpload && current && d.source === 'STAFF' && (
                            <Button size="sm" variant="secondary" onClick={() => setReplacing(d)}>
                              {t('Upload new version')}
                            </Button>
                          )}
                          {isDoctor && current && d.source === 'STAFF' && (
                            <Button
                              size="sm"
                              variant="secondary"
                              loading={share.isPending && share.variables?.id === d.id}
                              onClick={() =>
                                share.mutate({ id: d.id, visibleToPatient: !d.visibleToPatient })
                              }
                            >
                              {d.visibleToPatient ? t('Stop sharing') : t('Share with patient')}
                            </Button>
                          )}
                          {isDoctor && current && d.source === 'STAFF' && (
                            <Button
                              size="sm"
                              variant="secondary"
                              loading={share.isPending && share.variables?.id === d.id}
                              onClick={() =>
                                share.mutate({
                                  id: d.id,
                                  confidentialFromGuardians: !d.confidentialFromGuardians,
                                })
                              }
                            >
                              {d.confidentialFromGuardians
                                ? t('Show to guardians')
                                : t('Hide from guardians')}
                            </Button>
                          )}
                          {canMark && (
                            <Button
                              size="sm"
                              variant="secondary"
                              onClick={() => {
                                markInError.reset();
                                setInError(d);
                              }}
                            >
                              {t('Entered in error')}
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          )
        }
      </QueryView>

      <Dialog
        open={uploading}
        onClose={() => setUploading(false)}
        title={t('Upload document')}
        wide
      >
        <form onSubmit={onUpload}>
          <div className="field">
            <label htmlFor="document-file">
              {t('File')}{' '}
              <span className="required" aria-hidden="true">
                {' '}
                *
              </span>
            </label>
            <input
              id="document-file"
              name="file"
              type="file"
              accept="application/pdf,image/jpeg,image/png"
              required
              aria-describedby="document-file-hint"
              onChange={() => setFileError(null)}
            />
            <small id="document-file-hint" className="muted">
              {t('PDF, JPEG or PNG, up to 10 MB.')}
            </small>
            {fileError && <small className="error-text">{fileError}</small>}
          </div>
          <div className="form-grid">
            <SelectField
              label={t('Category')}
              name="category"
              required
              defaultValue="REFERRAL_LETTER"
              options={STAFF_CATEGORIES.map((c) => ({ value: c, label: CATEGORY_LABELS[c] }))}
            />
            <TextField
              label={t('Title')}
              name="title"
              minLength={2}
              maxLength={200}
              hint={t('Defaults to the file name')}
            />
          </div>
          <div className="stack" style={{ gap: '0.5rem', margin: '0.75rem 0' }}>
            {isDoctor && (
              <label className="checkbox">
                <input type="checkbox" name="visibleToPatient" />
                <span>{t('Share with the patient now (they are notified)')}</span>
              </label>
            )}
            <label className="checkbox">
              <input type="checkbox" name="confidentialFromGuardians" />
              <span>
                {t('Hide from guardians (e.g. an adolescent’s confidential consultation)')}
              </span>
            </label>
          </div>
          <ErrorAlert error={upload.error} />
          <div className="form-actions">
            <Button variant="secondary" onClick={() => setUploading(false)}>
              {t('Cancel')}
            </Button>
            <Button type="submit" loading={upload.isPending}>
              {t('Upload')}
            </Button>
          </div>
        </form>
      </Dialog>

      <Dialog
        open={Boolean(inError)}
        onClose={() => setInError(null)}
        title={t('Mark as entered in error')}
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const reason = String(new FormData(e.currentTarget).get('reason') ?? '').trim();
            if (inError) markInError.mutate({ id: inError.id, reason });
          }}
        >
          <p className="muted">
            {t(
              '“{title}” stays in the record for audit but is hidden from the patient and flagged for the care team. This cannot be undone.',
              { title: inError?.title ?? '' },
            )}
          </p>
          <TextAreaField
            label={t('Reason')}
            name="reason"
            required
            minLength={5}
            maxLength={300}
            rows={3}
            hint={t('For example: uploaded to the wrong patient.')}
          />
          <ErrorAlert error={markInError.error} />
          <div className="form-actions">
            <Button variant="secondary" onClick={() => setInError(null)}>
              {t('Cancel')}
            </Button>
            <Button type="submit" variant="danger" loading={markInError.isPending}>
              {t('Mark entered in error')}
            </Button>
          </div>
        </form>
      </Dialog>

      <DocumentHistoryDialog doc={history} onClose={() => setHistory(null)} />
      <NewVersionDialog
        doc={replacing}
        onClose={() => setReplacing(null)}
        onDone={() => void qc.invalidateQueries({ queryKey: ['patient', patientId] })}
      />
    </Card>
  );
}
