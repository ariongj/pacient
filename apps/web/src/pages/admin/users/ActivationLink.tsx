import { useState } from 'react';
import { Button, TextField } from '../../../components/ui';
import { t } from '../../../i18n';

/**
 * The activation link of an invitation. Outside production it is shown once to copy; in production
 * it goes only to the person's own e-mail address.
 */
export function ActivationLink({ url, email }: { url: string | null; email: string }) {
  const [copied, setCopied] = useState(false);
  if (!url) {
    return (
      <p className="muted">
        {t(
          'An e-mail with the activation link is on its way to {email}. If it does not arrive, renew the link on the account page.',
          { email },
        )}
      </p>
    );
  }
  return (
    <div className="stack">
      <TextField
        label={t('Activation link')}
        readOnly
        value={url}
        onFocus={(e) => e.currentTarget.select()}
      />
      <div className="row">
        <Button
          variant="secondary"
          onClick={async () => {
            await navigator.clipboard.writeText(url);
            setCopied(true);
          }}
        >
          {copied ? `${t('Copied')} ✓` : t('Copy link')}
        </Button>
        <span className="muted" role="status">
          {t('Development only — in production the link is delivered by email.')}
        </span>
      </div>
    </div>
  );
}
