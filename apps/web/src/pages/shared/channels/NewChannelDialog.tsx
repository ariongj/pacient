import { t } from '../../../i18n';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api } from '../../../api/client';
import type { Channel, StaffRole } from '../../../api/types';
import { useUser } from '../../../auth/AuthContext';
import { Button, Dialog, ErrorAlert, TextField } from '../../../components/ui';
import { humanize } from '../../../format';

const FACILITY_ROLES: StaffRole[] = ['DIRECTOR', 'DOCTOR', 'NURSE', 'PHARMACIST', 'RECEPTION'];
const ALL_ROLES: StaffRole[] = ['MINISTRY', ...FACILITY_ROLES];

export function NewChannelDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (c: Channel) => void;
}) {
  const user = useUser();
  const queryClient = useQueryClient();
  const options = user.role === 'MINISTRY' ? ALL_ROLES : FACILITY_ROLES;
  const [roles, setRoles] = useState<StaffRole[]>([]);
  const create = useMutation({
    mutationFn: (body: object) => api<Channel>('/channels', { method: 'POST', body }),
    onSuccess: (c) => {
      queryClient.invalidateQueries({ queryKey: ['channels'] });
      setRoles([]);
      onCreated(c);
    },
  });

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    create.mutate({
      name: String(f.get('name') ?? '')
        .trim()
        .toLowerCase(),
      description: String(f.get('description') ?? '').trim() || null,
      allowedRoles: roles,
    });
  }

  return (
    <Dialog open={open} onClose={onClose} title={t('New channel')}>
      <form onSubmit={onSubmit}>
        <TextField
          label={t('Name|thing')}
          name="name"
          required
          pattern="[a-z0-9][a-z0-9\-]{1,40}"
          hint={t('Lowercase letters, digits and dashes, e.g. night-shift')}
          maxLength={41}
        />
        <TextField label={t('Description')} name="description" maxLength={300} />
        <fieldset>
          <legend>{t('Who can see and post')}</legend>
          <p className="muted" style={{ marginTop: 0 }}>
            {user.role === 'MINISTRY'
              ? t('National channel: everyone with these roles, in every facility.')
              : t('Facility channel: staff of {facility} with these roles.', {
                  facility: user.facility?.name ?? t('your facility'),
                })}
          </p>
          {options.map((r) => (
            <label key={r} className="checkbox">
              <input
                type="checkbox"
                checked={roles.includes(r)}
                onChange={(e) =>
                  setRoles((prev) =>
                    e.target.checked ? [...prev, r] : prev.filter((x) => x !== r),
                  )
                }
              />
              {humanize(r)}
            </label>
          ))}
        </fieldset>
        <ErrorAlert error={create.error} />
        <div className="form-actions">
          <Button variant="secondary" onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button type="submit" loading={create.isPending} disabled={!roles.length}>
            {t('Create channel')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
