import { env } from '../../config/env.js';

/**
 * Email templates. Emails never contain clinical information: they say that something happened and
 * link to the app, where access is checked. Links are absolute URLs to WEB_APP_URL.
 */
export type EmailTemplate =
  | { template: 'activation'; name: string; url: string }
  | { template: 'password_reset'; name: string; url: string }
  | { template: 'notification'; name: string; title: string; link: string | null };

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

const escape = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

const absolute = (link: string | null) =>
  link
    ? new URL(
        link,
        env.WEB_APP_URL.endsWith('/') ? env.WEB_APP_URL : `${env.WEB_APP_URL}/`,
      ).toString()
    : env.WEB_APP_URL;

function layout(opts: {
  heading: string;
  paragraphs: string[];
  cta: { label: string; url: string };
  footer: string;
}) {
  const p = opts.paragraphs
    .map((t) => `<p style="margin:0 0 14px;line-height:1.5">${escape(t)}</p>`)
    .join('');
  return `<!doctype html><html lang="en"><body style="margin:0;background:#f5f7f8;font-family:Segoe UI,Roboto,Arial,sans-serif;color:#14212b">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid #d9e0e5;border-radius:10px">
<tr><td style="padding:18px 24px;border-bottom:1px solid #d9e0e5"><strong style="font-size:18px;color:#0f766e">+ Pacient</strong></td></tr>
<tr><td style="padding:24px">
<h1 style="font-size:20px;margin:0 0 16px">${escape(opts.heading)}</h1>${p}
<p style="margin:22px 0"><a href="${escape(opts.cta.url)}" style="background:#0f766e;color:#ffffff;text-decoration:none;padding:11px 18px;border-radius:6px;font-weight:600;display:inline-block">${escape(opts.cta.label)}</a></p>
<p style="margin:0;color:#55636f;font-size:13px;line-height:1.5">If the button does not work, copy this address into your browser:<br><span style="word-break:break-all">${escape(opts.cta.url)}</span></p>
</td></tr>
<tr><td style="padding:16px 24px;border-top:1px solid #d9e0e5;color:#55636f;font-size:12px;line-height:1.5">${escape(opts.footer)}</td></tr>
</table></td></tr></table></body></html>`;
}

const FOOTER_NOTIFY =
  'You receive this because email notifications are on for your Pacient account. For your privacy we never include health information in emails. Change this under My details / Account. In an emergency call 112.';
const FOOTER_SECURITY =
  'If you did not expect this email you can ignore it. Pacient staff will never ask you for your password.';

export function render(t: EmailTemplate): RenderedEmail {
  switch (t.template) {
    case 'activation': {
      const paragraphs = [
        `Hello ${t.name},`,
        'An account has been created for you in Pacient. Choose your own password to activate it. The link works once and expires in 72 hours.',
      ];
      return {
        subject: 'Activate your Pacient account',
        text: `${paragraphs.join('\n\n')}\n\nActivate your account: ${t.url}\n\n${FOOTER_SECURITY}\n`,
        html: layout({
          heading: 'Activate your account',
          paragraphs,
          cta: { label: 'Choose a password', url: t.url },
          footer: FOOTER_SECURITY,
        }),
      };
    }
    case 'password_reset': {
      const paragraphs = [
        `Hello ${t.name},`,
        'We received a request to reset your Pacient password. The link works once and expires in one hour. Resetting signs you out on all devices.',
      ];
      return {
        subject: 'Reset your Pacient password',
        text: `${paragraphs.join('\n\n')}\n\nReset your password: ${t.url}\n\n${FOOTER_SECURITY}\n`,
        html: layout({
          heading: 'Reset your password',
          paragraphs,
          cta: { label: 'Reset password', url: t.url },
          footer: FOOTER_SECURITY,
        }),
      };
    }
    case 'notification': {
      const url = absolute(t.link);
      const paragraphs = [
        `Hello ${t.name},`,
        `${t.title}.`,
        'Sign in to Pacient to see the details.',
      ];
      return {
        subject: `Pacient: ${t.title}`,
        text: `${paragraphs.join('\n\n')}\n\nOpen Pacient: ${url}\n\n${FOOTER_NOTIFY}\n`,
        html: layout({
          heading: t.title,
          paragraphs,
          cta: { label: 'Open Pacient', url },
          footer: FOOTER_NOTIFY,
        }),
      };
    }
  }
}
