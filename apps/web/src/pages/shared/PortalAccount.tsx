import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { FormEvent } from 'react';
import {
  resetPortalTwoStep,
  sendPortalInvitation,
  type PatientWithPortal,
} from '../../api/patients';
import {
  Alert,
  Badge,
  Button,
  Dialog,
  ErrorAlert,
  formValues,
  TextAreaField,
  TextField,
} from '../../components/ui';
import { fullName } from '../../format';
import { t } from '../../i18n';

/**
 * The patient's portal account in the facility's patient lists, and what reception and directors
 * can do about it after verifying the patient's identity in person: invite, send the invitation
 * again while it is not accepted, reset a lost two-step sign-in. Only the state these actions need
 * is shown – never anything else about the account.
 */
export function PortalBadge({ patient }: { patient: PatientWithPortal }) {
  if (patient.portalAccount === 'PENDING') {
    return <Badge tone="warning">{t('Invitation not accepted yet')}</Badge>;
  }
  return patient.hasPortalAccount ? (
    <Badge tone="success">{t('Active')}</Badge>
  ) : (
    <Badge tone="neutral">{t('None')}</Badge>
  );
}

/** The portal actions that apply to this patient (none for an active account without two-step). */
export function PortalActions({
  patient,
  onInvite,
  onResetTwoStep,
}: {
  patient: PatientWithPortal;
  onInvite: () => void;
  onResetTwoStep: () => void;
}) {
  return (
    <>
      {!patient.hasPortalAccount && (
        <Button size="sm" variant="ghost" onClick={onInvite}>
          {t('Invite to portal')}
        </Button>
      )}
      {patient.portalAccount === 'PENDING' && (
        <Button size="sm" variant="ghost" onClick={onInvite}>
          {t('Send the invitation again')}
        </Button>
      )}
      {patient.portalTwoStep && (
        <Button size="sm" variant="ghost" onClick={onResetTwoStep}>
          {t('Reset two-step sign-in')}
        </Button>
      )}
    </>
  );
}

/** A first invitation, or a new link for an invitation not accepted yet. */
export function PortalInviteDialog({
  patient,
  onClose,
}: {
  patient: PatientWithPortal | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const invite = useMutation({
    mutationFn: sendPortalInvitation,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['patients'] });
    },
  });
  const close = () => {
    invite.reset();
    onClose();
  };
  const renew = patient?.portalAccount === 'PENDING';
  return (
    <Dialog
      open={patient !== null}
      onClose={close}
      title={renew ? t('Send the invitation again') : t('Invite to patient portal')}
    >
      {patient && (
        <div className="stack">
          {invite.isSuccess ? (
            <>
              <Alert
                tone="success"
                title={
                  invite.data.renewed ? t('A new invitation was sent.') : t('Invitation created.')
                }
              >
                {t('The patient chooses their own password through a single-use link.')}
              </Alert>
              {invite.data.activationUrl ? (
                <TextField
                  label={t('Activation link (development only — sent by email in production)')}
                  readOnly
                  value={invite.data.activationUrl}
                  onFocus={(e) => e.currentTarget.select()}
                />
              ) : (
                <p className="muted">
                  {t('The activation link was sent to the patient’s email address.')}
                </p>
              )}
              <div className="form-actions">
                <Button onClick={close}>{t('Done')}</Button>
              </div>
            </>
          ) : (
            <>
              <p>
                {renew
                  ? t(
                      '{name} has not activated their portal account yet. A new single-use link replaces the earlier ones, which stop working.',
                      { name: fullName(patient) },
                    )
                  : t('Create an online portal account for {name}.', {
                      name: fullName(patient),
                    })}{' '}
                {t(
                  'The invitation goes to the email address on file; add one first if it is missing.',
                )}
              </p>
              {renew && (
                <Alert tone="info">
                  {t('Check the patient’s identity and email address before sending it.')}
                </Alert>
              )}
              <ErrorAlert error={invite.error} />
              <div className="form-actions">
                <Button variant="secondary" onClick={close}>
                  {t('Cancel')}
                </Button>
                <Button loading={invite.isPending} onClick={() => invite.mutate(patient.id)}>
                  {renew ? t('Send the invitation again') : t('Send invitation')}
                </Button>
              </div>
            </>
          )}
        </div>
      )}
    </Dialog>
  );
}

/** Reception and directors: a patient who lost their authenticator app and recovery codes. */
export function TwoStepResetDialog({
  patient,
  onClose,
}: {
  patient: PatientWithPortal | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const reset = useMutation({
    mutationFn: resetPortalTwoStep,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['patients'] });
    },
  });
  const close = () => {
    reset.reset();
    onClose();
  };
  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!patient) return;
    reset.mutate({ patientId: patient.id, reason: formValues(e.currentTarget).reason ?? '' });
  }
  return (
    <Dialog open={patient !== null} onClose={close} title={t('Reset two-step sign-in')}>
      {patient &&
        (reset.isSuccess ? (
          <div className="stack">
            <Alert tone="success" title={t('Two-step sign-in was reset.')}>
              {t(
                '{name} was signed out everywhere and sets up two-step sign-in again at the next sign-in.',
                { name: fullName(patient) },
              )}
            </Alert>
            <div className="form-actions">
              <Button onClick={close}>{t('Done')}</Button>
            </div>
          </div>
        ) : (
          <form className="stack" onSubmit={onSubmit}>
            <Alert tone="warning" title={t('Verify the patient’s identity in person first.')}>
              {t(
                'For a patient who lost their authenticator app and recovery codes. Every second factor of the portal account of {name} is removed; they are signed out everywhere, are told, and set up two-step sign-in again at their next sign-in.',
                { name: fullName(patient) },
              )}
            </Alert>
            <TextAreaField
              label={t('Reason')}
              name="reason"
              required
              minLength={5}
              maxLength={500}
              rows={2}
              hint={t('For example, how the identity was verified. Kept in the audit trail.')}
            />
            <ErrorAlert error={reset.error} />
            <div className="form-actions">
              <Button variant="secondary" onClick={close}>
                {t('Cancel')}
              </Button>
              <Button type="submit" variant="danger" loading={reset.isPending}>
                {t('Reset two-step sign-in')}
              </Button>
            </div>
          </form>
        ))}
    </Dialog>
  );
}
