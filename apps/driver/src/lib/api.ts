import AsyncStorage from '@react-native-async-storage/async-storage';
import NetInfo from '@react-native-community/netinfo';
import Constants from 'expo-constants';
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';

export const API_URL: string = (process.env.EXPO_PUBLIC_API_URL ?? (Constants.expoConfig?.extra?.apiUrl as string | undefined) ?? 'http://10.0.2.2:4000').replace(/\/$/, '');

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

const K = { access: 'jfs.access', refresh: 'jfs.refresh' };
let access: string | null = null;
let refreshing: Promise<boolean> | null = null;
const listeners = new Set<(signedIn: boolean) => void>();
export const onAuth = (fn: (s: boolean) => void): (() => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};
const emit = (s: boolean): void => listeners.forEach((l) => l(s));

export async function loadSession(): Promise<boolean> {
  access = await SecureStore.getItemAsync(K.access);
  const r = await SecureStore.getItemAsync(K.refresh);
  return Boolean(access && r);
}
export async function saveTokens(a: string, r: string): Promise<void> {
  access = a;
  await SecureStore.setItemAsync(K.access, a);
  await SecureStore.setItemAsync(K.refresh, r);
  emit(true);
}
export async function clearTokens(): Promise<void> {
  access = null;
  await SecureStore.deleteItemAsync(K.access);
  await SecureStore.deleteItemAsync(K.refresh);
  emit(false);
}

async function refresh(): Promise<boolean> {
  refreshing ??= (async () => {
    try {
      const rt = await SecureStore.getItemAsync(K.refresh);
      if (!rt) return false;
      const res = await fetch(`${API_URL}/api/v1/auth/refresh`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refresh_token: rt }) });
      if (res.status === 401 || res.status === 403) {
        await clearTokens();
        return false;
      }
      if (!res.ok) return false;
      const j = (await res.json()) as { access_token: string; refresh_token: string };
      await saveTokens(j.access_token, j.refresh_token);
      return true;
    } catch {
      return false;
    } finally {
      setTimeout(() => (refreshing = null), 0);
    }
  })();
  return refreshing;
}

export async function request<T>(method: string, path: string, body?: unknown, retry = true): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (access) headers.Authorization = `Bearer ${access}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${API_URL}/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (res.status === 401 && retry && !path.startsWith('/auth/')) {
    if (await refresh()) return request<T>(method, path, body, false);
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const j = text ? (JSON.parse(text) as unknown) : undefined;
  if (!res.ok) {
    const e = (j as { error?: { code?: string; message?: string } } | undefined)?.error;
    throw new ApiError(res.status, e?.code ?? 'error', e?.message ?? `Request failed (${res.status})`);
  }
  return j as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body: unknown = {}) => request<T>('POST', path, body),
  put: <T>(path: string, body: unknown = {}) => request<T>('PUT', path, body),
  /** Uploads a local file (camera photo, signature PNG) and returns its file id. */
  async upload(uri: string, purpose: string, contentType = 'image/jpeg'): Promise<string> {
    const blob = await (await fetch(uri)).blob();
    const slot = await request<{ file_id: string; upload_url: string; headers: Record<string, string> }>('POST', '/files/uploads', {
      purpose,
      file_name: uri.split('/').pop() ?? `photo-${Date.now()}.jpg`,
      content_type: contentType,
      size_bytes: blob.size,
    });
    const put = await fetch(slot.upload_url, { method: 'PUT', headers: slot.headers, body: blob });
    if (!put.ok) throw new ApiError(put.status, 'upload_failed', 'Photo upload failed');
    await request('POST', `/files/${slot.file_id}/complete`, {});
    return slot.file_id;
  },
};

// ---------------------------------------------------------------- offline outbox
/**
 * Actions taken without signal (stop arrivals/completions, fuel logs, messages, inspections) are queued and replayed in order
 * when the phone reconnects. Every queued call carries an idempotency key the API understands where applicable.
 */
export interface OutboxItem {
  id: string;
  method: 'POST' | 'PUT';
  path: string;
  body: Record<string, unknown>;
  /** Local file URIs to upload first; their ids replace body[field] (string or string[]). */
  files?: { field: string; uris: string[]; purpose: string; contentType?: string; single?: boolean }[];
  label: string;
  createdAt: number;
  attempts: number;
  lastError?: string;
}
const OUTBOX = 'jfs.outbox';
const outboxListeners = new Set<(n: number) => void>();
export const onOutbox = (fn: (n: number) => void): (() => void) => {
  outboxListeners.add(fn);
  return () => outboxListeners.delete(fn);
};

export async function readOutbox(): Promise<OutboxItem[]> {
  try {
    return JSON.parse((await AsyncStorage.getItem(OUTBOX)) ?? '[]') as OutboxItem[];
  } catch {
    return [];
  }
}
async function writeOutbox(items: OutboxItem[]): Promise<void> {
  await AsyncStorage.setItem(OUTBOX, JSON.stringify(items));
  outboxListeners.forEach((l) => l(items.length));
}

/** Sends now if online, otherwise queues. Returns true when sent immediately. */
export async function sendOrQueue(item: Omit<OutboxItem, 'id' | 'createdAt' | 'attempts'>): Promise<boolean> {
  const full: OutboxItem = { ...item, id: Crypto.randomUUID(), createdAt: Date.now(), attempts: 0 };
  const net = await NetInfo.fetch();
  if (net.isConnected && net.isInternetReachable !== false) {
    try {
      await deliver(full);
      return true;
    } catch (e) {
      if (e instanceof ApiError && e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429) throw e; // a real rejection: tell the user
    }
  }
  await writeOutbox([...(await readOutbox()), full]);
  return false;
}

async function deliver(item: OutboxItem): Promise<void> {
  const body = { ...item.body };
  for (const f of item.files ?? []) {
    const ids: string[] = [];
    for (const uri of f.uris) ids.push(await api.upload(uri, f.purpose, f.contentType));
    setDeep(body, f.field, f.single ? (ids[0] ?? null) : ids);
  }
  await request(item.method, item.path, body);
}
function setDeep(o: Record<string, unknown>, path: string, v: unknown): void {
  const parts = path.split('.');
  let cur = o;
  for (const p of parts.slice(0, -1)) cur = (cur[p] ??= {}) as Record<string, unknown>;
  cur[parts[parts.length - 1]!] = v;
}

let flushing = false;
export async function flushOutbox(): Promise<number> {
  if (flushing) return 0;
  flushing = true;
  let sent = 0;
  try {
    let items = await readOutbox();
    while (items.length) {
      const it = items[0]!;
      try {
        await deliver(it);
        sent++;
        items = items.slice(1);
      } catch (e) {
        if (e instanceof ApiError && e.status >= 400 && e.status < 500 && e.status !== 401 && e.status !== 408 && e.status !== 429) {
          items = items.slice(1); // permanently rejected - drop it, keep the reason in the log
          console.warn('outbox item rejected', it.label, e.message);
        } else {
          items[0] = { ...it, attempts: it.attempts + 1, lastError: (e as Error).message };
          break;
        }
      }
      await writeOutbox(items);
    }
    await writeOutbox(items);
  } finally {
    flushing = false;
  }
  return sent;
}

NetInfo.addEventListener((s) => {
  if (s.isConnected && s.isInternetReachable !== false) void flushOutbox();
});
