import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../../api/client';
import type { Slot } from '../../../api/scheduling';
import { useUser } from '../../../auth/AuthContext';
import { Button, Dialog, ErrorAlert, formValues, TextField } from '../../../components/ui';
import { t } from '../../../i18n';
import { TimeChooser, useManualTimeCheck } from '../../reception/BookAppointmentDialog';

/** A doctor books a follow-up with themself: pick one of their free slots or any other time. */
export function BookAppointmentDialog({
  patientId,
  open,
  onClose,
}: {
  patientId: string;
  open: boolean;
  onClose: () => void;
}) {
  const user = useUser();
  const qc = useQueryClient();
  const [mode, setMode] = useState<'slot' | 'manual'>('slot');
  const [slot, setSlot] = useState<Slot | null>(null);
  const [manual, setManual] = useState('');
  const [duration, setDuration] = useState('20');
  const warning = useManualTimeCheck(mode === 'manual' ? user.id : null, manual);
  const book = useMutation({
    mutationFn: (body: Record<string, unknown>) => api('/appointments', { method: 'POST', body }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['appointments'] });
      void qc.invalidateQueries({ queryKey: ['scheduling'] });
      setSlot(null);
      setManual('');
      onClose();
    },
  });
  const when = mode === 'slot' ? slot?.start : manual ? new Date(manual).toISOString() : '';
  return (
    <Dialog open={open} onClose={onClose} title={t('Book appointment')} wide>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          if (!when) return;
          const v = formValues(e.currentTarget);
          book.mutate({
            patientId,
            scheduledAt: when,
            durationMinutes: mode === 'slot' && slot ? slot.minutes : Number(duration),
            reason: v.reason,
          });
        }}
      >
        <TimeChooser
          doctorId={user.id}
          mode={mode}
          setMode={setMode}
          slot={slot}
          setSlot={setSlot}
          manual={manual}
          setManual={setManual}
          warning={warning}
          duration={duration}
          setDuration={setDuration}
        />
        <TextField label={t('Reason')} name="reason" required minLength={2} maxLength={500} />
        <p className="muted">{t('Appointments you book are confirmed immediately.')}</p>
        <ErrorAlert error={book.error} />
        <div className="form-actions">
          <Button variant="secondary" onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button type="submit" loading={book.isPending} disabled={!when}>
            {t('Book appointment')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
