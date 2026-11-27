import React, { useEffect } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Info,
  X,
  XCircle,
} from 'lucide-react';

export type BadgeTone = 'emerald' | 'navy' | 'gold' | 'amber' | 'rose' | 'slate';

export const StatusBadge: React.FC<{
  tone?: BadgeTone;
  icon?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}> = ({ tone = 'slate', icon, children, className = '' }) => {
  const styles: Record<BadgeTone, string> = {
    emerald: 'bg-[#E8F5EF] text-[#087F5B] border-[#B7E4D0]',
    navy: 'bg-[#10243A]/8 text-[#10243A] border-[#10243A]/15',
    gold: 'bg-[#C9A45C]/15 text-[#8B6A28] border-[#C9A45C]/40',
    amber: 'bg-amber-50 text-amber-800 border-amber-200',
    rose: 'bg-rose-50 text-rose-800 border-rose-200',
    slate: 'bg-slate-100 text-[#718096] border-[#E5EAF0]',
  };

  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border text-xs font-semibold whitespace-nowrap shrink-0 ${styles[tone]} ${className}`}
    >
      {icon}
      <span>{children}</span>
    </span>
  );
};

export function scheduleStatusBadge(status: string): React.ReactNode {
  if (status === 'aktif') {
    return (
      <StatusBadge tone="emerald" icon={<CheckCircle2 className="w-3.5 h-3.5" />}>
        Aktif
      </StatusBadge>
    );
  }
  if (status === 'akan_datang') {
    return (
      <StatusBadge tone="gold" icon={<Clock className="w-3.5 h-3.5" />}>
        Akan Datang
      </StatusBadge>
    );
  }
  if (status === 'dibatalkan') {
    return (
      <StatusBadge tone="rose" icon={<XCircle className="w-3.5 h-3.5" />}>
        Dibatalkan
      </StatusBadge>
    );
  }
  return (
    <StatusBadge tone="slate" icon={<CheckCircle2 className="w-3.5 h-3.5" />}>
      Selesai
    </StatusBadge>
  );
}

export function reportStatusBadge(status: string): React.ReactNode {
  if (status === 'terverifikasi') {
    return (
      <StatusBadge tone="emerald" icon={<CheckCircle2 className="w-3.5 h-3.5" />}>
        Terverifikasi
      </StatusBadge>
    );
  }
  if (status === 'perlu_perbaikan') {
    return (
      <StatusBadge tone="rose" icon={<AlertTriangle className="w-3.5 h-3.5" />}>
        Perlu Perbaikan
      </StatusBadge>
    );
  }
  if (status === 'menunggu_verifikasi') {
    return (
      <StatusBadge tone="amber" icon={<Clock className="w-3.5 h-3.5" />}>
        Menunggu Verifikasi
      </StatusBadge>
    );
  }
  if (status === 'belum_dikirim') {
    return <StatusBadge tone="navy">Belum Dikirim</StatusBadge>;
  }
  return <StatusBadge tone="slate">Belum Dikerjakan</StatusBadge>;
}

export const StatCard: React.FC<{
  label: string;
  value: string | number;
  subtext?: string;
  icon: React.ReactNode;
  accent?: 'emerald' | 'navy' | 'gold' | 'rose';
}> = ({ label, value, subtext, icon, accent = 'emerald' }) => {
  const iconBg = {
    emerald: 'bg-[#E8F5EF] text-[#087F5B]',
    navy: 'bg-[#10243A]/8 text-[#10243A]',
    gold: 'bg-[#C9A45C]/15 text-[#8B6A28]',
    rose: 'bg-rose-50 text-rose-700',
  }[accent];

  return (
    <div className="bg-white border border-[#E5EAF0] rounded-xl p-4 sm:p-5 shadow-card flex flex-col justify-between gap-3">
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs font-medium text-[#718096] leading-snug">{label}</p>
        <div className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${iconBg}`}>
          {icon}
        </div>
      </div>
      <div>
        <p className="font-mono-tabular text-2xl font-bold text-[#172B4D] tracking-tight">{value}</p>
        {subtext && <p className="text-xs text-[#718096] mt-1">{subtext}</p>}
      </div>
    </div>
  );
};

export const SkeletonBlock: React.FC<{ rows?: number }> = ({ rows = 4 }) => (
  <div className="bg-white border border-[#E5EAF0] rounded-xl p-5 space-y-3 animate-pulse">
    <div className="h-4 bg-slate-200/80 rounded w-1/3" />
    {Array.from({ length: rows }).map((_, i) => (
      <div key={i} className="h-10 bg-slate-100 rounded-lg w-full" />
    ))}
  </div>
);

export const EmptyState: React.FC<{
  icon: React.ReactNode;
  title: string;
  description: string;
  action?: React.ReactNode;
}> = ({ icon, title, description, action }) => (
  <div className="bg-white border border-[#E5EAF0] rounded-xl p-8 sm:p-10 text-center max-w-lg mx-auto my-4">
    <div className="w-12 h-12 rounded-xl bg-[#E8F5EF] text-[#087F5B] flex items-center justify-center mx-auto mb-3.5">
      {icon}
    </div>
    <h3 className="font-display text-base font-bold text-[#172B4D]">{title}</h3>
    <p className="text-sm text-[#718096] mt-1.5 leading-relaxed">{description}</p>
    {action && <div className="mt-5 flex justify-center">{action}</div>}
  </div>
);

export const ToastNotification: React.FC<{
  message: string | null;
  type?: 'success' | 'error' | 'info';
  onDismiss: () => void;
}> = ({ message, type = 'success', onDismiss }) => {
  useEffect(() => {
    if (!message) return;
    const t = setTimeout(onDismiss, 5500);
    return () => clearTimeout(t);
  }, [message, onDismiss]);

  if (!message) return null;

  const tone =
    type === 'error'
      ? 'bg-[#10243A] text-white border-rose-400/50'
      : type === 'info'
      ? 'bg-[#10243A] text-white border-[#C9A45C]/50'
      : 'bg-[#10243A] text-white border-[#087F5B]';

  const Icon =
    type === 'error' ? AlertCircle : type === 'info' ? Info : CheckCircle2;

  return (
    <div className="fixed bottom-20 lg:bottom-6 right-4 sm:right-6 z-50 max-w-md w-[calc(100%-2rem)] sm:w-auto">
      <div
        className={`flex items-start gap-3 px-4 py-3.5 rounded-xl border shadow-elevated text-sm ${tone}`}
        role="status"
      >
        <Icon
          className={`w-4 h-4 shrink-0 mt-0.5 ${
            type === 'error'
              ? 'text-rose-400'
              : type === 'info'
              ? 'text-[#C9A45C]'
              : 'text-emerald-400'
          }`}
        />
        <span className="flex-1 leading-snug">{message}</span>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Tutup notifikasi"
          className="text-slate-300 hover:text-white p-0.5 shrink-0"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
};
