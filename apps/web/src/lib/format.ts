let tz = 'Africa/Nairobi';
let currency = 'KES';
export function setTenantFormat(timezone?: string, cur?: string): void {
  if (timezone) tz = timezone;
  if (cur) currency = cur;
}
export const tenantTz = (): string => tz;
export const tenantCurrency = (): string => currency;

const toDate = (v: unknown): Date | null => {
  if (v === null || v === undefined || v === '') return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
};

export function fmtDateTime(v: unknown): string {
  const d = toDate(v);
  return d ? new Intl.DateTimeFormat('en-GB', { timeZone: tz, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(d) : '—';
}
export function fmtDate(v: unknown): string {
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const [y, m, d] = v.split('-').map(Number) as [number, number, number];
    return new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, d)));
  }
  const d = toDate(v);
  return d ? new Intl.DateTimeFormat('en-GB', { timeZone: tz, day: '2-digit', month: 'short', year: 'numeric' }).format(d) : '—';
}
export function fmtTime(v: unknown): string {
  const d = toDate(v);
  return d ? new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(d) : '—';
}
export function fmtAgo(v: unknown, lang: 'en' | 'sw' = 'en'): string {
  const d = toDate(v);
  if (!d) return '—';
  const s = Math.round((Date.now() - d.getTime()) / 1000);
  const rtf = new Intl.RelativeTimeFormat(lang, { numeric: 'auto' });
  if (Math.abs(s) < 60) return rtf.format(-s, 'second');
  if (Math.abs(s) < 3600) return rtf.format(-Math.round(s / 60), 'minute');
  if (Math.abs(s) < 86400) return rtf.format(-Math.round(s / 3600), 'hour');
  return rtf.format(-Math.round(s / 86400), 'day');
}
export function fmtNum(v: unknown, dp = 0): string {
  if (v === null || v === undefined || v === '') return '—';
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: dp, minimumFractionDigits: 0 }) : '—';
}
export function fmtMoney(v: unknown, cur = currency): string {
  if (v === null || v === undefined || v === '') return '—';
  const n = Number(v);
  return `${cur} ${n.toLocaleString('en-US', { minimumFractionDigits: cur === 'UGX' || cur === 'TZS' || cur === 'RWF' ? 0 : 2, maximumFractionDigits: 2 })}`;
}
export function fmtDuration(seconds: unknown): string {
  const s = Number(seconds);
  if (!Number.isFinite(s)) return '—';
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
}
/** YYYY-MM-DD in the company time zone. */
export function isoDay(d = new Date(), offsetDays = 0): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(d.getTime() + offsetDays * 86_400_000));
}
/** Value for <input type="datetime-local"> in the browser's zone. */
export function toLocalInput(v: unknown): string {
  const d = toDate(v);
  if (!d) return '';
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
export const fromLocalInput = (s: string): string | null => (s ? new Date(s).toISOString() : null);
