import ExcelJS from 'exceljs';

/** Parses CSV (RFC 4180: quotes, embedded commas/newlines) into rows of strings. Detects ; or , separators. */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, '');
  const firstLine = src.slice(0, src.indexOf('\n') === -1 ? src.length : src.indexOf('\n'));
  const sep =
    (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ';' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      if (row.some((f) => f.trim() !== '')) rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== '')) rows.push(row);
  return rows;
}

/** Reads the first worksheet of an .xlsx as rows of strings (dates as ISO). */
export async function parseXlsx(buf: Buffer): Promise<string[][]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  const ws = wb.worksheets[0];
  if (!ws) return [];
  const rows: string[][] = [];
  ws.eachRow({ includeEmpty: false }, (r) => {
    const vals = (r.values as unknown[]).slice(1).map((v) => {
      if (v === null || v === undefined) return '';
      if (v instanceof Date) return v.toISOString();
      if (typeof v === 'object' && v !== null && 'result' in v)
        return String((v as { result: unknown }).result ?? '');
      if (typeof v === 'object' && v !== null && 'text' in v)
        return String((v as { text: unknown }).text ?? '');
      return String(v);
    });
    rows.push(vals);
  });
  return rows;
}

/** Maps header names (case/space-insensitive, with synonyms) to column indexes. */
export function headerIndex(
  header: string[],
  synonyms: Record<string, string[]>,
): Record<string, number> {
  const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const h = header.map(norm);
  const out: Record<string, number> = {};
  for (const [key, names] of Object.entries(synonyms)) {
    const idx = h.findIndex((x) => names.map(norm).includes(x));
    if (idx >= 0) out[key] = idx;
  }
  return out;
}

/** Parses common East African date formats: ISO, dd/mm/yyyy [hh:mm], dd-mm-yyyy, yyyy/mm/dd. */
export function parseDate(s: string, tzOffsetMinutes = 180): Date | null {
  const t = s.trim();
  if (!t) return null;
  if (/^\d{4}-\d{2}-\d{2}T/.test(t)) return new Date(t);
  let m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(t);
  if (m) {
    const y = m[3]!.length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    return new Date(
      Date.UTC(
        y,
        Number(m[2]) - 1,
        Number(m[1]),
        Number(m[4] ?? 12),
        Number(m[5] ?? 0),
        Number(m[6] ?? 0),
      ) -
        tzOffsetMinutes * 60_000,
    );
  }
  m = /^(\d{4})[/.-](\d{1,2})[/.-](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(t);
  if (m)
    return new Date(
      Date.UTC(
        Number(m[1]),
        Number(m[2]) - 1,
        Number(m[3]),
        Number(m[4] ?? 12),
        Number(m[5] ?? 0),
        Number(m[6] ?? 0),
      ) -
        tzOffsetMinutes * 60_000,
    );
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? null : d;
}

export const parseNumber = (s: string | undefined): number | null => {
  if (s === undefined) return null;
  const n = Number(s.replace(/[^\d.-]/g, ''));
  return s.trim() === '' || Number.isNaN(n) ? null : n;
};
