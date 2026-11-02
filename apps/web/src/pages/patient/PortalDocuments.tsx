import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import {
  CATEGORY_LABELS,
  checkFile,
  formatBytes,
  openDocument,
  uploadDocument,
  type PatientDocument,
} from '../../api/documents';
import { useAuth, useUser } from '../../auth/AuthContext';
import {
  Alert,
  Badge,
  Button,
  Card,
  Dialog,
  EmptyState,
  ErrorAlert,
  PageHeader,
  QueryView,
  Table,
  TextField,
} from '../../components/ui';
import { formatDate } from '../../format';
import { usePatientId } from './shared';

/** Documents the care team shared, and documents the patient (or guardian) added themselves. */
export function PortalDocuments() {
  const id = usePatientId();
  const user = useUser();
  const { acting } = useAuth();
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [openError, setOpenError] = useState<unknown>(null);
  const q = useQuery({
    queryKey: ['patient', id, 'documents'],
    queryFn: () => api<{ items: PatientDocument[] }>(`/patients/${id}/documents`),
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ['patient', id, 'documents'] });
  const upload = useMutation({
    mutationFn: (v: { file: File; title?: string }) =>
      uploadDocument(id, v.file, { title: v.title }),
    onSuccess: () => {
      void refresh();
      setAdding(false);
    },
  });
  const withdraw = useMutation({
    mutationFn: (docId: string) =>
      api(`/patients/${id}/documents/${docId}/entered-in-error`, {
        method: 'POST',
        body: { reason: 'Withdrawn by the patient' },
      }),
    onSuccess: () => void refresh(),
  });

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const file = form.get('file') as File | null;
    const problem = checkFile(file);
    setFileError(problem);
    if (problem || !file) return;
    upload.mutate({ file, title: String(form.get('title') ?? '').trim() || undefined });
  }

  const name = acting ? `${acting.firstName}’s` : 'your';

  return (
    <>
      <PageHeader
        title="Documents"
        subtitle={`Letters and reports from ${name} care team, and documents you added.`}
        actions={
          <Button
            onClick={() => {
              upload.reset();
              setFileError(null);
              setAdding(true);
            }}
          >
            Add a document
          </Button>
        }
      />
      <Alert tone="info">
        Documents are stored encrypted. Your care team decides which of their documents are shared
        here; anything you add is visible to your care team. Every time someone opens a document it
        is shown under <strong>Who viewed my record</strong>.
      </Alert>
      <ErrorAlert error={openError ?? withdraw.error} />
      <Card>
        <QueryView query={q}>
          {(d) =>
            d.items.length === 0 ? (
              <EmptyState title="No documents yet">
                When your doctor shares a letter or report, it appears here. You can also add your
                own, for example results from a clinic abroad.
              </EmptyState>
            ) : (
              <Table caption="Documents">
                <thead>
                  <tr>
                    <th>Document</th>
                    <th>Date</th>
                    <th>From</th>
                    <th>
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {d.items.map((doc) => (
                    <tr key={doc.id}>
                      <td>
                        <strong>{doc.title}</strong>
                        <div className="row" style={{ gap: '0.35rem', flexWrap: 'wrap' }}>
                          <Badge tone={doc.source === 'PATIENT' ? 'warning' : 'neutral'}>
                            {CATEGORY_LABELS[doc.category]}
                          </Badge>
                        </div>
                        <div className="muted">
                          {doc.mimeType === 'application/pdf' ? 'PDF' : 'Image'} ·{' '}
                          {formatBytes(doc.sizeBytes)}
                        </div>
                      </td>
                      <td>{formatDate(doc.createdAt)}</td>
                      <td>{doc.uploadedById === user.id ? 'Added by you' : doc.uploadedBy}</td>
                      <td>
                        <div className="row" style={{ gap: '0.5rem', flexWrap: 'wrap' }}>
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => {
                              setOpenError(null);
                              openDocument(doc).catch(setOpenError);
                            }}
                          >
                            Open
                          </Button>
                          {doc.source === 'PATIENT' && doc.uploadedById === user.id && (
                            <Button
                              size="sm"
                              variant="ghost"
                              loading={withdraw.isPending && withdraw.variables === doc.id}
                              onClick={() => {
                                if (
                                  window.confirm(
                                    `Withdraw “${doc.title}”? Your care team will no longer use it.`,
                                  )
                                )
                                  withdraw.mutate(doc.id);
                              }}
                            >
                              Withdraw
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )
          }
        </QueryView>
      </Card>

      <Dialog open={adding} onClose={() => setAdding(false)} title="Add a document">
        <form onSubmit={onSubmit}>
          <p className="muted">
            For example a report or results from another clinic. Your care team will be told that
            you added it.
          </p>
          <div className="field">
            <label htmlFor="portal-document-file">
              File{' '}
              <span className="required" aria-hidden="true">
                {' '}
                *
              </span>
            </label>
            <input
              id="portal-document-file"
              name="file"
              type="file"
              accept="application/pdf,image/jpeg,image/png"
              required
              aria-describedby="portal-document-hint"
              onChange={() => setFileError(null)}
            />
            <small id="portal-document-hint" className="muted">
              PDF, JPEG or PNG, up to 10 MB.
            </small>
            {fileError && <small className="error-text">{fileError}</small>}
          </div>
          <TextField
            label="Title"
            name="title"
            minLength={2}
            maxLength={200}
            placeholder="e.g. Blood test, Klinikum Munich, May 2026"
          />
          <ErrorAlert error={upload.error} />
          <div className="form-actions">
            <Button variant="secondary" onClick={() => setAdding(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={upload.isPending}>
              Add document
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
