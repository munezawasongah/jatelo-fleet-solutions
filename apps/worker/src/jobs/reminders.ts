import { publishEvent } from '../alerts/engine.js';
import { db } from '../infra.js';
import { logger } from '../logger.js';

const STAGE_TEXT: Record<string, string> = {
  due_soon: 'due soon',
  due: 'due now',
  overdue: 'overdue',
};

/** Updates every service schedule's status and raises one reminder per schedule, cycle and stage. */
export async function serviceReminders(): Promise<number> {
  await db.query(
    `UPDATE service_schedules s SET status = CASE
        WHEN (s.next_due_km IS NOT NULL AND v.odometer_km >= s.next_due_km + greatest(s.remind_before_km, 500))
          OR (s.next_due_hours IS NOT NULL AND v.engine_hours >= s.next_due_hours + greatest(s.remind_before_hours, 10))
          OR (s.next_due_at IS NOT NULL AND now() >= s.next_due_at + interval '7 days') THEN 'overdue'
        WHEN (s.next_due_km IS NOT NULL AND v.odometer_km >= s.next_due_km) OR (s.next_due_hours IS NOT NULL AND v.engine_hours >= s.next_due_hours)
          OR (s.next_due_at IS NOT NULL AND now() >= s.next_due_at) THEN 'due'
        WHEN (s.next_due_km IS NOT NULL AND v.odometer_km >= s.next_due_km - s.remind_before_km)
          OR (s.next_due_hours IS NOT NULL AND v.engine_hours >= s.next_due_hours - s.remind_before_hours)
          OR (s.next_due_at IS NOT NULL AND now() >= s.next_due_at - make_interval(days => s.remind_before_days)) THEN 'due_soon'
        ELSE 'ok' END
     FROM vehicles v WHERE v.id = s.vehicle_id AND s.deleted_at IS NULL AND s.is_active AND v.deleted_at IS NULL`,
  );
  const fresh = (
    await db.query<{
      tenant_id: string;
      schedule_id: string;
      vehicle_id: string;
      name: string;
      stage: string;
      cycle: number;
      km_left: string | null;
      days_left: number | null;
    }>(
      `INSERT INTO service_reminders (tenant_id, schedule_id, vehicle_id, cycle, stage, due_at, due_km, due_hours)
       SELECT s.tenant_id, s.id, s.vehicle_id, s.cycle, s.status, s.next_due_at, s.next_due_km, s.next_due_hours
       FROM service_schedules s WHERE s.status <> 'ok' AND s.deleted_at IS NULL AND s.is_active
       ON CONFLICT (schedule_id, cycle, stage) DO NOTHING
       RETURNING tenant_id, schedule_id, vehicle_id, stage, cycle,
         (SELECT name FROM service_schedules WHERE id = schedule_id) AS name,
         (SELECT (s2.next_due_km - v.odometer_km)::text FROM service_schedules s2 JOIN vehicles v ON v.id = s2.vehicle_id WHERE s2.id = schedule_id) AS km_left,
         (SELECT (s2.next_due_at::date - current_date) FROM service_schedules s2 WHERE s2.id = schedule_id) AS days_left`,
    )
  ).rows;
  for (const r of fresh) {
    const detail =
      r.km_left !== null
        ? ` (${Math.round(Number(r.km_left)).toLocaleString()} km left)`
        : r.days_left !== null
          ? ` (${r.days_left} days left)`
          : '';
    await publishEvent({
      type: 'service_due',
      tenant_id: r.tenant_id,
      vehicle_id: r.vehicle_id,
      at: new Date().toISOString(),
      extra: `${r.name} is ${STAGE_TEXT[r.stage] ?? r.stage}${detail}`,
      value: null,
      source_type: 'service_schedules',
      source_id: r.schedule_id,
      dedupe: `service:${r.schedule_id}:${r.cycle}:${r.stage}`,
    });
  }
  return fresh.length;
}

const DOC_NAMES: Record<string, string> = {
  insurance: 'Insurance',
  ntsa_inspection: 'NTSA inspection',
  tra_inspection: 'TRA inspection',
  road_licence: 'Road licence',
  psv_licence: 'PSV licence',
  logbook: 'Logbook',
  speed_governor_cert: 'Speed governor certificate',
  tracking_cert: 'Tracking certificate',
  transit_permit: 'Transit permit',
  comesa_card: 'COMESA yellow card',
  other: 'Document',
  driving: 'Driving licence',
  psv_badge: 'PSV badge',
  hazmat: 'Hazmat permit',
  defensive_driving: 'Defensive driving certificate',
};
const when = (days: number): string =>
  days < 0
    ? `expired ${-days} day(s) ago`
    : days === 0
      ? 'expires today'
      : `expires in ${days} day(s)`;

/** Raises expiry reminders on each configured reminder day, on the expiry day, and weekly once expired. */
export async function expiryReminders(): Promise<number> {
  const docs = (
    await db.query<{
      id: string;
      tenant_id: string;
      vehicle_id: string;
      doc_type: string;
      days: number;
    }>(
      `SELECT d.id, d.tenant_id, d.vehicle_id, d.doc_type, (d.expires_on - (now() AT TIME ZONE t.timezone)::date) AS days
       FROM vehicle_documents d JOIN tenants t ON t.id = d.tenant_id JOIN vehicles v ON v.id = d.vehicle_id
       WHERE d.deleted_at IS NULL AND v.deleted_at IS NULL AND d.expires_on IS NOT NULL
         AND ((d.expires_on - (now() AT TIME ZONE t.timezone)::date) = ANY(d.reminder_days || 0)
           OR ((d.expires_on - (now() AT TIME ZONE t.timezone)::date) < 0 AND (d.expires_on - (now() AT TIME ZONE t.timezone)::date) % 7 = 0))`,
    )
  ).rows;
  for (const d of docs) {
    await publishEvent({
      type: 'document_expiry',
      tenant_id: d.tenant_id,
      vehicle_id: d.vehicle_id,
      at: new Date().toISOString(),
      value: d.days,
      extra: `${DOC_NAMES[d.doc_type] ?? d.doc_type} ${when(d.days)}`,
      source_type: 'vehicle_documents',
      source_id: d.id,
      dedupe: `doc:${d.id}:${d.days}`,
    });
  }
  const lic = (
    await db.query<{
      id: string;
      tenant_id: string;
      driver_id: string;
      full_name: string;
      licence_type: string;
      days: number;
      vehicle_id: string | null;
    }>(
      `SELECT l.id, l.tenant_id, l.driver_id, dr.full_name, l.licence_type, (l.expires_on - (now() AT TIME ZONE t.timezone)::date) AS days,
         (SELECT vehicle_id FROM driver_vehicle_assignments WHERE driver_id = l.driver_id AND ends_at IS NULL LIMIT 1) AS vehicle_id
       FROM driver_licences l JOIN tenants t ON t.id = l.tenant_id JOIN drivers dr ON dr.id = l.driver_id
       WHERE l.deleted_at IS NULL AND dr.deleted_at IS NULL AND l.expires_on IS NOT NULL
         AND ((l.expires_on - (now() AT TIME ZONE t.timezone)::date) = ANY(l.reminder_days || 0)
           OR ((l.expires_on - (now() AT TIME ZONE t.timezone)::date) < 0 AND (l.expires_on - (now() AT TIME ZONE t.timezone)::date) % 7 = 0))`,
    )
  ).rows;
  for (const l of lic) {
    await publishEvent({
      type: 'licence_expiry',
      tenant_id: l.tenant_id,
      driver_id: l.driver_id,
      vehicle_id: l.vehicle_id,
      subject: l.full_name,
      at: new Date().toISOString(),
      value: l.days,
      extra: `${DOC_NAMES[l.licence_type] ?? l.licence_type} ${when(l.days)}`,
      source_type: 'driver_licences',
      source_id: l.id,
      dedupe: `lic:${l.id}:${l.days}`,
    });
  }
  if (docs.length || lic.length)
    logger.info({ documents: docs.length, licences: lic.length }, 'expiry reminders raised');
  return docs.length + lic.length;
}
