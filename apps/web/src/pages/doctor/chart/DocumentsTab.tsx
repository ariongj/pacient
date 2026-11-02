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
      title="Documents"
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
            Upload document
          </Button>
        ) : undefined
      }
    >
      <p className="muted">
        Letters, reports, photos and signed forms. Files are checked, encrypted and every opening is
        recorded in the patient’s access log. Documents are shown to the patient only when shared.
      </p>
      <ErrorAlert error={share.error ?? openError} />
      <QueryView query={list}>
        {(items) =>
          items.length === 0 ? (
            <EmptyState title="No documents yet" />
          ) : (
            <Table caption="Documents">
              <thead>
                <tr>
                  <th>Document</th>
                  <th>Added</th>
                  <th>Sharing</th>
                  <th>
                    <span className="sr-only">Actions</span>
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
                          {!current && <Badge tone="danger">Entered in error</Badge>}
                        </div>
                        <div className="muted">
                          {d.fileName} · {formatBytes(d.sizeBytes)}
                          {d.scanStatus === 'CLEAN' ? ' · scanned' : ''}
                        </div>
                        {!current && d.errorReason && (
                          <div className="muted">Reason: {d.errorReason}</div>
                        )}
                      </td>
                      <td>
                        {formatDateTime(d.createdAt)}
                        <div className="muted">
                          {d.uploadedBy}
                          {d.source === 'PATIENT'
                            ? ' (patient / guardian)'
                            : ` (${humanize(d.uploadedByRole)})`}
                        </div>
                      </td>
                      <td>
                        <div className="stack" style={{ gap: '0.35rem' }}>
                          {d.visibleToPatient ? (
                            <Badge tone="info">Visible to patient</Badge>
                          ) : (
                            <Badge tone="neutral">Care team only</Badge>
                          )}
                          {d.confidentialFromGuardians && (
                            <Badge tone="warning">Hidden from guardians</Badge>
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
                            Open
                          </Button>
                          {isDoctor && current && d.source === 'STAFF' && (
                            <Button
                              size="sm"
                              variant="secondary"
                              loading={share.isPending && share.variables?.id === d.id}
                              onClick={() =>
                                share.mutate({ id: d.id, visibleToPatient: !d.visibleToPatient })
                              }
                            >
                              {d.visibleToPatient ? 'Stop sharing' : 'Share with patient'}
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
                                ? 'Show to guardians'
                                : 'Hide from guardians'}
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
                              Entered in error
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

      <Dialog open={uploading} onClose={() => setUploading(false)} title="Upload document" wide>
        <form onSubmit={onUpload}>
          <div className="field">
            <label htmlFor="document-file">
              File{' '}
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
              PDF, JPEG or PNG, up to 10 MB.
            </small>
            {fileError && <small className="error-text">{fileError}</small>}
          </div>
          <div className="form-grid">
            <SelectField
              label="Category"
              name="category"
              required
              defaultValue="REFERRAL_LETTER"
              options={STAFF_CATEGORIES.map((c) => ({ value: c, label: CATEGORY_LABELS[c] }))}
            />
            <TextField
              label="Title"
              name="title"
              minLength={2}
              maxLength={200}
              hint="Defaults to the file name"
            />
          </div>
          <div className="stack" style={{ gap: '0.5rem', margin: '0.75rem 0' }}>
            {isDoctor && (
              <label className="checkbox">
                <input type="checkbox" name="visibleToPatient" />
                <span>Share with the patient now (they are notified)</span>
              </label>
            )}
            <label className="checkbox">
              <input type="checkbox" name="confidentialFromGuardians" />
              <span>Hide from guardians (e.g. an adolescent’s confidential consultation)</span>
            </label>
          </div>
          <ErrorAlert error={upload.error} />
          <div className="form-actions">
            <Button variant="secondary" onClick={() => setUploading(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={upload.isPending}>
              Upload
            </Button>
          </div>
        </form>
      </Dialog>

      <Dialog
        open={Boolean(inError)}
        onClose={() => setInError(null)}
        title="Mark as entered in error"
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const reason = String(new FormData(e.currentTarget).get('reason') ?? '').trim();
            if (inError) markInError.mutate({ id: inError.id, reason });
          }}
        >
          <p className="muted">
            “{inError?.title}” stays in the record for audit but is hidden from the patient and
            flagged for the care team. This cannot be undone.
          </p>
          <TextAreaField
            label="Reason"
            name="reason"
            required
            minLength={5}
            maxLength={300}
            rows={3}
            hint="For example: uploaded to the wrong patient."
          />
          <ErrorAlert error={markInError.error} />
          <div className="form-actions">
            <Button variant="secondary" onClick={() => setInError(null)}>
              Cancel
            </Button>
            <Button type="submit" variant="danger" loading={markInError.isPending}>
              Mark entered in error
            </Button>
          </div>
        </form>
      </Dialog>
    </Card>
  );
}
