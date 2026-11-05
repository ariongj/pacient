import { useState, type FormEvent } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  checkFile,
  fetchDocumentVersions,
  formatBytes,
  openDocument,
  uploadDocumentVersion,
  type PatientDocument,
} from '../../api/documents';
import {
  Badge,
  Button,
  Dialog,
  ErrorAlert,
  QueryView,
  Table,
  TextField,
} from '../../components/ui';
import { formatDateTime } from '../../format';
import { t } from '../../i18n';

/** "Version 3" badge (shown only once a document has more than one version). */
export function VersionBadge({ doc }: { doc: PatientDocument }) {
  if (doc.version <= 1) return null;
  return <Badge tone="info">{t('Version {n}', { n: doc.version })}</Badge>;
}

/** All versions of a document, newest first, each of which can be opened. */
export function DocumentHistoryDialog({
  doc,
  onClose,
}: {
  doc: PatientDocument | null;
  onClose: () => void;
}) {
  const [openError, setOpenError] = useState<unknown>(null);
  const q = useQuery({
    queryKey: ['patient', doc?.patientId, 'documents', doc?.id, 'versions'],
    queryFn: () => fetchDocumentVersions(doc!),
    enabled: Boolean(doc),
  });
  return (
    <Dialog open={Boolean(doc)} onClose={onClose} title={t('Version history')} wide>
      {doc && (
        <>
          <p className="muted">
            {t('Earlier versions stay in the record unchanged. “{title}”', { title: doc.title })}
          </p>
          <ErrorAlert error={openError} />
          <QueryView query={q}>
            {(items) => (
              <Table caption={t('Version history')}>
                <thead>
                  <tr>
                    <th>{t('Version')}</th>
                    <th>{t('Added')}</th>
                    <th>{t('File')}</th>
                    <th>
                      <span className="sr-only">{t('Actions')}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((v) => (
                    <tr key={v.id} className={v.status === 'CURRENT' ? undefined : 'muted'}>
                      <td>
                        <strong>{t('Version {n}', { n: v.version })}</strong>
                        <div className="row" style={{ gap: '0.35rem', flexWrap: 'wrap' }}>
                          {!v.supersededAt && <Badge tone="success">{t('Latest')}</Badge>}
                          {v.status !== 'CURRENT' && (
                            <Badge tone="danger">{t('Entered in error')}</Badge>
                          )}
                        </div>
                        {v.title !== doc.title && <div className="muted">{v.title}</div>}
                      </td>
                      <td>
                        {formatDateTime(v.createdAt)}
                        <div className="muted">{v.uploadedBy}</div>
                      </td>
                      <td>
                        {v.fileName}
                        <div className="muted">{formatBytes(v.sizeBytes)}</div>
                      </td>
                      <td>
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => {
                            setOpenError(null);
                            openDocument(v).catch(setOpenError);
                          }}
                        >
                          {t('Open|action')}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </QueryView>
          <div className="form-actions">
            <Button variant="secondary" onClick={onClose}>
              {t('Close')}
            </Button>
          </div>
        </>
      )}
    </Dialog>
  );
}

/** Upload a replacement file for a document; the old version stays in the history. */
export function NewVersionDialog({
  doc,
  onClose,
  onDone,
}: {
  doc: PatientDocument | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [fileError, setFileError] = useState<string | null>(null);
  const upload = useMutation({
    mutationFn: (v: { file: File; title?: string }) => uploadDocumentVersion(doc!, v.file, v.title),
    onSuccess: () => {
      onDone();
      onClose();
    },
  });
  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const file = form.get('file') as File | null;
    const problem = checkFile(file);
    setFileError(problem);
    if (problem || !file) return;
    const title = String(form.get('title') ?? '').trim();
    upload.mutate({ file, title: title && title !== doc?.title ? title : undefined });
  }
  return (
    <Dialog
      open={Boolean(doc)}
      onClose={() => {
        upload.reset();
        setFileError(null);
        onClose();
      }}
      title={t('Upload new version')}
    >
      {doc && (
        <form onSubmit={onSubmit}>
          <p className="muted">
            {t(
              'The new file replaces “{title}” in the record. The current version stays in the history, and the sharing stays the same.',
              { title: doc.title },
            )}
          </p>
          <div className="field">
            <label htmlFor="document-version-file">
              {t('File')}{' '}
              <span className="required" aria-hidden="true">
                {' '}
                *
              </span>
            </label>
            <input
              id="document-version-file"
              name="file"
              type="file"
              accept="application/pdf,image/jpeg,image/png"
              required
              aria-describedby="document-version-hint"
              onChange={() => setFileError(null)}
            />
            <small id="document-version-hint" className="muted">
              {t('PDF, JPEG or PNG, up to 10 MB.')}
            </small>
            {fileError && <small className="error-text">{fileError}</small>}
          </div>
          <TextField
            label={t('Title')}
            name="title"
            defaultValue={doc.title}
            minLength={2}
            maxLength={200}
          />
          <ErrorAlert error={upload.error} />
          <div className="form-actions">
            <Button variant="secondary" onClick={onClose}>
              {t('Cancel')}
            </Button>
            <Button type="submit" loading={upload.isPending}>
              {t('Upload new version')}
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
