import { Pause, Play } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { CircleMarker, Marker, Polyline, Tooltip } from 'react-leaflet';
import { fmtDateTime, fmtNum } from '../lib/format';
import { BaseMap, FitBounds, pinIcon, vehicleIcon } from './map';
import { Button, Select } from './ui';

export interface Track {
  t: number[];
  lat: number[];
  lng: number[];
  speed: number[];
  heading?: (number | null)[];
}
export interface TrackEvent {
  id: string;
  event_type: string;
  occurred_at: string;
  lat: number | null;
  lng: number | null;
  speed_kph?: number | null;
}

const speedColor = (s: number): string => (s > 100 ? '#dc2626' : s > 80 ? '#f59e0b' : s > 5 ? '#0f6b4f' : '#64748b');
const EVENT_COLORS: Record<string, string> = { overspeed: '#dc2626', harsh_brake: '#f59e0b', harsh_accel: '#f59e0b', harsh_corner: '#f59e0b', excessive_idle: '#64748b', crash: '#7f1d1d' };

/** Route replay with speed-coloured track, events, and a scrubber. */
export function Playback({ track, events = [], height = 'h-[60vh]' }: { track: Track; events?: TrackEvent[]; height?: string }): ReactNode {
  const n = track.t.length;
  const [i, setI] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [mult, setMult] = useState(60);
  const raf = useRef<number | null>(null);
  const clock = useRef<{ wall: number; sim: number } | null>(null);

  useEffect(() => setI(0), [n]);
  useEffect(() => {
    if (!playing || n < 2) return;
    clock.current = { wall: performance.now(), sim: track.t[i]! };
    const step = (): void => {
      const c = clock.current!;
      const sim = c.sim + (performance.now() - c.wall) * mult;
      let j = i;
      while (j < n - 1 && track.t[j + 1]! <= sim) j++;
      setI(j);
      if (j >= n - 1) {
        setPlaying(false);
        return;
      }
      raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
    return () => {
      if (raf.current) cancelAnimationFrame(raf.current);
    };
  }, [playing, mult]); // eslint-disable-line react-hooks/exhaustive-deps

  // speed-coloured segments, merged into runs of the same colour
  const segments = useMemo(() => {
    const out: { color: string; pts: [number, number][] }[] = [];
    for (let k = 1; k < n; k++) {
      const color = speedColor(track.speed[k] ?? 0);
      const a: [number, number] = [track.lat[k - 1]!, track.lng[k - 1]!];
      const b: [number, number] = [track.lat[k]!, track.lng[k]!];
      const last = out[out.length - 1];
      if (last && last.color === color) last.pts.push(b);
      else out.push({ color, pts: [a, b] });
    }
    return out;
  }, [track, n]);
  const bounds = useMemo(() => track.lat.map((la, k) => [la, track.lng[k]!] as [number, number]), [track]);

  if (!n) return null;
  const cur = { lat: track.lat[i]!, lng: track.lng[i]!, speed: track.speed[i] ?? 0, heading: track.heading?.[i] ?? null };
  return (
    <div className="overflow-hidden rounded-xl bg-white shadow-sm ring-1 ring-black/[0.06]">
      <div className={height}>
        <BaseMap>
          <FitBounds points={bounds} once={false} />
          {segments.map((s, k) => <Polyline key={k} positions={s.pts} pathOptions={{ color: s.color, weight: 4, opacity: 0.85 }} />)}
          <Marker position={bounds[0]!} icon={pinIcon('#16a34a', 'A')} />
          <Marker position={bounds[n - 1]!} icon={pinIcon('#0b3d2e', 'B')} />
          {events.filter((e) => e.lat !== null).map((e) => (
            <CircleMarker key={e.id} center={[e.lat!, e.lng!]} radius={6} pathOptions={{ color: '#fff', weight: 2, fillColor: EVENT_COLORS[e.event_type] ?? '#7c3aed', fillOpacity: 1 }}>
              <Tooltip>{e.event_type.replace(/_/g, ' ')} · {fmtDateTime(e.occurred_at)}{e.speed_kph ? ` · ${e.speed_kph} km/h` : ''}</Tooltip>
            </CircleMarker>
          ))}
          <Marker position={[cur.lat, cur.lng]} icon={vehicleIcon({ state: cur.speed > 3 ? 'moving' : 'stopped', heading: cur.heading })} zIndexOffset={1000} />
        </BaseMap>
      </div>
      <div className="flex flex-wrap items-center gap-3 border-t border-black/[0.06] p-3">
        <Button size="sm" onClick={() => { if (i >= n - 1) setI(0); setPlaying(!playing); }} icon={playing ? <Pause className="size-4" /> : <Play className="size-4" />} aria-label={playing ? 'Pause' : 'Play'} />
        <input type="range" min={0} max={n - 1} value={i} onChange={(e) => { setPlaying(false); setI(Number(e.target.value)); }} className="min-w-40 flex-1 accent-brand-600" aria-label="Position in trip" />
        <span className="w-44 text-right text-xs tabular text-ink/70">{fmtDateTime(track.t[i])} · {fmtNum(cur.speed)} km/h</span>
        <Select value={String(mult)} onChange={(e) => setMult(Number(e.target.value))} className="w-24" aria-label="Playback speed">
          {[10, 30, 60, 120, 300, 600].map((m) => <option key={m} value={m}>{m}×</option>)}
        </Select>
      </div>
      <div className="flex flex-wrap gap-3 border-t border-black/[0.06] px-3 py-2 text-[11px] text-ink/60">
        {[['#64748b', '< 5 km/h'], ['#0f6b4f', '5-80'], ['#f59e0b', '80-100'], ['#dc2626', '> 100']].map(([c, l]) => (
          <span key={l} className="inline-flex items-center gap-1"><span className="h-1 w-4 rounded" style={{ background: c }} />{l}</span>
        ))}
      </div>
    </div>
  );
}
