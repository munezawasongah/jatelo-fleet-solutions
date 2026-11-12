import type { Router } from 'express';
import { z } from 'zod';
import { guard, requireAuth, tenantDb } from '../auth/middleware.js';
import { notFound, unprocessable } from '../http/errors.js';
import { AnyRow, listRows, rowsOf, type Row } from '../http/resource.js';
import { route } from '../http/route.js';

const BASE = '/api/v1';
const TAG = 'Driver behaviour';
const day = z.iso.date();

function period(from: string, to: string): void {
  if (to < from) throw unprocessable('"to" must not be before "from"');
  if ((Date.parse(to) - Date.parse(from)) / 86_400_000 > 366)
    throw unprocessable('The period can be at most one year');
}

/** Distance-weighted score and totals per driver over a period (from driver_daily_scores, maintained by the worker). */
const SCORE_SQL = `
  SELECT d.id AS driver_id, d.full_name, d.employee_number, d.photo_file_id,
    round((sum(s.score * greatest(s.distance_km, 1)) / nullif(sum(greatest(s.distance_km, 1)), 0))::numeric, 1) AS score,
    round(sum(s.distance_km)::numeric, 1) AS distance_km, round(sum(s.driving_s) / 3600.0, 1) AS driving_hours,
    sum(s.harsh_brake) AS harsh_brake, sum(s.harsh_accel) AS harsh_accel, sum(s.harsh_corner) AS harsh_corner,
    sum(s.overspeed_count) AS overspeed_count, round(sum(s.overspeed_s) / 60.0, 1) AS overspeed_minutes,
    round(sum(s.idle_s) / 60.0, 1) AS idle_minutes, round(sum(s.night_driving_s) / 3600.0, 1) AS night_hours,
    round(((sum(s.harsh_brake) + sum(s.harsh_accel) + sum(s.harsh_corner)) / nullif(sum(s.distance_km) / 100, 0))::numeric, 2) AS harsh_per_100km
  FROM drivers d JOIN driver_daily_scores s ON s.driver_id = d.id
  WHERE d.deleted_at IS NULL AND s.day BETWEEN $1 AND $2`;

export function registerBehaviourRoutes(v1: Router): void {
  route(v1, BASE, {
    method: 'get',
    path: '/driver-scores',
    tags: [TAG],
    summary: 'Driver leaderboard for a period',
    description:
      'Scores are 0-100 (100 = no risky events), weighted by distance. Drivers with under min_km are listed separately as "insufficient data".',
    auth: true,
    query: z.object({ from: day, to: day, min_km: z.coerce.number().min(0).default(20) }),
    middleware: guard('driver_scores:read'),
    responses: { 200: { description: 'Leaderboard', schema: AnyRow } },
    handler: async ({ req, query }) => {
      period(query.from, query.to);
      return tenantDb(req, async (c) => {
        const rows = await listRows(
          c,
          `${SCORE_SQL} GROUP BY d.id ORDER BY score DESC NULLS LAST`,
          [query.from, query.to],
        );
        const ranked: Row[] = rows
          .filter((r) => Number(r.distance_km) >= query.min_km)
          .map((r, i) => ({ rank: i + 1, ...r }));
        const fleet = ranked.length
          ? Math.round(
              (ranked.reduce((a, r) => a + Number(r.score) * Number(r.distance_km), 0) /
                ranked.reduce((a, r) => a + Number(r.distance_km), 0)) *
                10,
            ) / 10
          : null;
        return {
          from: query.from,
          to: query.to,
          fleet_score: fleet,
          leaderboard: ranked,
          insufficient_data: rows.filter((r) => Number(r.distance_km) < query.min_km),
        };
      });
    },
  });

  route(v1, BASE, {
    method: 'get',
    path: '/drivers/:id/scorecard',
    tags: [TAG],
    summary: 'Driver scorecard: trend, event breakdown, worst moments and comparison',
    auth: true,
    params: z.object({ id: z.uuid() }),
    query: z.object({ from: day, to: day }),
    middleware: guard(),
    responses: { 200: { description: 'Scorecard', schema: AnyRow } },
    handler: async ({ req, params, query }) => {
      const auth = requireAuth(req);
      period(query.from, query.to);
      return tenantDb(req, async (c) => {
        // drivers may see their own scorecard from the app
        if (!auth.permissions.has('driver_scores:read')) {
          const own = (
            await c.query<{ id: string }>('SELECT id FROM drivers WHERE user_id = $1', [
              auth.userId,
            ])
          ).rows[0];
          if (own?.id !== params.id) throw notFound('Driver');
        }
        const summary =
          rowsOf(
            await c.query<Row>(`${SCORE_SQL} AND d.id = $3 GROUP BY d.id`, [
              query.from,
              query.to,
              params.id,
            ]),
          )[0] ??
          rowsOf(
            await c.query<Row>(
              'SELECT id AS driver_id, full_name, employee_number FROM drivers WHERE id = $1 AND deleted_at IS NULL',
              [params.id],
            ),
          )[0];
        if (!summary) throw notFound('Driver');
        const daily = await listRows(
          c,
          'SELECT day, score, distance_km, harsh_brake + harsh_accel + harsh_corner AS harsh, overspeed_count, idle_s, night_driving_s FROM driver_daily_scores WHERE driver_id = $1 AND day BETWEEN $2 AND $3 ORDER BY day',
          [params.id, query.from, query.to],
        );
        const events = await listRows(
          c,
          `SELECT event_type, severity, count(*) AS n FROM driving_events WHERE driver_id = $1 AND occurred_at >= $2::date AND occurred_at < $3::date + 1 GROUP BY 1, 2 ORDER BY 3 DESC`,
          [params.id, query.from, query.to],
        );
        const worst = await listRows(
          c,
          `SELECT e.id, e.event_type, e.severity, e.occurred_at, e.lat, e.lng, e.speed_kph, e.speed_limit_kph, e.value, v.plate_number, e.reviewed_at, e.review_note
          FROM driving_events e LEFT JOIN vehicles v ON v.id = e.vehicle_id WHERE e.driver_id = $1 AND e.occurred_at >= $2::date AND e.occurred_at < $3::date + 1
          ORDER BY CASE e.severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, e.value DESC NULLS LAST LIMIT 20`,
          [params.id, query.from, query.to],
        );
        const fleet = rowsOf(
          await c.query<Row>(
            `SELECT round((sum(score * greatest(distance_km, 1)) / nullif(sum(greatest(distance_km, 1)), 0))::numeric, 1) AS fleet_score
          FROM driver_daily_scores WHERE day BETWEEN $1 AND $2`,
            [query.from, query.to],
          ),
        )[0];
        const rank =
          summary.score === undefined
            ? null
            : rowsOf(
                await c.query<Row>(
                  `SELECT count(*) + 1 AS rank FROM (${SCORE_SQL} GROUP BY d.id) x WHERE x.score > $3 AND x.distance_km >= 20`,
                  [query.from, query.to, summary.score],
                ),
              )[0]?.rank;
        const tips: string[] = [];
        const s = summary as Record<string, unknown>;
        if (Number(s.harsh_brake ?? 0) > 5)
          tips.push('Keep a longer following distance to avoid harsh braking.');
        if (Number(s.overspeed_count ?? 0) > 3)
          tips.push('Stay within the speed limit - overspeeding is the biggest score penalty.');
        if (Number(s.idle_minutes ?? 0) > 120)
          tips.push('Switch the engine off when waiting more than five minutes to save fuel.');
        if (Number(s.night_hours ?? 0) > 5)
          tips.push('Plan trips to reduce night driving where possible.');
        return {
          ...summary,
          rank,
          fleet_score: fleet?.fleet_score ?? null,
          daily,
          events_by_type: events,
          worst_events: worst,
          tips,
        };
      });
    },
  });

  route(v1, BASE, {
    method: 'get',
    path: '/drivers/:id/incidents',
    tags: [TAG],
    summary: 'Incident log for a driver (high-severity events, defects reported, SOS)',
    auth: true,
    params: z.object({ id: z.uuid() }),
    middleware: guard('driver_scores:read'),
    responses: { 200: { description: 'Incidents', schema: z.object({ data: z.array(AnyRow) }) } },
    handler: async ({ req, params }) =>
      tenantDb(req, async (c) => ({
        data: await listRows(
          c,
          `SELECT 'event' AS kind, e.event_type AS type, e.severity, e.occurred_at AS at, v.plate_number, e.review_note AS note, e.lat, e.lng
            FROM driving_events e LEFT JOIN vehicles v ON v.id = e.vehicle_id WHERE e.driver_id = $1 AND (e.severity = 'high' OR e.event_type IN ('sos','crash'))
          UNION ALL SELECT 'alert', a.alert_type, a.severity, a.occurred_at, v.plate_number, a.note, a.lat, a.lng FROM alerts a LEFT JOIN vehicles v ON v.id = a.vehicle_id
            WHERE a.driver_id = $1 AND a.severity = 'critical'
          UNION ALL SELECT 'defect', d.title, d.severity, d.reported_at, v.plate_number, d.description, NULL, NULL FROM defects d JOIN vehicles v ON v.id = d.vehicle_id
            WHERE d.reported_by_driver_id = $1
          ORDER BY at DESC LIMIT 200`,
          [params.id],
        ),
      })),
  });
}
