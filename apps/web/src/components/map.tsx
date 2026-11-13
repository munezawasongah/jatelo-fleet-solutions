import L from 'leaflet';
import { useEffect, type ReactNode } from 'react';
import { MapContainer, TileLayer, useMap, useMapEvents } from 'react-leaflet';

export const STATE_COLORS: Record<string, string> = {
  moving: '#16a34a',
  idle: '#f59e0b',
  stopped: '#64748b',
  offline: '#dc2626',
  never: '#94a3b8',
};

/** East Africa default view (Lake Victoria basin). */
export const DEFAULT_CENTER: [number, number] = [-1.0, 35.5];

export function BaseMap({ children, center = DEFAULT_CENTER, zoom = 6, className }: { children?: ReactNode; center?: [number, number]; zoom?: number; className?: string }): ReactNode {
  return (
    <MapContainer center={center} zoom={zoom} className={className ?? 'h-full w-full'} preferCanvas zoomControl={false} attributionControl>
      <TileLayer
        url="https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png"
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>'
        subdomains="abcd"
        maxZoom={20}
      />
      <ZoomControl />
      {children}
    </MapContainer>
  );
}

function ZoomControl(): null {
  const map = useMap();
  useEffect(() => {
    const z = L.control.zoom({ position: 'bottomright' }).addTo(map);
    return () => void z.remove();
  }, [map]);
  return null;
}

/** Arrow marker pointing in the direction of travel, coloured by state, with a plate label. */
export function vehicleIcon(opts: { state: string; heading?: number | null; label?: string; selected?: boolean }): L.DivIcon {
  const color = STATE_COLORS[opts.state] ?? STATE_COLORS.never!;
  const moving = opts.state === 'moving' && opts.heading !== null && opts.heading !== undefined;
  const ring = opts.selected ? `box-shadow:0 0 0 4px ${color}44;` : '';
  const glyph = moving
    ? `<svg viewBox="0 0 24 24" width="16" height="16" style="transform:rotate(${opts.heading}deg)"><path d="M12 2l7 18-7-4-7 4z" fill="#fff"/></svg>`
    : `<span style="width:8px;height:8px;border-radius:9999px;background:#fff;display:block"></span>`;
  return L.divIcon({
    className: 'vehicle-marker',
    iconSize: [28, 28],
    iconAnchor: [14, 14],
    html: `<div style="position:relative;width:28px;height:28px">
      <div style="width:28px;height:28px;border-radius:9999px;background:${color};border:2px solid #fff;display:flex;align-items:center;justify-content:center;${ring}box-shadow:0 1px 4px rgba(0,0,0,.35)">${glyph}</div>
      ${opts.label ? `<div style="position:absolute;left:32px;top:4px;white-space:nowrap;background:#fff;border-radius:4px;padding:1px 5px;font:600 11px/16px Inter Variable,system-ui;color:#13201b;box-shadow:0 1px 3px rgba(0,0,0,.25)">${opts.label.replace(/</g, '&lt;')}</div>` : ''}
    </div>`,
  });
}

export function pinIcon(color = '#0f6b4f', text = ''): L.DivIcon {
  return L.divIcon({
    className: '',
    iconSize: [26, 34],
    iconAnchor: [13, 33],
    html: `<svg width="26" height="34" viewBox="0 0 26 34"><path d="M13 0C5.8 0 0 5.6 0 12.6 0 22 13 34 13 34s13-12 13-21.4C26 5.6 20.2 0 13 0z" fill="${color}" stroke="#fff" stroke-width="1.5"/><text x="13" y="17" text-anchor="middle" font-family="Inter Variable,system-ui" font-size="11" font-weight="700" fill="#fff">${text}</text></svg>`,
  });
}

export function FitBounds({ points, padding = 40, once = true }: { points: [number, number][]; padding?: number; once?: boolean }): null {
  const map = useMap();
  const key = once ? points.length > 0 : JSON.stringify(points);
  useEffect(() => {
    if (!points.length) return;
    if (points.length === 1) map.setView(points[0]!, Math.max(map.getZoom(), 14));
    else map.fitBounds(L.latLngBounds(points), { padding: [padding, padding], maxZoom: 15 });
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

export function ClickHandler({ onClick }: { onClick: (lat: number, lng: number) => void }): null {
  useMapEvents({ click: (e) => onClick(Math.round(e.latlng.lat * 1e6) / 1e6, Math.round(e.latlng.lng * 1e6) / 1e6) });
  return null;
}

export function PanTo({ to }: { to: [number, number] | null }): null {
  const map = useMap();
  useEffect(() => {
    if (to) map.panTo(to, { animate: true });
  }, [to?.[0], to?.[1]]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}
