import { useState, type FormEvent } from 'react';
import { useUser } from '../../../auth/AuthContext';
import {
  FACILITY_ROLES,
  INVITABLE_ROLES,
  LICENSED_ROLES,
  roleLabel,
  useFacilityOptions,
  useUpdateAccount,
  type AccountChange,
  type AccountDetail,
  type InvitableRole,
} from '../../../api/adminUsers';
import {
  Alert,
  Button,
  Dialog,
  ErrorAlert,
  formValues,
  SelectField,
  TextAreaField,
  TextField,
} from '../../../components/ui';
import { t, tn } from '../../../i18n';

/**
 * Change an account's name, role, facility, specialty or licence number. A change of role or
 * facility needs a reason, signs the person out everywhere and waits until their patients, result
 * cover and results awaiting review have been handed over. Only fields that changed are sent: a
 * field that is not shown is never cleared.
 */
export function ChangeDialog({
  user,
  open,
  onClose,
  onDone,
}: {
  user: AccountDetail;
  open: boolean;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  return (
    <Dialog open={open} onClose={onClose} title={t('Change details')} wide>
      {open && <ChangeForm user={user} onClose={onClose} onDone={onDone} />}
    </Dialog>
  );
}

function ChangeForm({
  user,
  onClose,
  onDone,
}: {
  user: AccountDetail;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const me = useUser();
  const update = useUpdateAccount(user.id);
  const facilities = useFacilityOptions();
  const self = me.id === user.id;
  const locked = self || user.activeCareTeams > 0;
  const [role, setRole] = useState<InvitableRole>(user.role as InvitableRole);
  const [facilityId, setFacilityId] = useState(user.facilityId ?? '');
  const needsFacility = FACILITY_ROLES.includes(role);
  const licensed = LICENSED_ROLES.includes(role);
  const moves = role !== user.role || (needsFacility ? facilityId : '') !== (user.facilityId ?? '');
  // Doctors have a specialty; nurses and pharmacists often a professional title in the same field.
  // It is shown whenever the account has one, so it can be seen and kept, never wiped unseen.
  const showSpecialty = role === 'DOCTOR' || Boolean(user.specialty);

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const v = formValues(e.currentTarget);
    const body: AccountChange = {};
    // Only what the form shows and was changed: a missing field never becomes "clear it".
    const changed = (field: 'specialty' | 'licenseNumber') =>
      field in v && v[field] !== (user[field] ?? '');
    if (v.fullName && v.fullName !== user.fullName) body.fullName = v.fullName;
    if (role !== user.role) body.role = role;
    if (needsFacility && facilityId !== (user.facilityId ?? '')) body.facilityId = facilityId;
    if (changed('specialty')) body.specialty = v.specialty || null;
    if (licensed && changed('licenseNumber')) body.licenseNumber = v.licenseNumber || null;
    if (moves) body.reason = v.reason;
    update.mutate(body, {
      onSuccess: (result) => {
        const done = moves
          ? t('The details are changed; the person is signed out and signs in again.')
          : t('The details are changed.');
        // Where licences are enforced, clinical entries need a licence of the new profession.
        const noLicence =
          result.licenceLinked === false && (body.role !== undefined || 'licenseNumber' in body);
        onDone(
          noLicence
            ? `${done} ${t('No register licence of this profession is linked to the account yet; until the Ministry links one, clinical entries can be refused.')}`
            : done,
        );
        onClose();
      },
    });
  }

  return (
    <form onSubmit={onSubmit}>
      {self && (
        <Alert tone="info">
          {t('You cannot change your own role or facility; ask another administrator.')}
        </Alert>
      )}
      {!self && user.activeCareTeams > 0 && (
        <Alert tone="warning" title={t('Patients to hand over first')}>
          {tn(
            user.activeCareTeams,
            'This person is in the care team of {count} patient. Their role and facility can change once that patient has been handed over to a colleague.',
            'This person is in the care team of {count} patients. Their role and facility can change once those patients have been handed over to colleagues.',
          )}
        </Alert>
      )}
      <div className="form-grid">
        <TextField
          label={t('Full name')}
          name="fullName"
          required
          minLength={2}
          maxLength={200}
          defaultValue={user.fullName}
        />
        <SelectField
          label={t('Role')}
          name="role"
          value={role}
          disabled={locked}
          onChange={(e) => setRole(e.target.value as InvitableRole)}
          options={INVITABLE_ROLES.map((r) => ({ value: r, label: roleLabel(r) }))}
        />
        {needsFacility && (
          <SelectField
            label={t('Facility')}
            name="facilityId"
            required
            disabled={locked}
            value={facilityId}
            onChange={(e) => setFacilityId(e.target.value)}
            placeholder={t('Choose…')}
            options={(facilities.data ?? []).map((f) => ({ value: f.id, label: f.name }))}
          />
        )}
        {showSpecialty && (
          <TextField
            label={t('Specialty')}
            name="specialty"
            maxLength={120}
            defaultValue={user.specialty ?? ''}
          />
        )}
        {licensed && (
          <TextField
            label={t('Professional licence number')}
            name="licenseNumber"
            required
            maxLength={60}
            defaultValue={user.licenseNumber ?? ''}
          />
        )}
      </div>
      {moves && (
        <TextAreaField
          label={t('Reason for the change of role or facility')}
          name="reason"
          required
          minLength={5}
          maxLength={500}
          rows={2}
          hint={t(
            'Recorded in the audit trail of the account. The person is signed out everywhere and gets the new access at the next sign-in.',
          )}
        />
      )}
      <ErrorAlert error={update.error} />
      <div className="form-actions">
        <Button variant="secondary" onClick={onClose}>
          {t('Cancel')}
        </Button>
        <Button type="submit" loading={update.isPending}>
          {t('Save changes')}
        </Button>
      </div>
    </form>
  );
}
