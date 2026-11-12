import { config, isProduction } from '../config.js';
import { logger } from '../logger.js';

/** Safaricom Daraja (M-Pesa Kenya) Lipa na M-Pesa Online / STK push. */
const HOST = config.MPESA_ENV === 'production' ? 'https://api.safaricom.co.ke' : 'https://sandbox.safaricom.co.ke';

export const mpesaConfigured = (): boolean =>
  Boolean(config.MPESA_CONSUMER_KEY && config.MPESA_CONSUMER_SECRET && config.MPESA_SHORTCODE && config.MPESA_PASSKEY && config.MPESA_CALLBACK_SECRET);

/** Without credentials outside production, STK pushes are simulated so the full flow can be demoed. */
export const mpesaSimulated = (): boolean => !mpesaConfigured() && !isProduction;

let token: { value: string; exp: number } | null = null;
async function accessToken(): Promise<string> {
  if (token && token.exp > Date.now() + 60_000) return token.value;
  const basic = Buffer.from(`${config.MPESA_CONSUMER_KEY}:${config.MPESA_CONSUMER_SECRET}`).toString('base64');
  const res = await fetch(`${HOST}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${basic}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`M-Pesa auth failed (HTTP ${res.status})`);
  const j = (await res.json()) as { access_token: string; expires_in: string };
  token = { value: j.access_token, exp: Date.now() + Number(j.expires_in) * 1000 };
  return token.value;
}

/** yyyyMMddHHmmss in East Africa Time, as Daraja expects. */
function timestamp(d = new Date()): string {
  const t = new Date(d.getTime() + 3 * 3_600_000);
  return t.toISOString().replace(/[-:T]/g, '').slice(0, 14);
}

/** Normalises 07xx / 01xx / +2547xx / 2547xx to 2547xxxxxxxx (Safaricom format). */
export function mpesaPhone(phone: string): string | null {
  const d = phone.replace(/[^\d]/g, '');
  const m = /^(?:254|0)?([17]\d{8})$/.exec(d);
  return m ? `254${m[1]}` : null;
}

export interface StkResult {
  merchantRequestId: string;
  checkoutRequestId: string;
  customerMessage: string;
}

export async function stkPush(opts: { phone: string; amount: number; reference: string; description: string }): Promise<StkResult> {
  if (mpesaSimulated()) {
    const id = `SIM-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return { merchantRequestId: id, checkoutRequestId: id, customerMessage: 'Simulated STK push (M-Pesa not configured): it will succeed in a few seconds' };
  }
  if (!mpesaConfigured()) throw new Error('M-Pesa is not configured');
  const ts = timestamp();
  const body = {
    BusinessShortCode: config.MPESA_SHORTCODE,
    Password: Buffer.from(`${config.MPESA_SHORTCODE}${config.MPESA_PASSKEY}${ts}`).toString('base64'),
    Timestamp: ts,
    TransactionType: config.MPESA_TRANSACTION_TYPE,
    Amount: Math.ceil(opts.amount),
    PartyA: opts.phone,
    PartyB: config.MPESA_SHORTCODE,
    PhoneNumber: opts.phone,
    CallBackURL: `${config.PUBLIC_API_URL}/api/v1/public/mpesa/callback/${config.MPESA_CALLBACK_SECRET}`,
    AccountReference: opts.reference.slice(0, 12),
    TransactionDesc: opts.description.slice(0, 13),
  };
  const res = await fetch(`${HOST}/mpesa/stkpush/v1/processrequest`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const j = (await res.json().catch(() => ({}))) as {
    MerchantRequestID?: string;
    CheckoutRequestID?: string;
    ResponseCode?: string;
    CustomerMessage?: string;
    errorMessage?: string;
  };
  if (!res.ok || j.ResponseCode !== '0' || !j.CheckoutRequestID) {
    logger.warn({ status: res.status, body: j }, 'M-Pesa STK push rejected');
    throw new Error(j.errorMessage ?? j.CustomerMessage ?? `M-Pesa request failed (HTTP ${res.status})`);
  }
  return { merchantRequestId: j.MerchantRequestID!, checkoutRequestId: j.CheckoutRequestID, customerMessage: j.CustomerMessage ?? 'Check your phone to complete payment' };
}

export interface StkCallback {
  MerchantRequestID: string;
  CheckoutRequestID: string;
  ResultCode: number;
  ResultDesc: string;
  CallbackMetadata?: { Item: { Name: string; Value?: string | number }[] };
}

export function callbackMeta(cb: StkCallback): { amount: number | null; receipt: string | null; phone: string | null } {
  const get = (n: string): string | number | undefined => cb.CallbackMetadata?.Item.find((i) => i.Name === n)?.Value;
  const amount = get('Amount');
  const receipt = get('MpesaReceiptNumber');
  const phone = get('PhoneNumber');
  return {
    amount: amount === undefined ? null : Number(amount),
    receipt: receipt === undefined ? null : String(receipt),
    phone: phone === undefined ? null : String(phone),
  };
}
