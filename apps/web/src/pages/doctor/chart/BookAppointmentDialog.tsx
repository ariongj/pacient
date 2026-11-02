import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../../api/client';
import { Button, Dialog, ErrorAlert, formValues, TextField } from '../../../components/ui';
import { t } from '../../../i18n';

export function BookAppointmentDialog({
  patientId,
  open,
  onClose,
}: {
  patientId: string;
  open: boolean;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const book = useMutation({
    mutationFn: (body: Record<string, unknown>) => api('/appointments', { method: 'POST', body }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['appointments'] });
      onClose();
    },
  });
  return (
    <Dialog open={open} onClose={onClose} title={t('Book appointment')}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const v = formValues(e.currentTarget);
          book.mutate({
            patientId,
            scheduledAt: new Date(v.scheduledAt ?? '').toISOString(),
            durationMinutes: Number(v.durationMinutes || 20),
            reason: v.reason,
          });
        }}
      >
        <div className="form-grid">
          <TextField label={t('Date and time')} name="scheduledAt" type="datetime-local" required />
          <TextField
            label={t('Duration (minutes)')}
            name="durationMinutes"
            type="number"
            min={5}
            max={480}
            defaultValue={20}
          />
        </div>
        <TextField label={t('Reason')} name="reason" required minLength={2} maxLength={500} />
        <p className="muted">{t('Appointments you book are confirmed immediately.')}</p>
        <ErrorAlert error={book.error} />
        <div className="form-actions">
          <Button variant="secondary" onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button type="submit" loading={book.isPending}>
            {t('Book appointment')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
