/** API client: in-memory access token, silent refresh through the httpOnly refresh cookie, typed errors. */
export const API_BASE = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') ?? '';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

let accessToken: string | null = null;
let refreshing: Promise<boolean> | null = null;
const listeners = new Set<(signedIn: boolean) => void>();

export const getToken = (): string | null => accessToken;
export function setToken(t: string | null): void {
  accessToken = t;
  for (const l of listeners) l(Boolean(t));
}
export function onAuthChange(fn: (signedIn: boolean) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Uses the refresh cookie to get a new access token. Concurrent callers share one request. */
export function refresh(): Promise<boolean> {
  refreshing ??= (async () => {
    try {
      const res = await fetch(`${API_BASE}/api/v1/auth/refresh`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      if (!res.ok) {
        setToken(null);
        return false;
      }
      const j = (await res.json()) as { access_token: string };
      setToken(j.access_token);
      return true;
    } catch {
      return false;
    } finally {
      setTimeout(() => (refreshing = null), 0);
    }
  })();
  return refreshing;
}

export type Query = Record<string, string | number | boolean | null | undefined | string[]>;

export function qs(q?: Query): string {
  if (!q) return '';
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) {
    if (v === undefined || v === null || v === '') continue;
    p.set(k, Array.isArray(v) ? v.join(',') : String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : '';
}

async function raw(method: string, path: string, body?: unknown, retry = true): Promise<Response> {
  const headers: Record<string, string> = {};
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  let payload: BodyInit | undefined;
  if (body instanceof FormData || body instanceof Blob) payload = body;
  else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${API_BASE}/api/v1${path}`, { method, headers, body: payload, credentials: 'include' });
  if (res.status === 401 && retry && !path.startsWith('/auth/login') && !path.startsWith('/auth/refresh')) {
    if (await refresh()) return raw(method, path, body, false);
  }
  return res;
}

async function parse<T>(res: Response): Promise<T> {
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const j = text ? (JSON.parse(text) as unknown) : undefined;
  if (!res.ok) {
    const e = (j as { error?: { code?: string; message?: string; details?: unknown } } | undefined)?.error;
    throw new ApiError(res.status, e?.code ?? 'error', e?.message ?? res.statusText, e?.details);
  }
  return j as T;
}

export const api = {
  get: <T>(path: string, q?: Query) => raw('GET', path + qs(q)).then((r) => parse<T>(r)),
  post: <T>(path: string, body?: unknown) => raw('POST', path, body ?? {}).then((r) => parse<T>(r)),
  put: <T>(path: string, body?: unknown) => raw('PUT', path, body ?? {}).then((r) => parse<T>(r)),
  patch: <T>(path: string, body?: unknown) => raw('PATCH', path, body ?? {}).then((r) => parse<T>(r)),
  del: <T = void>(path: string) => raw('DELETE', path).then((r) => parse<T>(r)),
  /** Downloads a file response (reports, invoice PDFs) and saves it in the browser. */
  async download(path: string, q?: Query, fallbackName = 'download'): Promise<void> {
    const res = await raw('GET', path + qs(q));
    if (!res.ok) await parse(res);
    const blob = await res.blob();
    const cd = res.headers.get('content-disposition') ?? '';
    const name = /filename="?([^"]+)"?/.exec(cd)?.[1] ?? fallbackName;
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement('a'), { href: url, download: name });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  },
  /** Uploads a file through the presigned flow; returns the file id. */
  async upload(file: File, purpose: string): Promise<string> {
    const u = await api.post<{ file_id: string; upload_url: string; headers?: Record<string, string> }>('/files/uploads', {
      purpose,
      file_name: file.name,
      content_type: file.type || 'application/octet-stream',
      size_bytes: file.size,
    });
    const put = await fetch(u.upload_url, { method: 'PUT', body: file, headers: u.headers ?? { 'Content-Type': file.type } });
    if (!put.ok) throw new ApiError(put.status, 'upload_failed', 'The file could not be uploaded');
    await api.post(`/files/${u.file_id}/complete`);
    return u.file_id;
  },
};

export interface Page<T> {
  data: T[];
  pagination: { page: number; page_size: number; total: number };
}
export type Row = Record<string, unknown>;
