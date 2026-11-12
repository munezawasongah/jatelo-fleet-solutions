import { buildReport, nextRunAt, periodFor, renderReport, type Locale, type ReportFormat, type ReportType } from '@jfs/reports';
import { sendEmail } from '../alerts/channels.js';
import { db } from '../infra.js';
import { logger } from '../logger.js';

interface Schedule {
  id: string;
  tenant_id: string;
  name: string;
  report_type: ReportType;
  filters: { vehicle_ids?: string[]; group_id?: string; driver_ids?: string[] };
  format: ReportFormat;
  frequency: 'daily' | 'weekly' | 'monthly';
  send_time: string;
  day_of_week: number | null;
  day_of_month: number | null;
  locale: Locale;
  recipients: string[];
  timezone: string;
  tenant_name: string;
}

/** Runs due report schedules: builds the report for the last full period, emails it to the recipients, records the run. */
export async function runScheduledReports(): Promise<{ sent: number; failed: number }> {
  let sent = 0;
  let failed = 0;
  for (let i = 0; i < 50; i++) {
    const c = await db.connect();
    let s: Schedule | undefined;
    try {
      await c.query('BEGIN');
      s = (
        await c.query<Schedule>(
          `SELECT rs.id, rs.tenant_id, rs.name, rs.report_type, rs.filters, rs.format, rs.frequency, rs.send_time::text, rs.day_of_week, rs.day_of_month,
             rs.locale, rs.recipients, t.timezone, t.name AS tenant_name
           FROM report_schedules rs JOIN tenants t ON t.id = rs.tenant_id AND t.status IN ('trial', 'active') AND t.deleted_at IS NULL
           WHERE rs.is_active AND rs.deleted_at IS NULL AND rs.next_run_at <= now()
           ORDER BY rs.next_run_at LIMIT 1 FOR UPDATE OF rs SKIP LOCKED`,
        )
      ).rows[0];
      if (!s) {
        await c.query('COMMIT');
        break;
      }
      const next = nextRunAt({ frequency: s.frequency, send_time: s.send_time.slice(0, 5), day_of_week: s.day_of_week, day_of_month: s.day_of_month }, s.timezone);
      // claim it first so a crash never re-sends in a loop
      await c.query('UPDATE report_schedules SET last_run_at = now(), next_run_at = $2 WHERE id = $1', [s.id, next]);
      await c.query('COMMIT');
    } catch (err) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      c.release();
    }
    const period = periodFor(s.frequency, s.timezone);
    const run = (
      await db.query<{ id: string }>(
        `INSERT INTO report_runs (tenant_id, schedule_id, report_type, params, format, status, started_at) VALUES ($1,$2,$3,$4,$5,'running', now()) RETURNING id`,
        [s.tenant_id, s.id, s.report_type, JSON.stringify({ ...s.filters, ...period }), s.format],
      )
    ).rows[0]!;
    try {
      const report = await buildReport(db, s.tenant_id, s.report_type, { ...s.filters, ...period }, s.locale);
      const file = await renderReport(report, s.format);
      const sw = s.locale === 'sw';
      const subject = `${report.title} · ${period.from === period.to ? period.from : `${period.from} – ${period.to}`} · ${s.tenant_name}`;
      const summary = report.summary.map((x) => `${x.label}: ${typeof x.value === 'number' ? x.value.toLocaleString('en-US', { maximumFractionDigits: 2 }) : x.value}`);
      const text = `${sw ? 'Habari' : 'Hello'},\n\n${sw ? 'Ripoti yako iliyopangwa' : 'Your scheduled report'} "${s.name}" ${sw ? 'imeambatishwa' : 'is attached'}.\n\n${summary.join('\n')}\n\nJatelo Fleet Solutions`;
      const html = `<p>${sw ? 'Habari' : 'Hello'},</p><p>${sw ? 'Ripoti yako iliyopangwa' : 'Your scheduled report'} <b>${escape(s.name)}</b> ${sw ? 'imeambatishwa' : 'is attached'}.</p>
        <ul>${summary.map((x) => `<li>${escape(x)}</li>`).join('')}</ul><p style="color:#888">Jatelo Fleet Solutions</p>`;
      for (const to of s.recipients) await sendEmail(to, subject, text, html, [{ filename: file.filename, content: file.buffer, contentType: file.contentType }]);
      await db.query(`UPDATE report_runs SET status = 'completed', row_count = $2, completed_at = now() WHERE id = $1`, [run.id, report.rows.length]);
      sent++;
    } catch (err) {
      failed++;
      logger.error({ err, schedule: s.id }, 'scheduled report failed');
      await db.query(`UPDATE report_runs SET status = 'failed', error = $2, completed_at = now() WHERE id = $1`, [run.id, String((err as Error).message).slice(0, 500)]);
    }
  }
  return { sent, failed };
}

const escape = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
