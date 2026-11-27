import type { ServerWibTime } from '../types.ts';

// Kept strictly in JS memory (never localStorage or sessionStorage) per security guidelines
let memoryToken: string | null = null;

export function setAuthToken(token: string | null): void {
  memoryToken = token;
}

export function getAuthToken(): string | null {
  return memoryToken;
}

export class ApiError extends Error {
  status: number;
  data: Record<string, unknown>;
  constructor(message: string, status: number, data: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

export async function apiFetch<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const headers = new Headers(options.headers || {});
  if (memoryToken) {
    headers.set('Authorization', `Bearer ${memoryToken}`);
  }
  if (!(options.body instanceof FormData) && !headers.has('Content-Type') && options.body) {
    headers.set('Content-Type', 'application/json');
  }

  const res = await fetch(path, {
    ...options,
    headers,
  });

  const text = await res.text();
  let json: Record<string, unknown> = {};
  if (text) {
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      json = { raw: text };
    }
  }

  if (!res.ok) {
    const message =
      (typeof json.error === 'string' && json.error) ||
      `Permintaan gagal (${res.status})`;
    throw new ApiError(message, res.status, json);
  }

  return json as T;
}

export async function downloadAuthenticatedFile(url: string, filename: string): Promise<void> {
  const headers = new Headers();
  if (memoryToken) headers.set('Authorization', `Bearer ${memoryToken}`);
  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error('Gagal mengunduh berkas.');
  }
  const blob = await res.blob();
  const objUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = objUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(objUrl);
}

export function computeServerClockDate(offsetMs: number): ServerWibTime {
  const adjusted = new Date(Date.now() + offsetMs);
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = formatter.formatToParts(adjusted);
  const map: Record<string, string> = {};
  for (const p of parts) {
    if (p.type !== 'literal') map[p.type] = p.value;
  }
  const hour = map.hour === '24' ? '00' : map.hour;
  const date = `${map.year}-${map.month}-${map.day}`;
  const time = `${hour}:${map.minute}:${map.second}`;
  return {
    date,
    time,
    isoWib: `${date}T${time}+07:00`,
    timestampMs: adjusted.getTime(),
  };
}
