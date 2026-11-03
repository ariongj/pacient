import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api } from '../../api/client';
import { Button, Dialog, ErrorAlert, TextField } from '../../components/ui';
import { t } from '../../i18n';

/**
 * Radiology staff link the examination to its study in the image archive: by accession number
 * (search in the PACS) or by entering the Study Instance UID.
 */
export function LinkStudyButton({ orderId }: { orderId: string }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [uid, setUid] = useState('');
  const done = () => {
    void qc.invalidateQueries({ queryKey: ['imaging'] });
    void qc.invalidateQueries({ queryKey: ['patient'] });
    setOpen(false);
  };
  const lookup = useMutation({
    mutationFn: () => api(`/imaging/orders/${orderId}/study/lookup`, { method: 'POST' }),
    onSuccess: done,
  });
  const link = useMutation({
    mutationFn: (studyInstanceUid: string) =>
      api(`/imaging/orders/${orderId}/study`, { method: 'POST', body: { studyInstanceUid } }),
    onSuccess: done,
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    link.mutate(uid.trim());
  };
  return (
    <>
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
        {t('Link images')}
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} title={t('Link images from the archive')}>
        <p className="muted">
          {t(
            'Pacient finds the study in the image archive (PACS) by the accession number of this examination.',
          )}
        </p>
        <Button loading={lookup.isPending} onClick={() => lookup.mutate()}>
          {t('Find by accession number')}
        </Button>
        <ErrorAlert error={lookup.error} />
        <form onSubmit={submit} style={{ marginTop: '1rem' }}>
          <TextField
            label={t('Or enter the Study Instance UID')}
            value={uid}
            onChange={(e) => setUid(e.target.value)}
            pattern="[0-9.]{3,64}"
            placeholder="1.2.840…"
          />
          <ErrorAlert error={link.error} />
          <div className="form-actions">
            <Button variant="secondary" onClick={() => setOpen(false)}>
              {t('Cancel')}
            </Button>
            <Button type="submit" disabled={!uid.trim()} loading={link.isPending}>
              {t('Link study')}
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
