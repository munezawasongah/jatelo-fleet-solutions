import { useQuery } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { Marker, Tooltip } from 'react-leaflet';
import { useParams } from 'react-router';
import { io } from 'socket.io-client';
import { BaseMap, FitBounds, pinIcon, vehicleIcon } from '../components/map';
import { Badge, Spinner, StatusBadge } from '../components/ui';
import { API_BASE, api, type Row } from '../lib/api';
import { fmtDateTime, fmtNum, fmtTime } from '../lib/format';

/** Public live-tracking page for a share link (no sign-in). */
export default function TrackShare(): ReactNode {
  const { token } = useParams();
  const q = useQuery({ queryKey: ['share', token], queryFn: () => api.get<Row & { vehicle: Row | null; job: (Row & { stops: Row[] }) | null }>(`/public/share/${token}`), refetchInterval: 30_000, retry: false });
  const [pos, setPos] = useState<Row | null>(null);
  useEffect(() => {
    const s = io(API_BASE || window.location.origin, { auth: { share: token }, transports: ['websocket', 'polling'] });
    s.on('position', (p: Row) => setPos(p));
    return () => void s.disconnect();
  }, [token]);
  if (q.error) return <div className="flex h-full items-center justify-center p-6 text-center"><div><img src="/favicon.svg" alt="" className="mx-auto mb-3 size-12" /><p className="font-semibold">This tracking link has expired or was revoked.</p></div></div>;
  if (!q.data) return <div className="flex h-full items-center justify-center"><Spinner /></div>;
  const v = { ...(q.data.vehicle ?? {}), ...(pos ?? {}) } as Row;
  const job = q.data.job;
  const has = v.lat !== null && v.lat !== undefined;
  const pts: [number, number][] = [...(has ? [[Number(v.lat), Number(v.lng)] as [number, number]] : []), ...(job?.stops ?? []).map((s) => [Number(s.lat), Number(s.lng)] as [number, number])];
  const next = job?.stops.find((s) => ['pending', 'en_route', 'arrived'].includes(String(s.status)));
  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 bg-brand-950 px-4 py-3 text-white">
        <img src="/favicon.svg" alt="" className="size-8" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{job ? `${String(job.title)} · ${String(job.reference)}` : String(q.data.label ?? v.plate_number ?? 'Live location')}</p>
          <p className="text-xs text-white/60">Live via Jatelo Fleet · link valid until {fmtDateTime(q.data.expires_at)}</p>
        </div>
        {job && <StatusBadge value={job.status} />}
      </header>
      <div className="relative flex-1">
        <BaseMap>
          <FitBounds points={pts} />
          {has && <Marker position={[Number(v.lat), Number(v.lng)]} icon={vehicleIcon({ state: String(v.state ?? 'stopped'), heading: v.heading as number | null, label: String(v.plate_number ?? '') })} />}
          {(job?.stops ?? []).map((s) => <Marker key={String(s.seq)} position={[Number(s.lat), Number(s.lng)]} icon={pinIcon(s.status === 'completed' ? '#16a34a' : '#0f6b4f', String(s.seq))}><Tooltip>{String(s.name)}</Tooltip></Marker>)}
        </BaseMap>
        <div className="absolute inset-x-3 bottom-3 z-[500] rounded-xl bg-white p-4 shadow-xl ring-1 ring-black/10 sm:left-auto sm:w-80">
          {next ? (
            <>
              <p className="text-xs text-ink/55">Next stop</p>
              <p className="font-semibold">{String(next.name)}</p>
              <p className="mt-1 text-2xl font-semibold tabular">{next.arrived_at ? 'Arrived' : next.eta ? `ETA ${fmtTime(next.eta)}` : '—'}</p>
            </>
          ) : job ? <p className="font-semibold">All stops completed</p> : null}
          <p className="mt-2 flex items-center gap-2 text-sm text-ink/70"><Badge tone={v.state === 'moving' ? 'green' : 'gray'}>{String(v.state ?? '—')}</Badge>{fmtNum(v.speed_kph)} km/h · updated {fmtTime(v.recorded_at ?? v.last_seen_at)}</p>
        </div>
      </div>
    </div>
  );
}
