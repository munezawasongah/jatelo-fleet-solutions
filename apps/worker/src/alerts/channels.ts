import { createDecipheriv, createHmac, createSign } from 'node:crypto';
import nodemailer from 'nodemailer';
import { config } from '../config.js';
import { logger } from '../logger.js';

export interface SendResult {
  status: 'sent' | 'skipped' | 'failed';
  provider: string;
  providerMessageId?: string;
  cost?: number;
  costCurrency?: string;
  error?: string;
}

// ---------------------------------------------------------------- SMS: Africa's Talking (KE, TZ, UG, RW)
export async function sendSms(to: string, text: string): Promise<SendResult> {
  if (!config.AT_USERNAME || !config.AT_API_KEY) {
    logger.info({ to, text }, "SMS (Africa's Talking not configured - logged instead of sent)");
    return { status: 'skipped', provider: 'log' };
  }
  const host =
    config.AT_USERNAME === 'sandbox'
      ? 'https://api.sandbox.africastalking.com'
      : 'https://api.africastalking.com';
  const body = new URLSearchParams({
    username: config.AT_USERNAME,
    to,
    message: text.slice(0, 459),
  });
  if (config.AT_SENDER_ID) body.set('from', config.AT_SENDER_ID);
  const res = await fetch(`${host}/version1/messaging`, {
    method: 'POST',
    headers: {
      apiKey: config.AT_API_KEY,
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Africa's Talking HTTP ${res.status}`);
  const json = (await res.json()) as {
    SMSMessageData?: { Recipients?: { status: string; messageId: string; cost: string }[] };
  };
  const r = json.SMSMessageData?.Recipients?.[0];
  if (!r || !/success/i.test(r.status))
    return { status: 'failed', provider: 'africastalking', error: r?.status ?? 'no recipient' };
  const [cur, amount] = (r.cost ?? '').split(' ');
  return {
    status: 'sent',
    provider: 'africastalking',
    providerMessageId: r.messageId,
    cost: Number(amount) || undefined,
    costCurrency: ['KES', 'TZS', 'UGX', 'RWF', 'USD'].includes(cur ?? '') ? cur : undefined,
  };
}

// ---------------------------------------------------------------- email
const mail = config.SMTP_URL ? nodemailer.createTransport(config.SMTP_URL) : null;
export async function sendEmail(
  to: string,
  subject: string,
  text: string,
  html: string,
  attachments?: { filename: string; content: Buffer; contentType: string }[],
): Promise<SendResult> {
  if (!mail) {
    logger.info({ to, subject, attachments: attachments?.map((x) => `${x.filename} (${x.content.length} B)`) }, 'email (SMTP not configured - logged instead of sent)');
    return { status: 'skipped', provider: 'log' };
  }
  const info = await mail.sendMail({ from: config.MAIL_FROM, to, subject, text, html, attachments });
  return { status: 'sent', provider: 'smtp', providerMessageId: info.messageId };
}

// ---------------------------------------------------------------- push: Firebase Cloud Messaging HTTP v1
let fcmToken: { value: string; exp: number } | null = null;
async function fcmAccessToken(sa: { client_email: string; private_key: string }): Promise<string> {
  if (fcmToken && fcmToken.exp > Date.now() + 60_000) return fcmToken.value;
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  })}`;
  const sig = createSign('RSA-SHA256').update(unsigned).sign(sa.private_key, 'base64url');
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${unsigned}.${sig}`,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`FCM auth HTTP ${res.status}`);
  const j = (await res.json()) as { access_token: string; expires_in: number };
  fcmToken = { value: j.access_token, exp: Date.now() + j.expires_in * 1000 };
  return j.access_token;
}

/** Returns 'invalid_token' as error when FCM says the token is gone so the caller can delete it. */
export async function sendPush(
  token: string,
  title: string,
  body: string,
  data: Record<string, string>,
): Promise<SendResult> {
  if (!config.FCM_SERVICE_ACCOUNT_JSON) {
    logger.info({ title }, 'push (FCM not configured - skipped)');
    return { status: 'skipped', provider: 'log' };
  }
  const sa = JSON.parse(config.FCM_SERVICE_ACCOUNT_JSON) as {
    project_id: string;
    client_email: string;
    private_key: string;
  };
  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${await fcmAccessToken(sa)}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      message: { token, notification: { title, body }, data, android: { priority: 'high' } },
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 404 || res.status === 400)
    return { status: 'failed', provider: 'fcm', error: 'invalid_token' };
  if (!res.ok) throw new Error(`FCM HTTP ${res.status}`);
  const j = (await res.json()) as { name?: string };
  return { status: 'sent', provider: 'fcm', providerMessageId: j.name };
}

// ---------------------------------------------------------------- webhooks (HMAC-SHA256 signed)
function decrypt(payload: string): string {
  if (!config.MFA_ENCRYPTION_KEY)
    throw new Error('MFA_ENCRYPTION_KEY is required to sign webhooks');
  const [, iv, tag, ct] = payload.split(':');
  const d = createDecipheriv(
    'aes-256-gcm',
    Buffer.from(config.MFA_ENCRYPTION_KEY, 'base64'),
    Buffer.from(iv!, 'base64'),
  );
  d.setAuthTag(Buffer.from(tag!, 'base64'));
  return Buffer.concat([d.update(Buffer.from(ct!, 'base64')), d.final()]).toString('utf8');
}

export async function sendWebhook(
  url: string,
  secretEnc: string,
  event: string,
  payload: unknown,
): Promise<SendResult & { httpStatus?: number }> {
  const body = JSON.stringify({ event, sent_at: new Date().toISOString(), data: payload });
  const ts = Math.floor(Date.now() / 1000).toString();
  const sig = createHmac('sha256', decrypt(secretEnc)).update(`${ts}.${body}`).digest('hex');
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'JateloFleet-Webhook/1.0',
      'X-Jatelo-Event': event,
      'X-Jatelo-Signature': `t=${ts},v1=${sig}`,
    },
    body,
    redirect: 'manual',
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok)
    return {
      status: 'failed',
      provider: 'webhook',
      error: `HTTP ${res.status}`,
      httpStatus: res.status,
    };
  return { status: 'sent', provider: 'webhook', httpStatus: res.status };
}
