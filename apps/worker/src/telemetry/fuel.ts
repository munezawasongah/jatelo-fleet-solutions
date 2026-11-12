export interface FuelState {
  base: number;
  baseAt: number;
  win: number[];
  lowAlertDay?: string;
}

export interface FuelEvent {
  type: 'refuel' | 'drain';
  startedAt: number;
  endedAt: number;
  before: number;
  after: number;
  lat: number;
  lng: number;
}

const median = (a: number[]): number => {
  const s = [...a].sort((x, y) => x - y);
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};

/**
 * Sensor-based refuel/drain detection. Readings are median-smoothed (5 samples) to ignore sloshing.
 * While moving the baseline follows consumption; a jump up or down of at least max(10 L, 8% of the tank) while stationary
 * becomes a refuel or a suspected drain.
 */
export function advanceFuel(
  s: FuelState | undefined,
  at: number,
  litres: number,
  speed: number,
  lat: number,
  lng: number,
  tankL: number | null,
): { state: FuelState; event: FuelEvent | null } {
  if (!s) return { state: { base: litres, baseAt: at, win: [litres] }, event: null };
  const win = [...s.win, litres].slice(-5);
  const level = median(win);
  const threshold = Math.max(10, (tankL ?? 0) * 0.08);
  const next: FuelState = { ...s, win };
  if (speed > 5 || at - s.baseAt > 6 * 3_600_000) {
    next.base = level;
    next.baseAt = at;
    return { state: next, event: null };
  }
  if (win.length < 3) return { state: next, event: null };
  const diff = level - s.base;
  if (Math.abs(diff) >= threshold) {
    const event: FuelEvent = {
      type: diff > 0 ? 'refuel' : 'drain',
      startedAt: s.baseAt,
      endedAt: at,
      before: s.base,
      after: level,
      lat,
      lng,
    };
    next.base = level;
    next.baseAt = at;
    return { state: next, event };
  }
  return { state: next, event: null };
}
