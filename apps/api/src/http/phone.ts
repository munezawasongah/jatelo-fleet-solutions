import { unprocessable } from './errors.js';

const COUNTRY_CODES: Record<string, string> = { KE: '254', TZ: '255', UG: '256', RW: '250' };

/**
 * Normalises East African phone numbers to E.164 (+2547...). Accepts local (0722 123 456), national (722123456),
 * international (254722123456, 00254..., +254...) forms. undefined = not provided, null/empty = clear.
 */
export function normalizePhone(
  raw: string | null | undefined,
  country: string,
): string | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || raw.trim() === '') return null;
  let d = raw.replace(/[\s\-().]/g, '');
  if (d.startsWith('00')) d = `+${d.slice(2)}`;
  const cc = COUNTRY_CODES[country.trim()] ?? '254';
  if (d.startsWith('+')) {
    if (/^\+[1-9]\d{7,14}$/.test(d)) return d;
  } else if (/^0\d{9}$/.test(d)) {
    return `+${cc}${d.slice(1)}`;
  } else if (/^[17]\d{8}$/.test(d)) {
    return `+${cc}${d}`;
  } else if (/^(254|255|256|250)\d{9}$/.test(d)) {
    return `+${d}`;
  }
  throw unprocessable('Phone number is not valid', { phone: raw });
}
