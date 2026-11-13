import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Application from 'expo-application';
import * as Crypto from 'expo-crypto';
import * as Device from 'expo-device';
import * as Location from 'expo-location';
import * as SecureStore from 'expo-secure-store';
import * as TaskManager from 'expo-task-manager';
import { api } from './api';

/**
 * Phone-as-tracker: for vehicles without a hardware GPS unit, the driver's phone reports positions to the ingest gateway while
 * the driver is on shift. Positions are buffered on the phone when there is no signal and uploaded in order later.
 */
export const TASK = 'jfs-background-location';
const CREDS = 'jfs.tracker';
const BUFFER = 'jfs.trackbuf';
const MAX_BUFFER = 5000;

interface Creds {
  identifier: string;
  token: string;
  ingest_url: string;
  tracking: 'phone' | 'hardware' | 'none';
}
interface Pos {
  t: string;
  lat: number;
  lng: number;
  speed_kph?: number;
  heading?: number;
  accuracy_m?: number;
  altitude_m?: number;
}

async function installId(): Promise<string> {
  let id = await SecureStore.getItemAsync('jfs.install');
  if (!id) {
    id = (Application.getAndroidId?.() ?? Crypto.randomUUID()).replace(/[^A-Za-z0-9]/g, '').slice(0, 32);
    if (id.length < 8) id = Crypto.randomUUID().replace(/-/g, '').slice(0, 24);
    await SecureStore.setItemAsync('jfs.install', id);
  }
  return id;
}

/** Registers the phone with the API (rotating its upload token) and returns how this vehicle is tracked. */
export async function registerPhone(): Promise<Creds> {
  const c = await api.post<Creds>('/driver-app/phone-tracker', { install_id: await installId(), device_name: `${Device.manufacturer ?? ''} ${Device.modelName ?? 'phone'}`.trim() });
  await SecureStore.setItemAsync(CREDS, JSON.stringify(c));
  return c;
}

async function creds(): Promise<Creds | null> {
  const s = await SecureStore.getItemAsync(CREDS);
  return s ? (JSON.parse(s) as Creds) : null;
}

async function upload(batch: Pos[]): Promise<boolean> {
  const c = await creds();
  if (!c || c.tracking !== 'phone') return true; // nothing to do - drop
  try {
    const res = await fetch(c.ingest_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Device-Id': c.identifier, Authorization: `Bearer ${c.token}` },
      body: JSON.stringify({ positions: batch }),
    });
    if (res.status === 401) {
      await registerPhone().catch(() => undefined); // token rotated elsewhere: re-register and retry next time
      return false;
    }
    return res.ok || (res.status >= 400 && res.status < 500 && res.status !== 429);
  } catch {
    return false;
  }
}

async function enqueue(ps: Pos[]): Promise<void> {
  const buf = JSON.parse((await AsyncStorage.getItem(BUFFER)) ?? '[]') as Pos[];
  const next = [...buf, ...ps].slice(-MAX_BUFFER);
  // try to drain in chunks of 200 (API limit 500)
  let rest = next;
  while (rest.length) {
    const chunk = rest.slice(0, 200);
    if (!(await upload(chunk))) break;
    rest = rest.slice(chunk.length);
  }
  await AsyncStorage.setItem(BUFFER, JSON.stringify(rest));
}

TaskManager.defineTask(TASK, async ({ data, error }) => {
  if (error) return;
  const locs = (data as { locations?: Location.LocationObject[] } | undefined)?.locations ?? [];
  if (!locs.length) return;
  await enqueue(
    locs.map((l) => ({
      t: new Date(l.timestamp).toISOString(),
      lat: l.coords.latitude,
      lng: l.coords.longitude,
      speed_kph: l.coords.speed !== null && l.coords.speed >= 0 ? Math.round(l.coords.speed * 3.6 * 10) / 10 : undefined,
      heading: l.coords.heading !== null && l.coords.heading >= 0 ? Math.round(l.coords.heading) : undefined,
      accuracy_m: l.coords.accuracy ?? undefined,
      altitude_m: l.coords.altitude ?? undefined,
    })),
  );
});

export async function startTracking(): Promise<{ ok: boolean; reason?: string; mode?: Creds['tracking'] }> {
  const c = await registerPhone();
  if (c.tracking !== 'phone') return { ok: true, mode: c.tracking };
  const fg = await Location.requestForegroundPermissionsAsync();
  if (fg.status !== 'granted') return { ok: false, reason: 'Location permission is needed to track the vehicle' };
  const bg = await Location.requestBackgroundPermissionsAsync();
  if (bg.status !== 'granted') return { ok: false, reason: 'Allow location "All the time" so tracking continues with the screen off' };
  if (await Location.hasStartedLocationUpdatesAsync(TASK)) return { ok: true, mode: 'phone' };
  await Location.startLocationUpdatesAsync(TASK, {
    accuracy: Location.Accuracy.High,
    timeInterval: 15_000,
    distanceInterval: 25,
    deferredUpdatesInterval: 30_000,
    pausesUpdatesAutomatically: false,
    showsBackgroundLocationIndicator: true,
    foregroundService: {
      notificationTitle: 'Jatelo Fleet is tracking this trip',
      notificationBody: 'Your location is shared with dispatch while you are on shift.',
      notificationColor: '#0F6B4F',
      killServiceOnDestroy: false,
    },
  });
  return { ok: true, mode: 'phone' };
}

export async function stopTracking(): Promise<void> {
  if (await Location.hasStartedLocationUpdatesAsync(TASK).catch(() => false)) await Location.stopLocationUpdatesAsync(TASK);
  await enqueue([]); // final drain attempt
}

export async function isTracking(): Promise<boolean> {
  return Location.hasStartedLocationUpdatesAsync(TASK).catch(() => false);
}

export async function pendingPositions(): Promise<number> {
  return (JSON.parse((await AsyncStorage.getItem(BUFFER)) ?? '[]') as Pos[]).length;
}

/** Current GPS fix for stamping actions (arrival, POD, fuel). */
export async function here(): Promise<{ lat: number; lng: number } | null> {
  try {
    const l = (await Location.getLastKnownPositionAsync({ maxAge: 60_000 })) ?? (await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }));
    return { lat: l.coords.latitude, lng: l.coords.longitude };
  } catch {
    return null;
  }
}
