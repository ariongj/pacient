import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import {
  FACILITY_ROLES,
  INVITABLE_ROLES,
  LICENSED_ROLES,
  roleLabel,
  useFacilityOptions,
  useInvite,
  type InvitableRole,
  type InviteResult,
} from '../../../api/adminUsers';
import {
  Alert,
  Button,
  ErrorAlert,
  formValues,
  SelectField,
  TextField,
} from '../../../components/ui';
import { t } from '../../../i18n';
import { ActivationLink } from './ActivationLink';

/**
 * Invite an account: staff of a facility, a Ministry official or another platform administrator.
 * The person chooses their own password through a single-use activation link.
 */
export function InviteForm({ onClose }: { onClose: () => void }) {
  const invite = useInvite();
  const facilities = useFacilityOptions();
  const [role, setRole] = useState<InvitableRole>('DOCTOR');
  const [result, setResult] = useState<InviteResult | null>(null);
  const needsFacility = FACILITY_ROLES.includes(role);
  const licensed = LICENSED_ROLES.includes(role);

  if (result) {
    return (
      <div className="stack">
        <Alert tone="success" title={t('{name} has been invited.', { name: result.user.fullName })}>
          {t(
            'They choose their own password through a single-use activation link (valid 72 hours).',
          )}
        </Alert>
        <ActivationLink url={result.activationUrl} email={result.user.email} />
        <div className="form-actions">
          <Link className="btn btn-secondary" to={`/admin/users/${result.user.id}`}>
            {t('Open account')}
          </Link>
          <Button onClick={onClose}>{t('Done')}</Button>
        </div>
      </div>
    );
  }

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const v = formValues(e.currentTarget);
    invite.mutate(
      {
        email: v.email!,
        fullName: v.fullName!,
        role,
        facilityId: needsFacility ? v.facilityId : null,
        specialty: v.specialty || null,
        licenseNumber: licensed ? v.licenseNumber : null,
      },
      { onSuccess: setResult },
    );
  }

  return (
    <form onSubmit={onSubmit}>
      <div className="form-grid">
        <TextField
          label={t('Full name')}
          name="fullName"
          required
          minLength={2}
          maxLength={200}
          autoComplete="off"
        />
        <TextField
          label={t('Email')}
          name="email"
          type="email"
          required
          maxLength={254}
          autoComplete="off"
        />
        <SelectField
          label={t('Role')}
          name="role"
          required
          value={role}
          onChange={(e) => setRole(e.target.value as InvitableRole)}
          options={INVITABLE_ROLES.map((r) => ({ value: r, label: roleLabel(r) }))}
        />
        {needsFacility && (
          <SelectField
            label={t('Facility')}
            name="facilityId"
            required
            placeholder={facilities.isPending ? t('Loading…') : t('Choose…')}
            options={(facilities.data ?? []).map((f) => ({ value: f.id, label: f.name }))}
          />
        )}
        {role === 'DOCTOR' && <TextField label={t('Specialty')} name="specialty" maxLength={120} />}
        {licensed && (
          <TextField
            label={t('Professional licence number')}
            name="licenseNumber"
            required
            maxLength={60}
            hint={t('As in the register of the professional chamber.')}
          />
        )}
      </div>
      {role === 'ADMIN' && (
        <Alert tone="warning">
          {t(
            'A platform administrator manages every account, subscription and setting of the service. Invite only people who operate the service.',
          )}
        </Alert>
      )}
      {role === 'MINISTRY' && (
        <p className="muted">
          {t('Ministry officials do not belong to a facility and see national figures only.')}
        </p>
      )}
      <ErrorAlert error={invite.error} />
      <div className="form-actions">
        <Button variant="secondary" onClick={onClose}>
          {t('Cancel')}
        </Button>
        <Button type="submit" loading={invite.isPending}>
          {t('Send invitation')}
        </Button>
      </div>
    </form>
  );
}
