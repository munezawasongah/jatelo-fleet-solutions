import nodemailer from 'nodemailer';
import { config, isProduction } from '../config.js';
import { logger } from '../logger.js';

export interface Mail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

const transport = config.SMTP_URL ? nodemailer.createTransport(config.SMTP_URL) : null;
if (!transport && isProduction)
  logger.warn('SMTP_URL is not set - emails will be logged, not sent');

/** Sends an email via SMTP, or logs it when SMTP is not configured (local development). */
export async function sendMail(mail: Mail): Promise<void> {
  if (!transport) {
    logger.info(
      { to: mail.to, subject: mail.subject, body: mail.text },
      'email (SMTP not configured - logged instead of sent)',
    );
    return;
  }
  await transport.sendMail({
    from: config.MAIL_FROM,
    to: mail.to,
    subject: mail.subject,
    text: mail.text,
    html: mail.html,
  });
}
