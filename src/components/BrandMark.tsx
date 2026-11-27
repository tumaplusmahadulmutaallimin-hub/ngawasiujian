import React, { useEffect, useState } from 'react';
import { apiFetch, computeServerClockDate } from '../lib/api.ts';
import type { ServerWibTime } from '../types.ts';

export const BrandMark: React.FC<{ compact?: boolean; inverse?: boolean }> = ({
  compact = false,
  inverse = false,
}) => {
  return (
    <div className="flex items-center gap-2.5 whitespace-nowrap shrink-0">
      <svg
        width="34"
        height="34"
        viewBox="0 0 36 36"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
        className="shrink-0"
      >
        <rect width="36" height="36" rx="9" fill={inverse ? '#087F5B' : '#10243A'} />
        <path
          d="M18 6.5L27.5 10.8V18.2C27.5 23.9 23.4 28.9 18 30.3C12.6 28.9 8.5 23.9 8.5 18.2V10.8L18 6.5Z"
          stroke="#C9A45C"
          strokeWidth="1.8"
          strokeLinejoin="round"
        />
        <path
          d="M13.8 18.2L16.7 21.1L22.6 15.1"
          stroke={inverse ? '#FFFFFF' : '#E8F5EF'}
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <div className="flex flex-col leading-none">
        <span
          className={`font-display text-base sm:text-lg font-bold tracking-tight ${
            inverse ? 'text-white' : 'text-[#10243A]'
          }`}
        >
          SIPENGUJI
        </span>
        {!compact && (
          <span
            className={`text-[11px] font-medium mt-0.5 ${
              inverse ? 'text-slate-300' : 'text-[#718096]'
            }`}
          >
            Pengawasan Ujian Madrasah
          </span>
        )}
      </div>
    </div>
  );
};

export function useServerWibClock(): ServerWibTime {
  const [offsetMs, setOffsetMs] = useState(0);
  const [clock, setClock] = useState<ServerWibTime>(() => computeServerClockDate(0));

  useEffect(() => {
    let active = true;
    const sync = async () => {
      try {
        const before = Date.now();
        const server = await apiFetch<ServerWibTime>('/api/server-time');
        const after = Date.now();
        if (!active) return;
        const rttHalf = Math.floor((after - before) / 2);
        const nextOffset = server.timestampMs + rttHalf - after;
        setOffsetMs(nextOffset);
        setClock(computeServerClockDate(nextOffset));
      } catch {
        // Keep last known offset if offline
      }
    };
    sync();
    const resyncId = setInterval(sync, 60_000);
    return () => {
      active = false;
      clearInterval(resyncId);
    };
  }, []);

  useEffect(() => {
    const tick = setInterval(() => {
      setClock(computeServerClockDate(offsetMs));
    }, 1000);
    return () => clearInterval(tick);
  }, [offsetMs]);

  return clock;
}
