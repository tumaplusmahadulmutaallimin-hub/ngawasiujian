import React, { useCallback, useEffect, useState } from 'react';
import {
  ArrowRight,
  Bell,
  Calendar,
  CheckCircle2,
  ClipboardCheck,
  Clock,
  FileCheck2,
  Home,
  Inbox,
  LogOut,
  MapPin,
  PenTool,
  Play,
  ShieldCheck,
  User,
  Users,
} from 'lucide-react';
import { apiFetch } from '../lib/api.ts';
import type { AuthUser, NotificationRecord, SupervisionScheduleItem } from '../types.ts';
import { BrandMark, useServerWibClock } from './BrandMark.tsx';
import { SignaturePad } from './SignaturePad.tsx';
import { SupervisionRoom } from './SupervisionRoom.tsx';
import {
  EmptyState,
  SkeletonBlock,
  StatCard,
  StatusBadge,
  ToastNotification,
  reportStatusBadge,
  scheduleStatusBadge,
} from './ui/Primitives.tsx';

interface SupervisorWorkspaceProps {
  user: AuthUser;
  onLogout: () => void;
  onUserUpdated: (user: AuthUser) => void;
}

type SupTab = 'dashboard' | 'jadwal' | 'riwayat' | 'notifikasi' | 'profil';

export const SupervisorWorkspace: React.FC<SupervisorWorkspaceProps> = ({
  user,
  onLogout,
  onUserUpdated,
}) => {
  const wibClock = useServerWibClock();
  const [tab, setTab] = useState<SupTab>('dashboard');
  const [schedules, setSchedules] = useState<SupervisionScheduleItem[]>([]);
  const [notifications, setNotifications] = useState<NotificationRecord[]>([]);
  const [activeRoomScheduleId, setActiveRoomScheduleId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' | 'info' } | null>(
    null
  );

  // Profile editor states (FR-PRF)
  const [profileData, setProfileData] = useState<Record<string, string | null>>({});
  const [profWhatsapp, setProfWhatsapp] = useState('');
  const [profAlamat, setProfAlamat] = useState('');
  const [profTempat, setProfTempat] = useState('');
  const [profTgl, setProfTgl] = useState('');
  const [profFoto, setProfFoto] = useState<string | null>(null);
  const [profTtd, setProfTtd] = useState<string | null>(null);
  const [profSaving, setProfSaving] = useState(false);

  const loadData = useCallback(async () => {
    try {
      const [schedRes, notifRes, profRes] = await Promise.all([
        apiFetch<{ schedules: SupervisionScheduleItem[] }>('/api/supervisor/schedules'),
        apiFetch<NotificationRecord[]>('/api/notifications'),
        apiFetch<{ profile?: Record<string, string | null> }>('/api/profile'),
      ]);
      setSchedules(schedRes.schedules);
      setNotifications(notifRes);
      if (profRes.profile) {
        setProfileData(profRes.profile);
        setProfWhatsapp(profRes.profile.whatsapp || '');
        setProfAlamat(profRes.profile.alamat || '');
        setProfTempat(profRes.profile.tempat_lahir || '');
        setProfTgl(profRes.profile.tgl_lahir || '');
        setProfFoto(profRes.profile.foto_url || null);
        setProfTtd(profRes.profile.ttd_url || null);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
    const poll = () => {
      if (typeof document !== 'undefined' && document.hidden) return;
      loadData();
    };
    const id = setInterval(poll, 10_000);
    const onFocus = () => {
      if (typeof document === 'undefined' || !document.hidden) {
        loadData();
      }
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      clearInterval(id);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [loadData]);

  if (activeRoomScheduleId !== null) {
    return (
      <SupervisionRoom
        scheduleId={activeRoomScheduleId}
        currentUser={user}
        onBack={() => {
          setActiveRoomScheduleId(null);
          loadData();
        }}
      />
    );
  }

  const unreadCount = notifications.filter((n) => n.dibaca === 0).length;
  const activeSchedules = schedules.filter((s) => s.computed_status === 'aktif');
  const upcomingSchedules = schedules.filter((s) => s.computed_status === 'akan_datang');
  const completedSchedules = schedules.filter((s) => s.computed_status === 'selesai');
  const verifiedReportsCount = schedules.filter((s) => s.report_status === 'terverifikasi').length;
  const pendingReportsCount = schedules.filter(
    (s) =>
      s.computed_status !== 'akan_datang' &&
      s.computed_status !== 'dibatalkan' &&
      s.report_status !== 'terverifikasi'
  ).length;
  const nextSchedule = activeSchedules[0] || upcomingSchedules[0] || null;

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    setProfSaving(true);
    try {
      const res = await apiFetch<{ profile: Record<string, string | null> }>('/api/profile', {
        method: 'PUT',
        body: JSON.stringify({
          whatsapp: profWhatsapp,
          alamat: profAlamat,
          tempat_lahir: profTempat,
          tgl_lahir: profTgl,
          foto_url: profFoto,
          ttd_url: profTtd,
        }),
      });
      setProfileData(res.profile);
      onUserUpdated({
        ...user,
        fotoUrl: res.profile.foto_url,
        ttdUrl: res.profile.ttd_url,
      });
      setToast({
        message: 'Profil dan tanda tangan digital berhasil diperbarui serta dicatat di audit log.',
        type: 'success',
      });
    } catch (err) {
      setToast({
        message: err instanceof Error ? err.message : 'Gagal menyimpan profil.',
        type: 'error',
      });
    } finally {
      setProfSaving(false);
    }
  };

  const handleMarkRead = async (id: number) => {
    await apiFetch(`/api/notifications/${id}/read`, { method: 'POST' });
    setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, dibaca: 1 } : n)));
  };

  const navItems: Array<{
    key: SupTab;
    label: string;
    icon: React.ComponentType<{ className?: string }>;
    badge?: number;
  }> = [
    { key: 'dashboard', label: 'Dashboard', icon: Home },
    { key: 'jadwal', label: 'Jadwal Pengawasan', icon: Calendar },
    { key: 'riwayat', label: 'Riwayat & Berkas', icon: FileCheck2 },
    { key: 'notifikasi', label: 'Notifikasi', icon: Bell, badge: unreadCount },
    { key: 'profil', label: 'Profil & TTD', icon: User },
  ];

  const pageTitle =
    tab === 'dashboard'
      ? 'Dashboard Pengawas'
      : tab === 'jadwal'
      ? 'Jadwal Pengawasan Saya'
      : tab === 'riwayat'
      ? 'Riwayat & Pengumpulan Berkas'
      : tab === 'notifikasi'
      ? 'Notifikasi Panitia'
      : 'Profil & Tanda Tangan';

  return (
    <div className="min-h-screen bg-[#F5F7FA] text-[#172B4D] flex flex-col lg:flex-row pb-20 lg:pb-0">
      {/* Deep Navy Desktop Sidebar */}
      <aside className="hidden lg:flex lg:w-68 lg:flex-col bg-[#10243A] text-white shrink-0 border-r border-[#10243A]">
        <div className="p-5 border-b border-white/10">
          <BrandMark inverse />
          <div className="mt-3 flex items-center gap-2 text-[11px] font-medium text-[#C9A45C]">
            <ShieldCheck className="w-3.5 h-3.5 shrink-0" />
            <span>Portal Pengawas Ruang</span>
          </div>
        </div>

        <nav className="flex-1 p-3.5 space-y-1">
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = tab === item.key;
            return (
              <button
                key={item.key}
                type="button"
                onClick={() => setTab(item.key)}
                className={`w-full flex items-center justify-between gap-2.5 px-3.5 py-2.5 rounded-xl text-sm font-medium transition-colors min-h-[44px] ${
                  active
                    ? 'bg-[#087F5B] text-white shadow-card'
                    : 'text-slate-300 hover:bg-white/10 hover:text-white'
                }`}
              >
                <span className="flex items-center gap-3 min-w-0">
                  <Icon className="w-4 h-4 shrink-0" />
                  <span className="truncate">{item.label}</span>
                </span>
                {item.badge !== undefined && item.badge > 0 && (
                  <span className="px-2 py-0.5 rounded-full text-[11px] font-mono-tabular font-bold bg-[#C9A45C] text-[#10243A]">
                    {item.badge}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        <div className="p-4 border-t border-white/10 space-y-3 bg-black/15">
          <div className="flex items-center gap-3">
            {user.fotoUrl ? (
              <img
                src={user.fotoUrl}
                alt={user.namaLengkap}
                className="w-10 h-10 rounded-full object-cover border border-white/20 shrink-0"
              />
            ) : (
              <div className="w-10 h-10 rounded-full bg-[#087F5B] text-white flex items-center justify-center text-xs font-bold shrink-0 border border-[#C9A45C]/40">
                {user.namaLengkap.slice(0, 2).toUpperCase()}
              </div>
            )}
            <div className="min-w-0">
              <p className="text-xs font-semibold text-white truncate">{user.namaLengkap}</p>
              <p className="text-[11px] text-slate-300 font-mono-tabular truncate">
                {user.nipNuptk || user.username}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onLogout}
            className="w-full flex items-center justify-center gap-2 py-2 px-3 rounded-lg border border-white/15 bg-white/5 hover:bg-white/10 text-xs font-medium text-slate-100 min-h-[40px] transition-colors"
          >
            <LogOut className="w-3.5 h-3.5" />
            Keluar Akun
          </button>
        </div>
      </aside>

      {/* Main Column */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top Bar */}
        <header className="bg-white border-b border-[#E5EAF0] px-4 sm:px-6 py-3.5 flex items-center justify-between gap-4 sticky top-0 z-20">
          <div className="flex items-center gap-3 lg:hidden">
            <BrandMark compact />
          </div>
          <div className="hidden lg:block">
            <h1 className="font-display text-lg font-bold text-[#10243A]">{pageTitle}</h1>
            <p className="text-xs text-[#718096]">
              Sistem Pengawasan Terintegrasi · Sinkronisasi Waktu Server WIB
            </p>
          </div>
          <div className="flex items-center gap-2.5 sm:gap-3">
            <div className="px-3 py-1.5 rounded-lg bg-[#F5F7FA] border border-[#E5EAF0] font-mono-tabular text-xs font-semibold text-[#172B4D] hidden sm:flex items-center gap-1.5">
              <Clock className="w-3.5 h-3.5 text-[#087F5B]" />
              <span>
                {wibClock.date} · {wibClock.time} WIB
              </span>
            </div>
            <button
              type="button"
              onClick={() => setTab('notifikasi')}
              aria-label="Lihat Notifikasi"
              className="relative p-2.5 rounded-lg border border-[#E5EAF0] bg-white hover:bg-[#F5F7FA] text-[#172B4D] min-h-[42px] min-w-[42px] flex items-center justify-center transition-colors"
            >
              <Bell className="w-4 h-4" />
              {unreadCount > 0 && (
                <span className="absolute -top-1 -right-1 px-1.5 py-0.5 rounded-full bg-[#087F5B] text-white text-[10px] font-mono-tabular font-bold leading-none">
                  {unreadCount}
                </span>
              )}
            </button>
            <button
              type="button"
              onClick={onLogout}
              className="lg:hidden p-2.5 rounded-lg border border-[#E5EAF0] text-[#172B4D] hover:bg-[#F5F7FA] min-h-[42px] min-w-[42px] flex items-center justify-center"
              aria-label="Keluar"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </header>

        <main className="flex-1 p-4 sm:p-6 max-w-6xl w-full mx-auto space-y-6">
          {loading ? (
            <div className="space-y-4">
              <SkeletonBlock rows={2} />
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                <SkeletonBlock rows={1} />
                <SkeletonBlock rows={1} />
                <SkeletonBlock rows={1} />
                <SkeletonBlock rows={1} />
              </div>
              <SkeletonBlock rows={4} />
            </div>
          ) : tab === 'dashboard' ? (
            <>
              {/* Personal Greeting & Quick Start Hero Card (FR-DSB-01) */}
              <section className="bg-white border border-[#E5EAF0] rounded-2xl p-5 sm:p-6 shadow-card">
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-5">
                  <div className="flex items-center gap-4">
                    {user.fotoUrl ? (
                      <img
                        src={user.fotoUrl}
                        alt={user.namaLengkap}
                        className="w-16 h-16 rounded-2xl object-cover border border-[#E5EAF0] shrink-0"
                      />
                    ) : (
                      <div className="w-16 h-16 rounded-2xl bg-[#10243A] text-white flex items-center justify-center text-lg font-bold shrink-0 border border-[#C9A45C]/40">
                        {user.namaLengkap.slice(0, 2).toUpperCase()}
                      </div>
                    )}
                    <div className="min-w-0 space-y-1">
                      <p className="text-xs font-semibold uppercase tracking-wider text-[#087F5B]">
                        Selamat Bertugas
                      </p>
                      <h2 className="font-display text-xl sm:text-2xl font-bold text-[#10243A] truncate">
                        {user.namaLengkap}
                      </h2>
                      <div className="flex flex-wrap items-center gap-2 text-xs text-[#718096] font-mono-tabular">
                        <span>NIP/NUPTK: {user.nipNuptk || '-'}</span>
                        <span>·</span>
                        <span>@{user.username}</span>
                        <span>·</span>
                        {user.ttdUrl || profTtd ? (
                          <StatusBadge tone="emerald" icon={<PenTool className="w-3 h-3" />}>
                            TTD Tersedia
                          </StatusBadge>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setTab('profil')}
                            className="inline-flex items-center gap-1 text-amber-700 font-sans font-semibold hover:underline"
                          >
                            Lengkapi Tanda Tangan →
                          </button>
                        )}
                      </div>
                    </div>
                  </div>

                  {activeSchedules.length > 0 ? (
                    <button
                      type="button"
                      onClick={() => setActiveRoomScheduleId(activeSchedules[0].id)}
                      className="px-5 py-3 rounded-xl bg-[#087F5B] hover:bg-[#06694b] text-white text-sm font-semibold inline-flex items-center justify-center gap-2.5 min-h-[48px] shadow-card transition-colors shrink-0"
                    >
                      <Play className="w-4 h-4 fill-current" />
                      <span>MULAI PENGAWASAN ({activeSchedules[0].room_kode})</span>
                    </button>
                  ) : nextSchedule ? (
                    <div className="px-4 py-3 rounded-xl bg-[#F5F7FA] border border-[#E5EAF0] text-xs text-[#172B4D] flex items-center gap-2.5 shrink-0">
                      <Clock className="w-4 h-4 text-[#C9A45C] shrink-0" />
                      <div>
                        <p className="font-semibold">Jadwal Berikutnya: {nextSchedule.room_kode}</p>
                        <p className="text-[#718096] font-mono-tabular">
                          {nextSchedule.tanggal} · {nextSchedule.jam_mulai} WIB
                        </p>
                      </div>
                    </div>
                  ) : null}
                </div>
              </section>

              {/* KPI Strip (FR-DSB-02) */}
              <section className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                <StatCard
                  label="Total Jadwal Ditugaskan"
                  value={schedules.length}
                  subtext={`${completedSchedules.length} sesi selesai`}
                  icon={<Calendar className="w-4 h-4" />}
                  accent="navy"
                />
                <StatCard
                  label="Jadwal Aktif Sekarang"
                  value={activeSchedules.length}
                  subtext={
                    activeSchedules.length > 0
                      ? `Ruang ${activeSchedules[0].room_kode} siap diawasi`
                      : 'Belum ada sesi berlangsung'
                  }
                  icon={<Play className="w-4 h-4" />}
                  accent="emerald"
                />
                <StatCard
                  label="Jadwal Akan Datang"
                  value={upcomingSchedules.length}
                  subtext={
                    upcomingSchedules[0]
                      ? `Terdekat ${upcomingSchedules[0].jam_mulai} WIB`
                      : 'Tidak ada jadwal tertunda'
                  }
                  icon={<Clock className="w-4 h-4" />}
                  accent="gold"
                />
                <StatCard
                  label="Notifikasi Belum Dibaca"
                  value={unreadCount}
                  subtext={`${verifiedReportsCount} berkas terverifikasi`}
                  icon={<Bell className="w-4 h-4" />}
                  accent={unreadCount > 0 ? 'rose' : 'emerald'}
                />
              </section>

              {/* Schedules Grid */}
              <section className="space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="font-display text-base font-bold text-[#10243A]">
                      Jadwal Pengawasan Aktif & Berikutnya
                    </h3>
                    <p className="text-xs text-[#718096]">
                      Status jadwal terbuka otomatis mengikuti waktu server WIB.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setTab('jadwal')}
                    className="text-xs font-semibold text-[#087F5B] hover:underline inline-flex items-center gap-1"
                  >
                    <span>Lihat Semua</span>
                    <ArrowRight className="w-3.5 h-3.5" />
                  </button>
                </div>

                {schedules.length === 0 ? (
                  <EmptyState
                    icon={<Calendar className="w-6 h-6" />}
                    title="Belum Ada Jadwal Pengawasan"
                    description="Panitia ujian belum menugaskan jadwal pengawasan kepada Anda. Periksa notifikasi atau hubungi panitia madrasah."
                  />
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {schedules.slice(0, 4).map((sch) => (
                      <div
                        key={sch.id}
                        className="bg-white border border-[#E5EAF0] rounded-xl p-5 shadow-card flex flex-col justify-between gap-4"
                      >
                        <div className="space-y-2.5">
                          <div className="flex items-center justify-between gap-2 flex-wrap">
                            <span className="inline-flex items-center gap-1.5 text-xs font-mono-tabular font-bold text-[#10243A] bg-[#F5F7FA] px-2.5 py-1 rounded-md border border-[#E5EAF0]">
                              <MapPin className="w-3.5 h-3.5 text-[#087F5B]" />
                              {sch.room_kode} · {sch.nama_sesi}
                            </span>
                            {scheduleStatusBadge(sch.computed_status)}
                          </div>

                          <div>
                            <h4 className="font-display text-base font-bold text-[#10243A]">
                              {sch.subject_nama}
                            </h4>
                            <p className="text-xs text-[#718096] mt-0.5">{sch.room_nama}</p>
                          </div>

                          <div className="grid grid-cols-2 gap-2 pt-1 text-xs">
                            <div className="p-2.5 rounded-lg bg-[#F5F7FA] border border-[#E5EAF0]">
                              <p className="text-[11px] text-[#718096]">Waktu Ujian (WIB)</p>
                              <p className="font-mono-tabular font-semibold text-[#172B4D] mt-0.5">
                                {sch.tanggal} · {sch.jam_mulai}-{sch.jam_selesai}
                              </p>
                            </div>
                            <div className="p-2.5 rounded-lg bg-[#F5F7FA] border border-[#E5EAF0]">
                              <p className="text-[11px] text-[#718096]">Status Berkas</p>
                              <div className="mt-0.5">{reportStatusBadge(sch.report_status)}</div>
                            </div>
                          </div>

                          <p className="text-xs text-[#718096] flex items-center gap-1.5">
                            <Users className="w-3.5 h-3.5 shrink-0 text-[#718096]" />
                            <span className="truncate">
                              Peran <span className="font-semibold text-[#172B4D] capitalize">{sch.peran}</span> ·
                              Rekan: {sch.co_supervisors.map((c) => c.nama_lengkap).join(', ') || '-'}
                            </span>
                          </p>
                        </div>

                        {sch.computed_status === 'aktif' ? (
                          <button
                            type="button"
                            onClick={() => setActiveRoomScheduleId(sch.id)}
                            className="w-full py-2.5 px-4 rounded-xl bg-[#087F5B] hover:bg-[#06694b] text-white text-sm font-semibold inline-flex items-center justify-center gap-2 min-h-[44px] transition-colors"
                          >
                            <Play className="w-4 h-4 fill-current" />
                            MULAI PENGAWASAN
                          </button>
                        ) : sch.computed_status === 'selesai' ? (
                          <button
                            type="button"
                            onClick={() => setActiveRoomScheduleId(sch.id)}
                            className="w-full py-2.5 px-4 rounded-xl border border-[#E5EAF0] bg-[#F5F7FA] hover:bg-slate-200/70 text-[#172B4D] text-sm font-semibold inline-flex items-center justify-center gap-2 min-h-[44px] transition-colors"
                          >
                            <ClipboardCheck className="w-4 h-4 text-[#087F5B]" />
                            Buka Berkas & Berita Acara
                          </button>
                        ) : (
                          <div className="py-2.5 px-3 rounded-xl bg-[#F5F7FA] border border-[#E5EAF0] text-xs text-[#718096] text-center min-h-[44px] flex items-center justify-center gap-1.5">
                            <Clock className="w-3.5 h-3.5 text-[#C9A45C]" />
                            <span>
                              {sch.computed_status === 'dibatalkan'
                                ? 'Jadwal dibatalkan Panitia'
                                : `Otomatis aktif pukul ${sch.jam_mulai} WIB`}
                            </span>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </section>

              {/* Lower Dashboard Row: Status Berkas & Notifikasi Penting */}
              <section className="grid grid-cols-1 lg:grid-cols-2 gap-5">
                {/* Status Pengumpulan Berkas & Riwayat Singkat */}
                <div className="bg-white border border-[#E5EAF0] rounded-xl overflow-hidden shadow-card flex flex-col">
                  <div className="p-4 sm:p-5 border-b border-[#E5EAF0] flex items-center justify-between gap-2">
                    <div>
                      <h3 className="font-display text-sm font-bold text-[#10243A]">
                        Status Pengumpulan Berkas
                      </h3>
                      <p className="text-xs text-[#718096]">
                        {verifiedReportsCount} terverifikasi · {pendingReportsCount} perlu tindak lanjut
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setTab('riwayat')}
                      className="text-xs font-semibold text-[#087F5B] hover:underline"
                    >
                      Detail
                    </button>
                  </div>
                  {schedules.length === 0 ? (
                    <div className="p-6 text-xs text-[#718096]">Belum ada data pengumpulan berkas.</div>
                  ) : (
                    <div className="divide-y divide-[#E5EAF0]">
                      {schedules.slice(0, 4).map((sch) => (
                        <div key={sch.id} className="p-4 flex items-center justify-between gap-3">
                          <div className="min-w-0">
                            <p className="text-sm font-semibold text-[#172B4D] truncate">
                              {sch.room_kode} · {sch.subject_nama}
                            </p>
                            <p className="text-xs text-[#718096] font-mono-tabular mt-0.5">
                              {sch.tanggal} · {sch.jam_mulai}-{sch.jam_selesai} WIB
                            </p>
                          </div>
                          {reportStatusBadge(sch.report_status)}
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Notifikasi Penting */}
                <div className="bg-white border border-[#E5EAF0] rounded-xl overflow-hidden shadow-card flex flex-col">
                  <div className="p-4 sm:p-5 border-b border-[#E5EAF0] flex items-center justify-between gap-2">
                    <div>
                      <h3 className="font-display text-sm font-bold text-[#10243A]">
                        Notifikasi Penting
                      </h3>
                      <p className="text-xs text-[#718096]">
                        Arahan panitia & pembaruan verifikasi berkas
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setTab('notifikasi')}
                      className="text-xs font-semibold text-[#087F5B] hover:underline"
                    >
                      Semua ({notifications.length})
                    </button>
                  </div>
                  {notifications.length === 0 ? (
                    <div className="p-6 text-xs text-[#718096]">Belum ada notifikasi masuk.</div>
                  ) : (
                    <div className="divide-y divide-[#E5EAF0]">
                      {notifications.slice(0, 4).map((n) => (
                        <div
                          key={n.id}
                          className={`p-4 flex items-start justify-between gap-3 ${
                            n.dibaca === 0 ? 'bg-[#E8F5EF]/50' : ''
                          }`}
                        >
                          <div className="min-w-0 space-y-0.5">
                            <p className="text-sm font-semibold text-[#172B4D] truncate">{n.judul}</p>
                            <p className="text-xs text-[#718096] line-clamp-2">{n.isi}</p>
                            <p className="text-[11px] font-mono-tabular text-[#718096] pt-0.5">
                              {n.dibuat_pada}
                            </p>
                          </div>
                          {n.dibaca === 0 && (
                            <button
                              type="button"
                              onClick={() => handleMarkRead(n.id)}
                              className="text-xs font-semibold text-[#087F5B] hover:underline shrink-0"
                            >
                              Tandai Baca
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </section>
            </>
          ) : tab === 'jadwal' ? (
            <div className="bg-white border border-[#E5EAF0] rounded-xl overflow-hidden shadow-card">
              <div className="p-5 border-b border-[#E5EAF0]">
                <h2 className="font-display text-base font-bold text-[#10243A]">
                  Seluruh Jadwal Pengawasan (Waktu Server WIB)
                </h2>
                <p className="text-xs text-[#718096] mt-0.5">
                  Status jadwal berubah otomatis menjadi Aktif pada jam mulai server WIB (FR-JDW-03).
                </p>
              </div>
              {schedules.length === 0 ? (
                <EmptyState
                  icon={<Calendar className="w-6 h-6" />}
                  title="Belum Ada Jadwal"
                  description="Anda belum memiliki penugasan ruang ujian."
                />
              ) : (
                <div className="divide-y divide-[#E5EAF0]">
                  {schedules.map((sch) => (
                    <div
                      key={sch.id}
                      className="p-4 sm:p-5 flex flex-wrap items-center justify-between gap-4 hover:bg-[#F5F7FA]/60 transition-colors"
                    >
                      <div className="space-y-1 min-w-0">
                        <div className="text-xs text-[#718096] font-mono-tabular">
                          {sch.tanggal} · {sch.jam_mulai}-{sch.jam_selesai} WIB · {sch.nama_sesi} ·{' '}
                          <span className="font-semibold text-[#10243A]">{sch.room_kode}</span>
                        </div>
                        <p className="text-sm font-bold text-[#172B4D]">
                          {sch.subject_nama} — {sch.room_nama}
                        </p>
                        <p className="text-xs text-[#718096]">
                          Peran: <span className="font-semibold text-[#172B4D] capitalize">{sch.peran}</span> ·
                          Pengawas ruang: {sch.co_supervisors.map((c) => c.nama_lengkap).join(', ') || '-'}
                        </p>
                      </div>
                      <div className="flex items-center gap-3 shrink-0">
                        {scheduleStatusBadge(sch.computed_status)}
                        <button
                          type="button"
                          disabled={sch.computed_status === 'akan_datang' || sch.computed_status === 'dibatalkan'}
                          onClick={() => setActiveRoomScheduleId(sch.id)}
                          className="px-4 py-2 rounded-lg bg-[#087F5B] hover:bg-[#06694b] text-white text-xs font-semibold min-h-[42px] disabled:bg-slate-200 disabled:text-[#718096] transition-colors"
                        >
                          {sch.computed_status === 'aktif'
                            ? 'MULAI PENGAWASAN'
                            : sch.computed_status === 'selesai'
                            ? 'Lihat / Lengkapi Berkas'
                            : 'Belum Aktif'}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : tab === 'riwayat' ? (
            <div className="bg-white border border-[#E5EAF0] rounded-xl overflow-hidden shadow-card">
              <div className="p-5 border-b border-[#E5EAF0]">
                <h2 className="font-display text-base font-bold text-[#10243A]">
                  Riwayat Pengawasan & Status Pelaporan
                </h2>
                <p className="text-xs text-[#718096] mt-0.5">
                  Pantau verifikasi Berita Acara dan Daftar Hadir yang telah Anda kirimkan ke Panitia.
                </p>
              </div>
              {schedules.length === 0 ? (
                <EmptyState
                  icon={<FileCheck2 className="w-6 h-6" />}
                  title="Belum Ada Riwayat Pengawasan"
                  description="Setelah sesi ujian berlangsung, status Berita Acara dan Daftar Hadir akan tampil di sini."
                />
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse text-xs sm:text-sm">
                    <thead>
                      <tr className="bg-[#F5F7FA] border-b border-[#E5EAF0] text-xs text-[#718096]">
                        <th className="py-3 px-4 font-semibold">Ruang & Mapel</th>
                        <th className="py-3 px-4 font-semibold">Jadwal (WIB)</th>
                        <th className="py-3 px-4 font-semibold">Status Sesi</th>
                        <th className="py-3 px-4 font-semibold">Status Berkas</th>
                        <th className="py-3 px-4 font-semibold text-right">Aksi</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#E5EAF0]">
                      {schedules.map((sch) => (
                        <tr key={sch.id} className="hover:bg-[#F5F7FA]/60">
                          <td className="py-3.5 px-4 font-semibold text-[#172B4D]">
                            {sch.room_kode} · {sch.subject_nama}
                          </td>
                          <td className="py-3.5 px-4 font-mono-tabular text-xs text-[#718096]">
                            {sch.tanggal} · {sch.jam_mulai}-{sch.jam_selesai}
                          </td>
                          <td className="py-3.5 px-4">{scheduleStatusBadge(sch.computed_status)}</td>
                          <td className="py-3.5 px-4">{reportStatusBadge(sch.report_status)}</td>
                          <td className="py-3.5 px-4 text-right">
                            <button
                              type="button"
                              disabled={sch.computed_status === 'akan_datang'}
                              onClick={() => setActiveRoomScheduleId(sch.id)}
                              className="px-3.5 py-2 rounded-lg border border-[#E5EAF0] bg-white hover:bg-[#F5F7FA] text-xs font-semibold text-[#172B4D] min-h-[38px] disabled:opacity-40"
                            >
                              Buka Ruang & Berkas
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          ) : tab === 'notifikasi' ? (
            <div className="bg-white border border-[#E5EAF0] rounded-xl overflow-hidden shadow-card">
              <div className="p-5 border-b border-[#E5EAF0] flex items-center justify-between">
                <div>
                  <h2 className="font-display text-base font-bold text-[#10243A]">Notifikasi Internal</h2>
                  <p className="text-xs text-[#718096] mt-0.5">
                    Pemberitahuan penugasan baru dan hasil verifikasi laporan oleh Admin.
                  </p>
                </div>
                {unreadCount > 0 && (
                  <StatusBadge tone="emerald">{unreadCount} Belum Dibaca</StatusBadge>
                )}
              </div>
              {notifications.length === 0 ? (
                <EmptyState
                  icon={<Inbox className="w-6 h-6" />}
                  title="Tidak Ada Notifikasi"
                  description="Semua pembaruan jadwal maupun verifikasi laporan akan muncul di halaman ini."
                />
              ) : (
                <div className="divide-y divide-[#E5EAF0]">
                  {notifications.map((n) => (
                    <div
                      key={n.id}
                      className={`p-4 sm:p-5 flex items-start justify-between gap-4 ${
                        n.dibaca === 0 ? 'bg-[#E8F5EF]/45' : ''
                      }`}
                    >
                      <div className="space-y-1">
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-bold text-[#172B4D]">{n.judul}</p>
                          {n.dibaca === 0 && <StatusBadge tone="emerald">Baru</StatusBadge>}
                        </div>
                        <p className="text-sm text-[#172B4D]/85">{n.isi}</p>
                        <p className="text-xs text-[#718096] font-mono-tabular">{n.dibuat_pada}</p>
                      </div>
                      {n.dibaca === 0 && (
                        <button
                          type="button"
                          onClick={() => handleMarkRead(n.id)}
                          className="text-xs font-semibold text-[#087F5B] hover:underline shrink-0 min-h-[36px]"
                        >
                          Tandai dibaca
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : (
            /* PROFIL (FR-PRF) */
            <form
              onSubmit={handleSaveProfile}
              className="bg-white border border-[#E5EAF0] rounded-xl p-6 space-y-5 max-w-2xl shadow-card"
            >
              <div className="border-b border-[#E5EAF0] pb-4 flex items-center gap-4">
                {profFoto ? (
                  <img
                    src={profFoto}
                    alt={user.namaLengkap}
                    className="w-14 h-14 rounded-xl object-cover border border-[#E5EAF0] shrink-0"
                  />
                ) : (
                  <div className="w-14 h-14 rounded-xl bg-[#10243A] text-white flex items-center justify-center text-base font-bold shrink-0">
                    {user.namaLengkap.slice(0, 2).toUpperCase()}
                  </div>
                )}
                <div>
                  <h2 className="font-display text-base font-bold text-[#10243A]">
                    Profil & Tanda Tangan Pengawas
                  </h2>
                  <p className="text-xs text-[#718096] mt-0.5 leading-relaxed">
                    Nama lengkap dan NIP/NUPTK berasal dari impor Admin sehingga tidak dapat diubah sendiri (FR-PRF-02). Perubahan foto dan tanda tangan tercatat di audit log.
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-[#718096] mb-1.5">
                    Nama Lengkap (Data Admin)
                  </label>
                  <input
                    type="text"
                    disabled
                    value={String(profileData.nama_lengkap || user.namaLengkap)}
                    className="w-full px-3.5 py-2.5 rounded-xl border border-[#E5EAF0] bg-[#F5F7FA] text-sm text-[#718096] min-h-[44px]"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-[#718096] mb-1.5">
                    NIP / NUPTK (Data Admin)
                  </label>
                  <input
                    type="text"
                    disabled
                    value={String(profileData.nip_nuptk || user.nipNuptk || '-')}
                    className="w-full px-3.5 py-2.5 rounded-xl border border-[#E5EAF0] bg-[#F5F7FA] text-sm font-mono-tabular text-[#718096] min-h-[44px]"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-[#172B4D] mb-1.5">No. WhatsApp</label>
                  <input
                    type="tel"
                    value={profWhatsapp}
                    onChange={(e) => setProfWhatsapp(e.target.value)}
                    className="w-full px-3.5 py-2.5 rounded-xl border border-[#E5EAF0] text-sm min-h-[44px]"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-[#172B4D] mb-1.5">Tempat Lahir</label>
                  <input
                    type="text"
                    value={profTempat}
                    onChange={(e) => setProfTempat(e.target.value)}
                    className="w-full px-3.5 py-2.5 rounded-xl border border-[#E5EAF0] text-sm min-h-[44px]"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-[#172B4D] mb-1.5">Tanggal Lahir</label>
                  <input
                    type="date"
                    value={profTgl}
                    onChange={(e) => setProfTgl(e.target.value)}
                    className="w-full px-3.5 py-2.5 rounded-xl border border-[#E5EAF0] text-sm min-h-[44px]"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-[#172B4D] mb-1.5">Alamat Domisili</label>
                <input
                  type="text"
                  value={profAlamat}
                  onChange={(e) => setProfAlamat(e.target.value)}
                  className="w-full px-3.5 py-2.5 rounded-xl border border-[#E5EAF0] text-sm min-h-[44px]"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-[#172B4D] mb-1.5">
                  Perbarui Foto Profil
                </label>
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (!f) return;
                    const r = new FileReader();
                    r.onload = () => typeof r.result === 'string' && setProfFoto(r.result);
                    r.readAsDataURL(f);
                  }}
                  className="block w-full text-sm text-[#718096] file:mr-3 file:py-2 file:px-3.5 file:rounded-lg file:border file:border-[#E5EAF0] file:text-xs file:font-semibold file:bg-[#F5F7FA] file:text-[#172B4D]"
                />
              </div>

              <SignaturePad value={profTtd} onChange={setProfTtd} label="Tanda Tangan Digital" />

              <button
                type="submit"
                disabled={profSaving}
                className="px-5 py-2.5 rounded-xl bg-[#087F5B] hover:bg-[#06694b] text-white text-sm font-semibold min-h-[46px] inline-flex items-center gap-2 transition-colors disabled:opacity-60"
              >
                <CheckCircle2 className="w-4 h-4" />
                <span>{profSaving ? 'Menyimpan...' : 'Simpan Perubahan Profil'}</span>
              </button>
            </form>
          )}
        </main>
      </div>

      {/* Mobile Bottom Tab Bar (<=15% viewport height, >=44px targets) */}
      <nav className="lg:hidden fixed bottom-0 left-0 right-0 z-30 bg-white/95 backdrop-blur-md border-t border-[#E5EAF0] grid grid-cols-5 h-16">
        {(
          [
            ['dashboard', 'Beranda', Home],
            ['jadwal', 'Jadwal', Calendar],
            ['riwayat', 'Berkas', FileCheck2],
            ['notifikasi', 'Info', Bell],
            ['profil', 'Profil', User],
          ] as const
        ).map(([key, label, Icon]) => {
          const active = tab === key;
          return (
            <button
              key={key}
              type="button"
              onClick={() => setTab(key)}
              className={`relative flex flex-col items-center justify-center min-h-[44px] text-[11px] font-semibold ${
                active ? 'text-[#087F5B]' : 'text-[#718096]'
              }`}
            >
              <Icon className="w-5 h-5" />
              <span className="mt-0.5">{label}</span>
              {key === 'notifikasi' && unreadCount > 0 && (
                <span className="absolute top-1.5 right-3 w-2 h-2 rounded-full bg-[#087F5B]" />
              )}
            </button>
          );
        })}
      </nav>

      <ToastNotification
        message={toast?.message || null}
        type={toast?.type || 'success'}
        onDismiss={() => setToast(null)}
      />
    </div>
  );
};
