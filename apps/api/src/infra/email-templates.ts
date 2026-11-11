import type { Mail } from './mailer.js';

type Locale = 'en' | 'sw';

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function render(
  subject: string,
  paragraphs: string[],
  link: { url: string; label: string },
): Omit<Mail, 'to'> {
  const text = [
    ...paragraphs.slice(0, 2),
    link.url,
    ...paragraphs.slice(2),
    'Jatelo Technologies',
  ].join('\n\n');
  const html = `<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;color:#0f172a;line-height:1.5;max-width:560px;margin:auto;padding:24px">
<h2 style="color:#1d4ed8;margin:0 0 16px">Jatelo Fleet Solutions</h2>
${paragraphs
  .slice(0, 2)
  .map((p) => `<p>${escapeHtml(p)}</p>`)
  .join('\n')}
<p><a href="${escapeHtml(link.url)}" style="display:inline-block;background:#1d4ed8;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none">${escapeHtml(link.label)}</a></p>
${paragraphs
  .slice(2)
  .map((p) => `<p style="color:#475569;font-size:14px">${escapeHtml(p)}</p>`)
  .join('\n')}
<p style="color:#94a3b8;font-size:12px">Jatelo Technologies</p></body></html>`;
  return { subject, text, html };
}

export function passwordResetEmail(locale: Locale, name: string, url: string): Omit<Mail, 'to'> {
  return locale === 'sw'
    ? render(
        'Badilisha nenosiri lako la Jatelo Fleet',
        [
          `Habari ${name},`,
          'Tumepokea ombi la kubadilisha nenosiri lako. Bonyeza kitufe hapa chini ndani ya dakika 60:',
          'Ikiwa hukuomba hili, puuza barua pepe hii; nenosiri lako halitabadilika.',
        ],
        { url, label: 'Badilisha nenosiri' },
      )
    : render(
        'Reset your Jatelo Fleet password',
        [
          `Hello ${name},`,
          'We received a request to reset your password. Use the button below within 60 minutes:',
          'If you did not request this, you can ignore this email and your password will not change.',
        ],
        { url, label: 'Reset password' },
      );
}

export function inviteEmail(
  locale: Locale,
  name: string,
  company: string,
  url: string,
): Omit<Mail, 'to'> {
  return locale === 'sw'
    ? render(
        `Umealikwa kujiunga na ${company} kwenye Jatelo Fleet`,
        [
          `Habari ${name},`,
          `${company} imekualika kutumia Jatelo Fleet Solutions. Weka nenosiri lako ndani ya siku 7:`,
          'Ikiwa hukutarajia mwaliko huu, puuza barua pepe hii.',
        ],
        { url, label: 'Kubali mwaliko' },
      )
    : render(
        `You've been invited to ${company} on Jatelo Fleet`,
        [
          `Hello ${name},`,
          `${company} has invited you to Jatelo Fleet Solutions. Set your password within 7 days:`,
          'If you were not expecting this invitation, you can ignore this email.',
        ],
        { url, label: 'Accept invitation' },
      );
}
