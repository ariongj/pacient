import { useState, type FormEvent } from 'react';
import { useAccountAction, type AccountAction, type AccountDetail } from '../../../api/adminUsers';
import {
  Alert,
  Button,
  Dialog,
  ErrorAlert,
  formValues,
  TextAreaField,
} from '../../../components/ui';
import { t } from '../../../i18n';
import { ActivationLink } from './ActivationLink';

interface ActionText {
  title: () => string;
  body: (u: AccountDetail) => string;
  confirm: () => string;
  done: () => string;
  reason: 'required' | 'optional' | 'none';
  danger?: boolean;
}

/** What each account action does, in plain words, before it is confirmed. */
export const ACTIONS: Record<AccountAction, ActionText> = {
  disable: {
    title: () => t('Disable account'),
    body: () =>
      t(
        'The person is signed out everywhere and cannot sign in until the account is enabled again. Everything they recorded stays in the records.',
      ),
    confirm: () => t('Disable account'),
    done: () => t('The account is disabled.'),
    reason: 'required',
    danger: true,
  },
  enable: {
    title: () => t('Enable account'),
    body: () => t('The person can sign in again with their password.'),
    confirm: () => t('Enable account'),
    done: () => t('The account is enabled.'),
    reason: 'optional',
  },
  unlock: {
    title: () => t('Unlock account'),
    body: () =>
      t('Clears the failed sign-in attempts, so the person can sign in again straight away.'),
    confirm: () => t('Unlock account'),
    done: () => t('The account is unlocked.'),
    reason: 'none',
  },
  'password-reset': {
    title: () => t('Send password reset e-mail'),
    body: (u) =>
      t('An e-mail with a link to choose a new password goes to {email}. You never see the link.', {
        email: u.email,
      }),
    confirm: () => t('Send e-mail'),
    done: () => t('The password reset e-mail is on its way.'),
    reason: 'none',
  },
  'mfa-reset': {
    title: () => t('Reset two-step sign-in'),
    body: () =>
      t(
        'Removes the authenticator app, recovery codes and passkeys of this account and signs the person out everywhere. They set up two-step sign-in again at their next sign-in and are told about the reset. Only do this after confirming who is asking, for example in person or through a phone number you already know.',
      ),
    confirm: () => t('Reset two-step sign-in'),
    done: () => t('Two-step sign-in is reset; the person sets it up again at the next sign-in.'),
    reason: 'required',
    danger: true,
  },
  'revoke-sessions': {
    title: () => t('Sign out everywhere'),
    body: () =>
      t(
        'Ends every session of this account on every device. The person signs in again with their password and second step.',
      ),
    confirm: () => t('Sign out everywhere'),
    done: () => t('The person is signed out everywhere.'),
    reason: 'none',
  },
  'resend-invitation': {
    title: () => t('Renew activation link'),
    body: (u) =>
      t(
        'Earlier activation links stop working. A new link, valid for 72 hours, is e-mailed to {email}.',
        { email: u.email },
      ),
    confirm: () => t('Renew link'),
    done: () => t('A new activation link is on its way.'),
    reason: 'none',
  },
};

/** Confirms one account action (with a reason where one is required) and reports the outcome. */
export function ActionDialog({
  user,
  action,
  onClose,
  onDone,
}: {
  user: AccountDetail;
  action: AccountAction | null;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const run = useAccountAction(user.id);
  const [link, setLink] = useState<string | null | undefined>(undefined);
  const text = action ? ACTIONS[action] : null;

  function close() {
    run.reset();
    setLink(undefined);
    onClose();
  }

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!action || !text) return;
    const { reason } = formValues(e.currentTarget);
    run.mutate(
      { action, reason: reason?.trim() || undefined },
      {
        onSuccess: (page) => {
          if (action === 'resend-invitation') {
            // Show the new link (outside production) before closing.
            setLink(page.activationUrl ?? null);
            return;
          }
          onDone(text.done());
          close();
        },
      },
    );
  }

  return (
    <Dialog open={Boolean(action)} onClose={close} title={text ? text.title() : ''}>
      {text && link !== undefined ? (
        <div className="stack">
          <Alert tone="success" title={text.done()} />
          <ActivationLink url={link} email={user.email} />
          <div className="form-actions">
            <Button
              onClick={() => {
                onDone(text.done());
                close();
              }}
            >
              {t('Done')}
            </Button>
          </div>
        </div>
      ) : (
        text && (
          <form onSubmit={onSubmit}>
            <p>
              <strong>{user.fullName}</strong> · {user.email}
            </p>
            <p>{text.body(user)}</p>
            {text.reason !== 'none' && (
              <TextAreaField
                label={text.reason === 'required' ? t('Reason') : t('Reason (optional)')}
                name="reason"
                required={text.reason === 'required'}
                minLength={5}
                maxLength={500}
                rows={2}
                hint={t('Recorded in the audit trail of the account.')}
              />
            )}
            <ErrorAlert error={run.error} />
            <div className="form-actions">
              <Button variant="secondary" onClick={close}>
                {t('Cancel')}
              </Button>
              <Button
                type="submit"
                variant={text.danger ? 'danger' : 'primary'}
                loading={run.isPending}
              >
                {text.confirm()}
              </Button>
            </div>
          </form>
        )
      )}
    </Dialog>
  );
}
