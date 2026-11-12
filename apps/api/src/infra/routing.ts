import { config } from '../config.js';
import { logger } from '../logger.js';

export interface Stop {
  lat: number;
  lng: number;
  service_minutes?: number;
  /** ISO time window in which the stop should be served */
  window_start?: string | null;
  window_end?: string | null;
}
export interface PlannedLeg {
  from: number;
  to: number;
  distance_km: number;
  duration_s: number;
}
export interface Plan {
  order: number[]; // indexes into the input stops (excluding the start)
  geometry: [number, number][]; // [lng, lat]
  distance_km: number;
  duration_s: number;
  legs: PlannedLeg[];
  etas: string[]; // arrival per ordered stop
  engine: 'osrm' | 'vroom' | 'fallback';
}

const R = 6371.0088;
const rad = (d: number): number => (d * Math.PI) / 180;
export function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Road-distance correction and average speeds used when no routing engine is configured. */
const DETOUR = 1.3;
const SPEED_KPH: Record<string, number> = { car: 45, truck: 38, motorcycle: 35 };

type Matrix = { km: number[][]; s: number[][] };

async function osrmTable(points: Stop[], profile: string): Promise<Matrix | null> {
  if (!config.OSRM_URL) return null;
  const coords = points.map((p) => `${p.lng},${p.lat}`).join(';');
  try {
    const res = await fetch(`${config.OSRM_URL}/table/v1/${profile === 'motorcycle' ? 'driving' : 'driving'}/${coords}?annotations=distance,duration`, {
      signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`OSRM table HTTP ${res.status}`);
    const j = (await res.json()) as { distances: number[][]; durations: number[][] };
    const truck = profile === 'truck' ? 1.15 : 1;
    return { km: j.distances.map((r) => r.map((m) => m / 1000)), s: j.durations.map((r) => r.map((d) => d * truck)) };
  } catch (err) {
    logger.warn({ err }, 'OSRM table failed - using straight-line estimates');
    return null;
  }
}

function fallbackMatrix(points: Stop[], profile: string): Matrix {
  const v = SPEED_KPH[profile] ?? 45;
  const km = points.map((a) => points.map((b) => haversineKm(a, b) * DETOUR));
  return { km, s: km.map((r) => r.map((d) => (d / v) * 3600)) };
}

/** Nearest neighbour then 2-opt on travel time; good to within a few % of optimal for typical delivery runs (< 50 stops). */
function solve(m: Matrix, n: number, returnToStart: boolean): number[] {
  const left = new Set(Array.from({ length: n - 1 }, (_, i) => i + 1));
  const tour = [0];
  while (left.size) {
    const last = tour[tour.length - 1]!;
    let best = -1;
    for (const j of left) if (best < 0 || m.s[last]![j]! < m.s[last]![best]!) best = j;
    tour.push(best);
    left.delete(best);
  }
  const cost = (t: number[]): number => {
    let c = 0;
    for (let i = 0; i < t.length - 1; i++) c += m.s[t[i]!]![t[i + 1]!]!;
    return c + (returnToStart ? m.s[t[t.length - 1]!]![0]! : 0);
  };
  let improved = true;
  let guard = 0;
  while (improved && guard++ < 200) {
    improved = false;
    for (let i = 1; i < tour.length - 1; i++) {
      for (let k = i + 1; k < tour.length; k++) {
        const cand = [...tour.slice(0, i), ...tour.slice(i, k + 1).reverse(), ...tour.slice(k + 1)];
        if (cost(cand) < cost(tour) - 1) {
          tour.splice(0, tour.length, ...cand);
          improved = true;
        }
      }
    }
  }
  return tour.slice(1);
}

async function vroomOrder(points: Stop[], profile: string, returnToStart: boolean): Promise<number[] | null> {
  if (!config.VROOM_URL) return null;
  try {
    const body = {
      vehicles: [{ id: 1, profile: 'car', start: [points[0]!.lng, points[0]!.lat], ...(returnToStart ? { end: [points[0]!.lng, points[0]!.lat] } : {}) }],
      jobs: points.slice(1).map((p, i) => ({
        id: i + 1, location: [p.lng, p.lat], service: Math.round((p.service_minutes ?? 0) * 60),
        ...(p.window_start && p.window_end ? { time_windows: [[Math.floor(Date.parse(p.window_start) / 1000), Math.floor(Date.parse(p.window_end) / 1000)]] } : {}),
      })),
    };
    void profile;
    const res = await fetch(config.VROOM_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`VROOM HTTP ${res.status}`);
    const j = (await res.json()) as { routes?: { steps: { type: string; id?: number }[] }[] };
    const steps = j.routes?.[0]?.steps.filter((s) => s.type === 'job').map((s) => s.id!) ?? [];
    return steps.length === points.length - 1 ? steps : null;
  } catch (err) {
    logger.warn({ err }, 'VROOM failed - using built-in optimiser');
    return null;
  }
}

async function osrmGeometry(points: Stop[]): Promise<{ geometry: [number, number][]; legs: { km: number; s: number }[] } | null> {
  if (!config.OSRM_URL || points.length < 2) return null;
  try {
    const coords = points.map((p) => `${p.lng},${p.lat}`).join(';');
    const res = await fetch(`${config.OSRM_URL}/route/v1/driving/${coords}?overview=full&geometries=geojson`, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`OSRM route HTTP ${res.status}`);
    const j = (await res.json()) as { routes: { geometry: { coordinates: [number, number][] }; legs: { distance: number; duration: number }[] }[] };
    const r = j.routes[0]!;
    return { geometry: r.geometry.coordinates, legs: r.legs.map((l) => ({ km: l.distance / 1000, s: l.duration })) };
  } catch (err) {
    logger.warn({ err }, 'OSRM route failed - using straight lines');
    return null;
  }
}

/**
 * Plans a multi-stop route from points[0] (start). Optimises stop order when asked (VROOM if configured, else built-in),
 * then builds road geometry and ETAs (OSRM if configured, else straight-line estimates with a 1.3 detour factor).
 */
export async function planRoute(points: Stop[], opts: { optimize: boolean; profile?: string; returnToStart?: boolean; departAt?: Date }): Promise<Plan> {
  if (points.length < 2) throw new Error('A route needs a start and at least one stop');
  const profile = opts.profile ?? 'car';
  let order = Array.from({ length: points.length - 1 }, (_, i) => i + 1);
  let engine: Plan['engine'] = config.OSRM_URL ? 'osrm' : 'fallback';
  if (opts.optimize && points.length > 2) {
    const v = await vroomOrder(points, profile, opts.returnToStart ?? false);
    if (v) {
      order = v;
      engine = 'vroom';
    } else {
      const m = (await osrmTable(points, profile)) ?? fallbackMatrix(points, profile);
      order = solve(m, points.length, opts.returnToStart ?? false);
    }
  }
  const seq = [points[0]!, ...order.map((i) => points[i]!), ...(opts.returnToStart ? [points[0]!] : [])];
  const road = await osrmGeometry(seq);
  const v = SPEED_KPH[profile] ?? 45;
  const legsRaw = road?.legs ?? seq.slice(1).map((p, i) => {
    const km = haversineKm(seq[i]!, p) * DETOUR;
    return { km, s: (km / v) * 3600 };
  });
  let t = (opts.departAt ?? new Date()).getTime();
  const etas: string[] = [];
  const legs: PlannedLeg[] = legsRaw.map((l, i) => {
    t += l.s * 1000 * (profile === 'truck' && road ? 1.15 : 1);
    if (i < order.length) {
      const stop = points[order[i]!]!;
      if (stop.window_start && Date.parse(stop.window_start) > t) t = Date.parse(stop.window_start);
      etas.push(new Date(t).toISOString());
      t += (stop.service_minutes ?? 0) * 60_000;
    }
    return { from: i, to: i + 1, distance_km: Math.round(l.km * 100) / 100, duration_s: Math.round(l.s) };
  });
  return {
    order: order.map((i) => i - 1),
    geometry: road?.geometry ?? seq.map((p) => [p.lng, p.lat]),
    distance_km: Math.round(legs.reduce((a, l) => a + l.distance_km, 0) * 100) / 100,
    duration_s: legs.reduce((a, l) => a + l.duration_s, 0),
    legs,
    etas,
    engine,
  };
}
