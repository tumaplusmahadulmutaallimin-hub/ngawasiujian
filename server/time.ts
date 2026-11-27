import type { ScheduleStatus, ServerWibTime } from '../src/types.ts';

/**
 * Computes authoritative server time in WIB (Asia/Jakarta, UTC+07:00).
 * Never relies on client clock (NFR-08, NFR-14, BR-04).
 */
export function getServerWibNow(now: Date = new Date()): ServerWibTime {
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

  const parts = formatter.formatToParts(now);
  const map: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== 'literal') {
      map[part.type] = part.value;
    }
  }
  const hour = map.hour === '24' ? '00' : map.hour;
  const date = `${map.year}-${map.month}-${map.day}`;
  const time = `${hour}:${map.minute}:${map.second}`;
  return {
    date,
    time,
    isoWib: `${date}T${time}+07:00`,
    timestampMs: now.getTime(),
  };
}

export function formatWibTimestamp(date: Date = new Date()): string {
  const wib = getServerWibNow(date);
  return `${wib.date} ${wib.time} WIB`;
}

function parseWibDateTimeMs(tanggal: string, hhmm: string): number {
  const normalizedTime = hhmm.length === 5 ? `${hhmm}:00` : hhmm;
  return Date.parse(`${tanggal}T${normalizedTime}+07:00`);
}

/**
 * Evaluates schedule status solely from server WIB time (FR-JDW-03, FR-JDW-04, BR-04).
 */
export function computeScheduleStatus(
  tanggal: string,
  jamMulai: string,
  jamSelesai: string,
  manualCancel: number | boolean = 0,
  now: Date = new Date()
): ScheduleStatus {
  if (manualCancel) return 'dibatalkan';
  const nowMs = now.getTime();
  const startMs = parseWibDateTimeMs(tanggal, jamMulai);
  const endMs = parseWibDateTimeMs(tanggal, jamSelesai);
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) return 'akan_datang';
  if (nowMs < startMs) return 'akan_datang';
  if (nowMs >= startMs && nowMs < endMs) return 'aktif';
  return 'selesai';
}

export function computeRemainingSeconds(
  tanggal: string,
  jamSelesai: string,
  now: Date = new Date()
): number {
  const endMs = parseWibDateTimeMs(tanggal, jamSelesai);
  if (Number.isNaN(endMs)) return 0;
  return Math.max(0, Math.floor((endMs - now.getTime()) / 1000));
}

export function computeDurationSeconds(isoStart: string, isoEnd: string): number {
  const startMs = Date.parse(isoStart);
  const endMs = Date.parse(isoEnd);
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) return 0;
  return Math.max(0, Math.floor((endMs - startMs) / 1000));
}
