import { env } from '../../config/env.js';
import { tr, type Locale } from '../../i18n/index.js';

/**
 * Email templates. Emails never contain clinical information: they say that something happened and
 * link to the app, where access is checked. Links are absolute URLs to WEB_APP_URL.
 */
/** Every email is written in the recipient's language. */
export type EmailTemplate = { locale: Locale } & (
  | { template: 'activation'; name: string; url: string }
  | { template: 'password_reset'; name: string; url: string }
  /** `title` is already in the recipient's language. */
  | { template: 'notification'; name: string; title: string; link: string | null }
);

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
  locale: Locale;
  heading: string;
  paragraphs: string[];
  cta: { label: string; url: string };
  footer: string;
}) {
  const p = opts.paragraphs
    .map((t) => `<p style="margin:0 0 14px;line-height:1.5">${escape(t)}</p>`)
    .join('');
  return `<!doctype html><html lang="${opts.locale}"><body style="margin:0;background:#f5f7f8;font-family:Segoe UI,Roboto,Arial,sans-serif;color:#14212b">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid #d9e0e5;border-radius:10px">
<tr><td style="padding:18px 24px;border-bottom:1px solid #d9e0e5"><strong style="font-size:18px;color:#0f766e">+ Pacient</strong></td></tr>
<tr><td style="padding:24px">
<h1 style="font-size:20px;margin:0 0 16px">${escape(opts.heading)}</h1>${p}
<p style="margin:22px 0"><a href="${escape(opts.cta.url)}" style="background:#0f766e;color:#ffffff;text-decoration:none;padding:11px 18px;border-radius:6px;font-weight:600;display:inline-block">${escape(opts.cta.label)}</a></p>
<p style="margin:0;color:#55636f;font-size:13px;line-height:1.5">${escape(tr(opts.locale, 'If the button does not work, copy this address into your browser:'))}<br><span style="word-break:break-all">${escape(opts.cta.url)}</span></p>
</td></tr>
<tr><td style="padding:16px 24px;border-top:1px solid #d9e0e5;color:#55636f;font-size:12px;line-height:1.5">${escape(opts.footer)}</td></tr>
</table></td></tr></table></body></html>`;
}

const FOOTER_NOTIFY =
  'You receive this because email notifications are on for your Pacient account. For your privacy we never include health information in emails. Change this under My details / Account. In an emergency call 112.';
const FOOTER_SECURITY =
  'If you did not expect this email you can ignore it. Pacient staff will never ask you for your password.';

export function render(t: EmailTemplate): RenderedEmail {
  const l = t.locale;
  const hello = tr(l, 'Hello {name},', { name: t.name });
  switch (t.template) {
    case 'activation': {
      const footer = tr(l, FOOTER_SECURITY);
      const paragraphs = [
        hello,
        tr(
          l,
          'An account has been created for you in Pacient. Choose your own password to activate it. The link works once and expires in 72 hours.',
        ),
      ];
      return {
        subject: tr(l, 'Activate your Pacient account'),
        text: `${paragraphs.join('\n\n')}\n\n${tr(l, 'Activate your account: {url}', { url: t.url })}\n\n${footer}\n`,
        html: layout({
          locale: l,
          heading: tr(l, 'Activate your account'),
          paragraphs,
          cta: { label: tr(l, 'Choose a password'), url: t.url },
          footer,
        }),
      };
    }
    case 'password_reset': {
      const footer = tr(l, FOOTER_SECURITY);
      const paragraphs = [
        hello,
        tr(
          l,
          'We received a request to reset your Pacient password. The link works once and expires in one hour. Resetting signs you out on all devices.',
        ),
      ];
      return {
        subject: tr(l, 'Reset your Pacient password'),
        text: `${paragraphs.join('\n\n')}\n\n${tr(l, 'Reset your password: {url}', { url: t.url })}\n\n${footer}\n`,
        html: layout({
          locale: l,
          heading: tr(l, 'Reset your password'),
          paragraphs,
          cta: { label: tr(l, 'Reset password'), url: t.url },
          footer,
        }),
      };
    }
    case 'notification': {
      const url = absolute(t.link);
      const footer = tr(l, FOOTER_NOTIFY);
      const paragraphs = [hello, `${t.title}.`, tr(l, 'Sign in to Pacient to see the details.')];
      return {
        subject: tr(l, 'Pacient: {title}', { title: t.title }),
        text: `${paragraphs.join('\n\n')}\n\n${tr(l, 'Open Pacient: {url}', { url })}\n\n${footer}\n`,
        html: layout({
          locale: l,
          heading: t.title,
          paragraphs,
          cta: { label: tr(l, 'Open Pacient'), url },
          footer,
        }),
      };
    }
  }
}
