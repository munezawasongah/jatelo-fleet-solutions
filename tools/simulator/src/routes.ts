/**
 * Hand-traced road polylines ([lat, lng]) in the cities Jatelo customers operate in. Points follow the real main roads closely
 * enough for realistic trips, stops and geofence crossings. With OSRM_URL set, routes are fetched from OSRM instead.
 */
export const CITY_ROUTES: Record<string, [number, number][][]> = {
  kisumu: [
    // Kisumu CBD (Oginga Odinga St) -> Kibuye -> Kondele -> Mamboleo (B1 Kakamega road)
    [[-0.1022, 34.7617], [-0.1006, 34.7578], [-0.0985, 34.7552], [-0.0947, 34.7570], [-0.0905, 34.7608], [-0.0853, 34.7651], [-0.0804, 34.7693], [-0.0756, 34.7733], [-0.0702, 34.7778], [-0.0640, 34.7810], [-0.0573, 34.7845]],
    // CBD -> Kisumu airport (Busia road) -> Otonglo
    [[-0.1022, 34.7617], [-0.1040, 34.7550], [-0.1048, 34.7470], [-0.1012, 34.7380], [-0.0965, 34.7290], [-0.0890, 34.7215], [-0.0862, 34.7125], [-0.0828, 34.6990], [-0.0795, 34.6862]],
    // CBD -> Nyamasaria -> Ahero (A1 Kisumu-Nairobi)
    [[-0.1022, 34.7617], [-0.1063, 34.7712], [-0.1110, 34.7821], [-0.1158, 34.7955], [-0.1205, 34.8098], [-0.1281, 34.8287], [-0.1355, 34.8460], [-0.1450, 34.8670], [-0.1555, 34.8890], [-0.1660, 34.9065], [-0.1735, 34.9157]],
    // Kisumu industrial area -> Obunga -> Kisian
    [[-0.0889, 34.7470], [-0.0876, 34.7390], [-0.0860, 34.7280], [-0.0840, 34.7120], [-0.0835, 34.6980], [-0.0838, 34.6820], [-0.0841, 34.6700]],
  ],
  nairobi: [
    // CBD -> Uhuru Hwy -> Mombasa Rd -> JKIA
    [[-1.2864, 36.8172], [-1.2925, 36.8187], [-1.2990, 36.8222], [-1.3065, 36.8262], [-1.3150, 36.8380], [-1.3215, 36.8500], [-1.3275, 36.8640], [-1.3320, 36.8780], [-1.3335, 36.8930], [-1.3330, 36.9100], [-1.3317, 36.9220]],
    // Westlands -> Waiyaki Way -> Kangemi -> Uthiru
    [[-1.2676, 36.8108], [-1.2635, 36.8020], [-1.2600, 36.7930], [-1.2575, 36.7830], [-1.2555, 36.7720], [-1.2547, 36.7600], [-1.2560, 36.7460], [-1.2575, 36.7330]],
    // Industrial Area (Enterprise Rd) -> Outer Ring -> Thika Rd (Roysambu)
    [[-1.3050, 36.8580], [-1.2950, 36.8680], [-1.2830, 36.8790], [-1.2700, 36.8860], [-1.2560, 36.8890], [-1.2420, 36.8900], [-1.2290, 36.8880], [-1.2180, 36.8870]],
  ],
  dar: [
    // Kariakoo -> Morogoro Rd -> Ubungo
    [[-6.8190, 39.2740], [-6.8150, 39.2660], [-6.8100, 39.2570], [-6.8050, 39.2480], [-6.7990, 39.2390], [-6.7930, 39.2300], [-6.7860, 39.2210], [-6.7820, 39.2140]],
    // Posta -> Nyerere Rd -> Julius Nyerere airport
    [[-6.8160, 39.2900], [-6.8270, 39.2820], [-6.8380, 39.2700], [-6.8480, 39.2560], [-6.8590, 39.2430], [-6.8700, 39.2300], [-6.8780, 39.2100]],
  ],
  kampala: [
    // Kampala CBD -> Jinja Rd -> Bweyogerere
    [[0.3136, 32.5811], [0.3170, 32.5920], [0.3200, 32.6040], [0.3230, 32.6170], [0.3270, 32.6300], [0.3330, 32.6440], [0.3390, 32.6580], [0.3450, 32.6700]],
  ],
  kigali: [
    // Nyabugogo -> CBD -> Remera -> Kigali airport
    [[-1.9395, 30.0445], [-1.9450, 30.0560], [-1.9500, 30.0610], [-1.9530, 30.0730], [-1.9560, 30.0880], [-1.9590, 30.1030], [-1.9640, 30.1180], [-1.9680, 30.1330], [-1.9680, 30.1390]],
  ],
};

export const CITY_FOR_COUNTRY: Record<string, string[]> = { KE: ['kisumu', 'nairobi'], TZ: ['dar'], UG: ['kampala'], RW: ['kigali'] };

const R = 6371008.8;
const rad = (d: number): number => (d * Math.PI) / 180;
export function meters(a: [number, number], b: [number, number]): number {
  const h = Math.sin(rad(b[0] - a[0]) / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(rad(b[1] - a[1]) / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
export function bearing(a: [number, number], b: [number, number]): number {
  const y = Math.sin(rad(b[1] - a[1])) * Math.cos(rad(b[0]));
  const x = Math.cos(rad(a[0])) * Math.sin(rad(b[0])) - Math.sin(rad(a[0])) * Math.cos(rad(b[0])) * Math.cos(rad(b[1] - a[1]));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** Walks a polyline: returns the point at distance d along it, and the heading of that segment. */
export class Path {
  private cum: number[] = [0];
  constructor(public pts: [number, number][]) {
    for (let i = 1; i < pts.length; i++) this.cum.push(this.cum[i - 1]! + meters(pts[i - 1]!, pts[i]!));
  }
  get length(): number {
    return this.cum[this.cum.length - 1]!;
  }
  at(d: number): { pos: [number, number]; heading: number } {
    const dist = Math.max(0, Math.min(d, this.length));
    let i = 1;
    while (i < this.cum.length - 1 && this.cum[i]! < dist) i++;
    const a = this.pts[i - 1]!;
    const b = this.pts[i]!;
    const seg = this.cum[i]! - this.cum[i - 1]! || 1;
    const f = (dist - this.cum[i - 1]!) / seg;
    return { pos: [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f], heading: bearing(a, b) };
  }
  reversed(): Path {
    return new Path([...this.pts].reverse());
  }
}

/** Optional road-snapped geometry from OSRM (between the first and last point of a route). */
export async function osrmPath(base: string, pts: [number, number][]): Promise<[number, number][] | null> {
  try {
    const coords = [pts[0]!, pts[pts.length - 1]!].map(([la, lo]) => `${lo},${la}`).join(';');
    const res = await fetch(`${base}/route/v1/driving/${coords}?overview=full&geometries=geojson`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const j = (await res.json()) as { routes?: { geometry: { coordinates: [number, number][] } }[] };
    return j.routes?.[0]?.geometry.coordinates.map(([lo, la]) => [la, lo]) ?? null;
  } catch {
    return null;
  }
}
