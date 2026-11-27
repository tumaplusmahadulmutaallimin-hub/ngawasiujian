import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Clock,
  FileText,
  LogOut,
  Minus,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Send,
  ShieldAlert,
  Upload,
  Users,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react';
import { apiFetch } from '../lib/api.ts';
import type { DocDataset } from '../lib/pdfGenerator.ts';
import type {
  AuthUser,
  IncidentReportRecord,
  PendingSyncAction,
  RoomRecord,
  SeatWithState,
  SupervisionReportRecord,
  SupervisionScheduleItem,
} from '../types.ts';
import { useServerWibClock } from './BrandMark.tsx';
import { DocumentViewerModal } from './DocumentViewerModal.tsx';
import { SignaturePad } from './SignaturePad.tsx';
import {
  EmptyState,
  SkeletonBlock,
  StatusBadge,
  ToastNotification,
  reportStatusBadge,
  scheduleStatusBadge,
} from './ui/Primitives.tsx';

interface SupervisionRoomPayload {
  serverTime: { date: string; time: string; isoWib: string; timestampMs: number };
  schedule: SupervisionScheduleItem;
  room: RoomRecord;
  seats: SeatWithState[];
  incidents: IncidentReportRecord[];
  activePeers?: Array<{ userId: number; nama: string; role: string }>;
  reports: SupervisionReportRecord[];
}

interface SupervisionRoomProps {
  scheduleId: number;
  currentUser: AuthUser;
  readOnlyMonitor?: boolean;
  onBack: () => void;
}

const EXIT_REASON_PRESETS = ['Kamar Kecil / Toilet', 'UKP / Kesehatan', 'Keperluan Panitia'];

function formatCountdown(totalSec: number): string {
  const hrs = Math.floor(totalSec / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function formatDuration(sec: number | null): string {
  if (sec === null || sec === undefined) return '-';
  const mins = Math.floor(sec / 60);
  const rem = sec % 60;
  return mins > 0 ? `${mins}m ${rem}d` : `${rem}d`;
}

export const SupervisionRoom: React.FC<SupervisionRoomProps> = ({
  scheduleId,
  currentUser,
  readOnlyMonitor = false,
  onBack,
}) => {
  const wibClock = useServerWibClock();
  const [data, setData] = useState<SupervisionRoomPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'error' | 'info' } | null>(null);

  const [activeTab, setActiveTab] = useState<'denah' | 'dokumen' | 'kejadian' | 'berkas'>('denah');
  const [selectedSeatId, setSelectedSeatId] = useState<number | null>(null);
  const [seatSearch, setSeatSearch] = useState('');

  // Zoom & Pan state (FR-MGU-B-04)
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ dragging: boolean; startX: number; startY: number; origX: number; origY: number }>({
    dragging: false,
    startX: 0,
    startY: 0,
    origX: 0,
    origY: 0,
  });

  // Serverless Polling & Pending Sync Queue (BR-11)
  const [syncConnected, setSyncConnected] = useState(false);
  const [activePeers, setActivePeers] = useState<Array<{ userId: number; nama: string; role: string }>>([]);
  const [pendingQueue, setPendingQueue] = useState<PendingSyncAction[]>([]);
  const [isOnline, setIsOnline] = useState(() => (typeof navigator !== 'undefined' ? navigator.onLine : true));

  // Action forms inside Seat Drawer
  const [warningLevel, setWarningLevel] = useState<1 | 2 | 3>(1);
  const [warningReason, setWarningReason] = useState('');
  const [correctingWarningId, setCorrectingWarningId] = useState<number | null>(null);
  const [exitReason, setExitReason] = useState(EXIT_REASON_PRESETS[0]);
  const [customExitReason, setCustomExitReason] = useState('');

  // Incident & Reports forms
  const [incidentDesc, setIncidentDesc] = useState('');
  const [baKondisi, setBaKondisi] = useState('Lancar dan Tertib');
  const [baCatatan, setBaCatatan] = useState('');
  const [baSignature, setBaSignature] = useState<string | null>(currentUser.ttdUrl || null);
  const [dhFile, setDhFile] = useState<File | null>(null);
  const [dhCatatan, setDhCatatan] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [blobNotice, setBlobNotice] = useState<string | null>(null);

  // Room document preview modal
  const [previewDoc, setPreviewDoc] = useState<{ key: string; title: string } | null>(null);

  const loadRoom = useCallback(async () => {
    try {
      const payload = await apiFetch<SupervisionRoomPayload>(`/api/supervision/${scheduleId}`);
      setData(payload);
      if (Array.isArray(payload.activePeers)) {
        setActivePeers(payload.activePeers);
      }
      setSyncConnected(true);
      setErrorMsg(null);
    } catch (err) {
      setSyncConnected(false);
      setErrorMsg(err instanceof Error ? err.message : 'Gagal memuat ruang pengawasan.');
    } finally {
      setLoading(false);
    }
  }, [scheduleId]);

  useEffect(() => {
    loadRoom();
  }, [loadRoom]);

  useEffect(() => {
    const onOnline = () => setIsOnline(true);
    const onOffline = () => setIsOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  const flushPendingQueue = useCallback(async () => {
    if (pendingQueue.length === 0 || !isOnline) return;
    const nextRemaining: PendingSyncAction[] = [];
    for (const item of pendingQueue) {
      try {
        await apiFetch(item.endpoint, {
          method: item.method,
          body: JSON.stringify(item.body),
        });
      } catch (err) {
        if (err instanceof Error && (err.message.includes('Failed to fetch') || err.message.includes('Network'))) {
          nextRemaining.push(item);
        } else {
          setToast({
            msg: `Sinkronisasi tertunda (${item.label}): ${err instanceof Error ? err.message : 'Ditolak server'}`,
            type: 'error',
          });
        }
      }
    }
    setPendingQueue(nextRemaining);
    if (nextRemaining.length < pendingQueue.length) {
      await loadRoom();
      setToast({ msg: 'Antrean sinkronisasi berhasil dikonfirmasi server.', type: 'success' });
    }
  }, [pendingQueue, isOnline, loadRoom]);

  useEffect(() => {
    if (isOnline && pendingQueue.length > 0) {
      flushPendingQueue();
    }
  }, [isOnline, pendingQueue.length, flushPendingQueue]);

  // Visibility-aware collaborative polling (replaces persistent local WebSocket for Vercel serverless)
  useEffect(() => {
    const poll = () => {
      if (typeof document !== 'undefined' && document.hidden) return;
      if (typeof navigator !== 'undefined' && !navigator.onLine) return;
      loadRoom();
    };
    const intervalId = setInterval(poll, 3500);
    const onVisibilityOrFocus = () => {
      if (typeof document === 'undefined' || !document.hidden) {
        loadRoom();
      }
    };
    window.addEventListener('focus', onVisibilityOrFocus);
    document.addEventListener('visibilitychange', onVisibilityOrFocus);
    return () => {
      clearInterval(intervalId);
      window.removeEventListener('focus', onVisibilityOrFocus);
      document.removeEventListener('visibilitychange', onVisibilityOrFocus);
    };
  }, [loadRoom]);

  useEffect(() => {
    apiFetch<{ blobConfigured?: boolean; blobNotice?: string | null }>('/api/health')
      .then((res) => {
        setBlobNotice(res.blobConfigured === false ? res.blobNotice || null : null);
      })
      .catch(() => undefined);
  }, []);

  const remainingSeconds = useMemo(() => {
    if (!data) return 0;
    const endMs = Date.parse(`${data.schedule.tanggal}T${data.schedule.jam_selesai}:00+07:00`);
    if (Number.isNaN(endMs)) return 0;
    return Math.max(0, Math.floor((endMs - wibClock.timestampMs) / 1000));
  }, [data, wibClock.timestampMs]);

  const selectedSeat = useMemo(
    () => data?.seats.find((s) => s.id === selectedSeatId) || null,
    [data, selectedSeatId]
  );

  const enqueueOrSend = async (action: Omit<PendingSyncAction, 'id' | 'createdAt'>) => {
    setErrorMsg(null);
    if (!isOnline) {
      setPendingQueue((prev) => [
        ...prev,
        {
          ...action,
          id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          createdAt: wibClock.isoWib,
        },
      ]);
      setToast({
        msg: 'Koneksi terputus. Tindakan masuk antrean "Menunggu Sinkronisasi" (belum tersimpan di server).',
        type: 'info',
      });
      return;
    }

    try {
      await apiFetch(action.endpoint, {
        method: action.method,
        body: JSON.stringify(action.body),
      });
      await loadRoom();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Gagal menyimpan ke server.';
      if (err instanceof TypeError || msg.includes('Failed to fetch') || msg.includes('NetworkError')) {
        setPendingQueue((prev) => [
          ...prev,
          {
            ...action,
            id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            createdAt: wibClock.isoWib,
          },
        ]);
        setToast({
          msg: 'Koneksi terputus saat mengirim. Tindakan ditandai "Menunggu Sinkronisasi" (BR-11).',
          type: 'info',
        });
      } else {
        setErrorMsg(msg);
        await loadRoom();
      }
    }
  };

  const handleSupervisorCheckIn = async () => {
    try {
      await apiFetch(`/api/supervision/${scheduleId}/check-in`, { method: 'POST' });
      setToast({ msg: 'Kehadiran pengawas berhasil dicatat sesuai waktu server WIB.', type: 'success' });
      await loadRoom();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Gagal mencatat hadir pengawas.');
    }
  };

  const handleAttendance = async (seat: SeatWithState, status: 'hadir' | 'tidak_hadir') => {
    if (!seat.student || readOnlyMonitor) return;
    await enqueueOrSend({
      scheduleId,
      endpoint: `/api/supervision/${scheduleId}/attendance`,
      method: 'POST',
      label: `Kehadiran ${seat.student.nama}`,
      body: {
        studentId: seat.student.id,
        status,
        expectedVersion: seat.attendance.updated_version,
      },
    });
  };

  const handleSaveWarning = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedSeat?.student || !warningReason.trim() || readOnlyMonitor) return;
    const key = `warn_${scheduleId}_${selectedSeat.student.id}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    await enqueueOrSend({
      scheduleId,
      endpoint: `/api/supervision/${scheduleId}/warnings`,
      method: 'POST',
      label: `Peringatan ${warningLevel} — ${selectedSeat.student.nama}`,
      body: {
        studentId: selectedSeat.student.id,
        tingkat: warningLevel,
        alasan: warningReason.trim(),
        isCorrection: Boolean(correctingWarningId),
        correctsWarningId: correctingWarningId,
        idempotencyKey: key,
      },
    });
    setWarningReason('');
    setCorrectingWarningId(null);
    setToast({ msg: `Peringatan ${warningLevel} tersimpan.`, type: 'success' });
  };

  const handleExitAction = async (action: 'keluar' | 'kembali') => {
    if (!selectedSeat?.student || readOnlyMonitor) return;
    const finalReason = exitReason === 'Lainnya' ? customExitReason.trim() : exitReason;
    if (action === 'keluar' && !finalReason) {
      setErrorMsg('Alasan izin keluar wajib diisi.');
      return;
    }
    const key = `exit_${action}_${scheduleId}_${selectedSeat.student.id}_${Date.now()}`;
    await enqueueOrSend({
      scheduleId,
      endpoint: `/api/supervision/${scheduleId}/exits`,
      method: 'POST',
      label: `Izin ${action} — ${selectedSeat.student.nama}`,
      body: {
        action,
        studentId: selectedSeat.student.id,
        alasan: finalReason,
        exitId: selectedSeat.activeExit?.id,
        idempotencyKey: key,
      },
    });
    setCustomExitReason('');
    setToast({
      msg: action === 'keluar' ? 'Izin keluar dicatat.' : 'Peserta tercatat kembali ke ruangan.',
      type: 'success',
    });
  };

  const handleAddIncident = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!incidentDesc.trim() || readOnlyMonitor) return;
    setSubmitting(true);
    try {
      await apiFetch(`/api/supervision/${scheduleId}/incidents`, {
        method: 'POST',
        body: JSON.stringify({ deskripsi: incidentDesc.trim() }),
      });
      setIncidentDesc('');
      await loadRoom();
      setToast({ msg: 'Catatan kejadian khusus tersimpan.', type: 'success' });
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Gagal menyimpan kejadian.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleSubmitBeritaAcara = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    setSubmitting(true);
    try {
      await apiFetch(`/api/supervision/${scheduleId}/reports/berita-acara`, {
        method: 'POST',
        body: JSON.stringify({
          kondisi_pelaksanaan: baKondisi,
          catatan_tambahan: baCatatan,
          ttd_url: baSignature,
        }),
      });
      await loadRoom();
      setToast({ msg: 'Berita Acara berhasil dikirim untuk verifikasi Panitia.', type: 'success' });
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Gagal mengirim Berita Acara.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleUploadDaftarHadir = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!dhFile) {
      setErrorMsg('Pilih file foto atau hasil scan Daftar Hadir bertanda tangan.');
      return;
    }
    setErrorMsg(null);
    setSubmitting(true);
    try {
      const form = new FormData();
      form.append('file', dhFile);
      form.append('catatan', dhCatatan);
      await apiFetch(`/api/supervision/${scheduleId}/reports/daftar-hadir`, {
        method: 'POST',
        body: form,
      });
      setDhFile(null);
      setDhCatatan('');
      await loadRoom();
      setToast({ msg: 'Daftar Hadir berhasil diunggah untuk verifikasi Panitia.', type: 'success' });
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Gagal mengunggah Daftar Hadir.');
    } finally {
      setSubmitting(false);
    }
  };

  const roomDataset: DocDataset | null = useMemo(() => {
    if (!data) return null;
    return {
      serverTime: wibClock,
      exam: {
        id: data.schedule.exam_id,
        nama: data.schedule.exam_nama,
        madrasah_nama: data.schedule.madrasah_nama,
        tahun_ajaran: data.schedule.tahun_ajaran,
        tanggal_mulai: data.schedule.tanggal,
        tanggal_selesai: data.schedule.tanggal,
      },
      rooms: [
        {
          id: data.room.id,
          kode: data.room.kode,
          nama: data.room.nama,
          kapasitas: data.room.kapasitas,
          rows_count: data.room.rows_count,
          cols_count: data.room.cols_count,
          seats: data.seats.map((s) => ({
            kode_kursi: s.kode_kursi,
            baris: s.baris,
            kolom: s.kolom,
            nomor_peserta: s.student?.nomor_peserta,
            nisn: s.student?.nisn || undefined,
            student_nama: s.student?.nama,
            kelas: s.student?.kelas,
          })),
        },
      ],
      supervisors: data.schedule.co_supervisors.map((c) => ({
        id: c.supervisor_id,
        nama_lengkap: c.nama_lengkap,
        nip_nuptk: c.nip_nuptk,
        whatsapp: null,
      })),
      schedules: [data.schedule],
      incidents: data.incidents,
      warnings: data.seats.flatMap((s) =>
        s.warnings.map((w) => ({
          id: w.id,
          student_nama: s.student?.nama || '-',
          nomor_peserta: s.student?.nomor_peserta || '-',
          tingkat: w.tingkat,
          alasan: w.alasan,
          waktu_server: w.waktu_server,
          dicatat_oleh_nama: w.dicatat_oleh_nama,
        }))
      ),
    };
  }, [data, wibClock]);

  if (loading) {
    return (
      <div className="min-h-screen bg-[#F5F7FA] p-6 max-w-7xl mx-auto space-y-5">
        <SkeletonBlock rows={2} />
        <SkeletonBlock rows={6} />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="min-h-screen bg-[#F5F7FA] p-6 flex items-center justify-center">
        <EmptyState
          icon={<ShieldAlert className="w-6 h-6" />}
          title="Ruang Pengawasan Tidak Dapat Dibuka"
          description={errorMsg || 'Pastikan Anda ditugaskan pada sesi dan ruang ujian ini.'}
          action={
            <button
              type="button"
              onClick={onBack}
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-[#10243A] text-white text-sm font-semibold min-h-[44px]"
            >
              <ArrowLeft className="w-4 h-4" />
              Kembali ke Daftar Jadwal
            </button>
          }
        />
      </div>
    );
  }

  const { schedule, room, seats, incidents, reports } = data;
  const isNearEnd =
    schedule.computed_status === 'aktif' &&
    remainingSeconds > 0 &&
    remainingSeconds <= (schedule.warning_minutes_before_end || 15) * 60;

  const seatedStudents = seats.filter((s) => s.student !== null);
  const hadirCount = seatedStudents.filter((s) => s.attendance.status === 'hadir').length;
  const tidakHadirCount = seatedStudents.filter((s) => s.attendance.status === 'tidak_hadir').length;
  const belumCount = seatedStudents.filter((s) => s.attendance.status === 'belum').length;

  const baReport = reports.find((r) => r.jenis === 'berita_acara');
  const dhReport = reports.find((r) => r.jenis === 'daftar_hadir');

  const queryNorm = seatSearch.trim().toLowerCase();

  return (
    <div className="min-h-screen bg-[#F5F7FA] flex flex-col pb-20 lg:pb-8">
      {/* Deep Navy Top Console Header */}
      <header className="sticky top-0 z-30 bg-[#10243A] text-white border-b border-white/10 px-4 sm:px-6 py-3.5 shadow-card">
        <div className="max-w-7xl mx-auto flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={onBack}
              className="p-2.5 rounded-xl bg-white/10 hover:bg-white/20 text-white min-h-[44px] min-w-[44px] flex items-center justify-center shrink-0 transition-colors"
              aria-label="Kembali ke daftar jadwal"
            >
              <ArrowLeft className="w-4 h-4" />
            </button>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2 text-xs text-slate-300">
                <span className="font-mono-tabular font-bold text-[#C9A45C]">{room.kode}</span>
                <span aria-hidden="true">·</span>
                <span className="truncate">{schedule.nama_sesi}</span>
                <span aria-hidden="true">·</span>
                {scheduleStatusBadge(schedule.computed_status)}
                {readOnlyMonitor && (
                  <span className="text-[11px] text-slate-300 font-medium">Mode Pantau Admin</span>
                )}
              </div>
              <h1 className="font-display text-base sm:text-lg font-bold text-white truncate mt-0.5">
                {room.nama} — {schedule.subject_nama}
              </h1>
            </div>
          </div>

          <div className="flex items-center gap-4 shrink-0">
            <div className="text-right">
              <div className="font-mono-tabular text-xs text-slate-300">
                {wibClock.time} WIB · {schedule.jam_mulai}-{schedule.jam_selesai}
              </div>
              <div
                className={`font-mono-tabular text-lg font-bold ${
                  isNearEnd ? 'text-[#C9A45C]' : 'text-emerald-300'
                }`}
              >
                {schedule.computed_status === 'aktif'
                  ? `Sisa ${formatCountdown(remainingSeconds)}`
                  : schedule.computed_status === 'selesai'
                  ? '00:00:00'
                  : 'Menunggu Mulai'}
              </div>
            </div>

            {!readOnlyMonitor && !schedule.supervisor_checked_in && schedule.computed_status === 'aktif' && (
              <button
                type="button"
                onClick={handleSupervisorCheckIn}
                className="px-4 py-2.5 rounded-xl bg-[#087F5B] hover:bg-[#06694B] text-white text-xs sm:text-sm font-semibold whitespace-nowrap min-h-[44px] transition-colors"
              >
                Catat Hadir Pengawas
              </button>
            )}
          </div>
        </div>
      </header>

      {/* Near-end 15 minute alert */}
      {isNearEnd && (
        <div className="bg-amber-50 border-b border-amber-200 px-4 py-2.5">
          <div className="max-w-7xl mx-auto flex items-center gap-2 text-xs sm:text-sm font-semibold text-amber-900">
            <Clock className="w-4 h-4 text-amber-700 shrink-0" />
            <span>
              Peringatan Waktu: Sisa waktu ujian kurang dari {schedule.warning_minutes_before_end} menit lagi.
            </span>
          </div>
        </div>
      )}

      {/* Offline / Pending Sync Queue Banner (BR-11) */}
      {(!isOnline || pendingQueue.length > 0) && (
        <div className="bg-amber-50 border-b border-amber-300 px-4 py-2.5">
          <div className="max-w-7xl mx-auto flex flex-wrap items-center justify-between gap-2 text-xs sm:text-sm text-amber-950">
            <div className="flex items-center gap-2">
              <WifiOff className="w-4 h-4 text-amber-700 shrink-0" />
              <span>
                {!isOnline
                  ? 'Koneksi terputus — Tindakan masuk antrean "Menunggu Sinkronisasi" dan belum tersimpan di server.'
                  : `${pendingQueue.length} tindakan menunggu sinkronisasi ke server.`}
              </span>
            </div>
            {isOnline && pendingQueue.length > 0 && (
              <button
                type="button"
                onClick={flushPendingQueue}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-700 text-white text-xs font-semibold min-h-[36px]"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                Sinkronkan Sekarang
              </button>
            )}
          </div>
        </div>
      )}

      <div className="max-w-7xl w-full mx-auto px-4 sm:px-6 pt-5 space-y-5">
        {/* Room Telemetry & Co-supervisors Bar */}
        <div className="bg-white border border-[#E5EAF0] rounded-xl px-4 py-3.5 shadow-card flex flex-wrap items-center justify-between gap-4 text-xs sm:text-sm">
          <div className="flex flex-wrap items-center gap-4">
            <span className="inline-flex items-center gap-1.5 font-medium text-[#172B4D]">
              {syncConnected && isOnline ? (
                <Wifi className="w-4 h-4 text-[#087F5B]" />
              ) : (
                <WifiOff className="w-4 h-4 text-[#718096]" />
              )}
              <span>
                {syncConnected && isOnline
                  ? 'Sinkronisasi Real-Time Aktif'
                  : isOnline
                  ? 'Menghubungkan...'
                  : 'Offline'}
              </span>
            </span>
            <span aria-hidden="true" className="text-[#E5EAF0]">|</span>
            <span className="inline-flex items-center gap-1.5 text-[#718096]">
              <Users className="w-4 h-4 text-[#10243A]" />
              <span>
                Pengawas:{' '}
                <strong className="text-[#172B4D] font-semibold">
                  {activePeers.length > 0
                    ? activePeers.map((p) => p.nama).join(', ')
                    : schedule.co_supervisors.map((c) => c.nama_lengkap).join(', ')}
                </strong>
              </span>
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-3 font-mono-tabular text-xs">
            <span className="text-[#087F5B] font-bold">Hadir: {hadirCount}</span>
            <span className="text-[#E5EAF0]">·</span>
            <span className="text-rose-700 font-bold">Tidak Hadir: {tidakHadirCount}</span>
            <span className="text-[#E5EAF0]">·</span>
            <span className="text-amber-700 font-bold">Belum Dicatat: {belumCount}</span>
          </div>
        </div>

        {errorMsg && (
          <div className="p-3.5 rounded-xl bg-rose-50 border border-rose-200 flex items-center justify-between gap-3 text-sm text-rose-800">
            <span>{errorMsg}</span>
            <button type="button" onClick={() => setErrorMsg(null)} className="p-1 text-rose-600">
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {/* Segmented Sub-navigation */}
        <div className="flex flex-wrap gap-1.5 p-1 bg-white border border-[#E5EAF0] rounded-xl w-fit shadow-card">
          {(
            [
              ['denah', 'Denah Peserta Interaktif'],
              ['dokumen', 'Administrasi Ruang'],
              ['kejadian', `Catatan Kejadian (${incidents.length})`],
              ['berkas', 'Upload Berkas & Penyelesaian'],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setActiveTab(key)}
              className={`px-4 py-2 rounded-lg text-xs sm:text-sm font-semibold whitespace-nowrap transition-colors min-h-[42px] ${
                activeTab === key
                  ? 'bg-[#10243A] text-white'
                  : 'text-[#718096] hover:text-[#172B4D] hover:bg-[#F5F7FA]'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {/* TAB 1: FLAGSHIP INTERACTIVE SEAT MAP */}
        {activeTab === 'denah' && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
            <div
              className={`${
                selectedSeat ? 'lg:col-span-7 xl:col-span-8' : 'lg:col-span-12'
              } bg-white border border-[#E5EAF0] rounded-2xl overflow-hidden shadow-card`}
            >
              {/* Seat Map Toolbar: Legend + Participant Search + Zoom Controls */}
              <div className="p-4 border-b border-[#E5EAF0] space-y-3 bg-white">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  {/* Search Peserta */}
                  <div className="relative flex-1 min-w-[220px] max-w-sm">
                    <Search className="w-4 h-4 text-[#718096] absolute left-3.5 top-1/2 -translate-y-1/2" />
                    <input
                      type="text"
                      value={seatSearch}
                      onChange={(e) => setSeatSearch(e.target.value)}
                      placeholder="Cari nama peserta, nomor ujian, atau kursi..."
                      className="w-full pl-10 pr-8 py-2 rounded-xl border border-[#E5EAF0] bg-[#F5F7FA] focus:bg-white text-xs sm:text-sm focus:outline-none focus:ring-2 focus:ring-[#087F5B] min-h-[42px]"
                    />
                    {seatSearch && (
                      <button
                        type="button"
                        onClick={() => setSeatSearch('')}
                        aria-label="Hapus pencarian"
                        className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[#718096] hover:text-[#172B4D]"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>

                  {/* Zoom Controls */}
                  <div className="flex items-center gap-1.5 bg-[#F5F7FA] p-1 rounded-xl border border-[#E5EAF0]">
                    <button
                      type="button"
                      onClick={() => setZoom((z) => Math.max(0.6, Number((z - 0.15).toFixed(2))))}
                      className="p-2 rounded-lg hover:bg-white text-[#172B4D] min-h-[38px] min-w-[38px] flex items-center justify-center transition-colors"
                      aria-label="Perkecil denah"
                    >
                      <Minus className="w-4 h-4" />
                    </button>
                    <span className="font-mono-tabular text-xs font-semibold w-12 text-center text-[#10243A]">
                      {Math.round(zoom * 100)}%
                    </span>
                    <button
                      type="button"
                      onClick={() => setZoom((z) => Math.min(1.8, Number((z + 0.15).toFixed(2))))}
                      className="p-2 rounded-lg hover:bg-white text-[#172B4D] min-h-[38px] min-w-[38px] flex items-center justify-center transition-colors"
                      aria-label="Perbesar denah"
                    >
                      <Plus className="w-4 h-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setZoom(1);
                        setPan({ x: 0, y: 0 });
                      }}
                      className="p-2 rounded-lg hover:bg-white text-[#172B4D] min-h-[38px] min-w-[38px] flex items-center justify-center transition-colors"
                      aria-label="Reset tampilan denah"
                    >
                      <RotateCcw className="w-4 h-4" />
                    </button>
                  </div>
                </div>

                {/* Status Legend (PRD 21.5) */}
                <div className="flex flex-wrap items-center gap-3 text-xs text-[#718096] pt-1 border-t border-[#E5EAF0]/70">
                  <span className="font-semibold text-[#172B4D]">Legenda Status:</span>
                  <span className="inline-flex items-center gap-1.5">
                    <span className="w-3.5 h-3.5 rounded border border-[#CBD5E1] bg-white inline-block" />
                    Normal
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <span className="w-3.5 h-3.5 rounded border border-[#087F5B] bg-[#E8F5EF] inline-block" />
                    Peringatan 1
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <span className="w-3.5 h-3.5 rounded border border-amber-500 bg-amber-100 inline-block" />
                    Peringatan 2
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <span className="w-3.5 h-3.5 rounded border border-rose-600 bg-rose-100 inline-block" />
                    Peringatan 3
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <span className="w-3.5 h-3.5 rounded border border-slate-500 bg-slate-200 inline-block" />
                    Izin Keluar
                  </span>
                </div>
              </div>

              {/* Realistic Classroom Pan & Zoom Floorplan */}
              <div
                className="p-5 sm:p-7 overflow-auto bg-[#F5F7FA] cursor-grab active:cursor-grabbing select-none min-h-[420px]"
                onPointerDown={(e) => {
                  if ((e.target as HTMLElement).closest('button')) return;
                  dragRef.current = {
                    dragging: true,
                    startX: e.clientX,
                    startY: e.clientY,
                    origX: pan.x,
                    origY: pan.y,
                  };
                }}
                onPointerMove={(e) => {
                  if (!dragRef.current.dragging) return;
                  setPan({
                    x: dragRef.current.origX + (e.clientX - dragRef.current.startX),
                    y: dragRef.current.origY + (e.clientY - dragRef.current.startY),
                  });
                }}
                onPointerUp={() => {
                  dragRef.current.dragging = false;
                }}
                onPointerCancel={() => {
                  dragRef.current.dragging = false;
                }}
              >
                <div
                  style={{
                    transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                    transformOrigin: 'top center',
                  }}
                  className="transition-transform duration-75 space-y-6"
                >
                  {/* Front of Room Architectural Bar */}
                  <div className="max-w-xl mx-auto flex items-center justify-between gap-3 px-5 py-2.5 rounded-xl bg-[#10243A] text-white text-xs font-semibold shadow-card">
                    <span className="text-slate-300">Pintu Masuk</span>
                    <span className="text-[#C9A45C] tracking-wider uppercase">
                      Papan Tulis & Meja Pengawas
                    </span>
                    <span className="text-slate-300 font-mono-tabular">{room.kode}</span>
                  </div>

                  {/* Realistic Desk Grid */}
                  <div
                    className="grid gap-3.5"
                    style={{
                      gridTemplateColumns: `repeat(${Math.max(1, room.cols_count || 4)}, minmax(136px, 1fr))`,
                    }}
                  >
                    {seats.map((seat) => {
                      const isSelected = seat.id === selectedSeatId;
                      const hasPendingSync = pendingQueue.some(
                        (q) => q.body.studentId === seat.student?.id
                      );

                      const matchesSearch =
                        !queryNorm ||
                        seat.kode_kursi.toLowerCase().includes(queryNorm) ||
                        (seat.student?.nama || '').toLowerCase().includes(queryNorm) ||
                        (seat.student?.nomor_peserta || '').toLowerCase().includes(queryNorm);

                      let cardTone =
                        'bg-white border-[#E5EAF0] text-[#172B4D] hover:border-[#087F5B]';
                      if (seat.activeExit) {
                        cardTone = 'bg-slate-200 border-slate-500 text-slate-900';
                      } else if (seat.highestWarningLevel === 3) {
                        cardTone = 'bg-rose-50 border-rose-600 text-rose-950';
                      } else if (seat.highestWarningLevel === 2) {
                        cardTone = 'bg-amber-50 border-amber-500 text-amber-950';
                      } else if (seat.highestWarningLevel === 1) {
                        cardTone = 'bg-[#E8F5EF] border-[#087F5B] text-[#10243A]';
                      }

                      return (
                        <button
                          key={seat.id}
                          type="button"
                          onClick={() => setSelectedSeatId(seat.id)}
                          className={`group text-left p-3.5 rounded-xl border-2 shadow-card transition-all min-h-[100px] flex flex-col justify-between ${cardTone} ${
                            isSelected ? 'ring-2 ring-[#10243A] ring-offset-2' : ''
                          } ${!matchesSearch ? 'opacity-30' : ''}`}
                        >
                          <div className="flex items-center justify-between gap-1 w-full">
                            <span className="font-mono-tabular text-xs font-bold px-2 py-0.5 rounded bg-[#10243A]/8 text-[#10243A]">
                              {seat.kode_kursi}
                            </span>
                            <div className="flex items-center gap-1">
                              {seat.activeExit && (
                                <span className="inline-flex items-center gap-0.5 text-[11px] font-bold text-slate-800">
                                  <Clock className="w-3.5 h-3.5" />
                                  Izin
                                </span>
                              )}
                              {seat.highestWarningLevel > 0 && (
                                <span className="inline-flex items-center gap-0.5 text-[11px] font-bold">
                                  <AlertTriangle className="w-3.5 h-3.5" />
                                  P{seat.highestWarningLevel}
                                </span>
                              )}
                            </div>
                          </div>

                          <div className="mt-2 space-y-0.5">
                            <p className="text-xs font-bold leading-snug line-clamp-2">
                              {seat.student ? seat.student.nama : 'Kursi Kosong'}
                            </p>
                            {seat.student && (
                              <p className="text-[11px] text-[#718096] font-mono-tabular truncate">
                                {seat.student.nomor_peserta}
                              </p>
                            )}
                          </div>

                          {seat.student && (
                            <div className="pt-1.5 mt-1.5 border-t border-black/5 flex items-center justify-between text-[11px] font-medium">
                              <span
                                className={
                                  seat.attendance.status === 'hadir'
                                    ? 'text-[#087F5B]'
                                    : seat.attendance.status === 'tidak_hadir'
                                    ? 'text-rose-700'
                                    : 'text-amber-700'
                                }
                              >
                                {seat.attendance.status === 'hadir'
                                  ? 'Hadir'
                                  : seat.attendance.status === 'tidak_hadir'
                                  ? 'Tidak Hadir'
                                  : 'Belum Dicatat'}
                              </span>
                              {hasPendingSync && <span className="text-amber-700">Tertunda</span>}
                            </div>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>

            {/* Elegant Detail Panel when Seat Selected */}
            {selectedSeat && (
              <div className="lg:col-span-5 xl:col-span-4 bg-white border border-[#E5EAF0] rounded-2xl p-5 space-y-5 shadow-elevated">
                <div className="flex items-start justify-between gap-3 border-b border-[#E5EAF0] pb-4">
                  <div>
                    <div className="flex items-center gap-2 text-xs text-[#718096] font-mono-tabular">
                      <span className="font-bold text-[#10243A]">Kursi {selectedSeat.kode_kursi}</span>
                      {selectedSeat.student && (
                        <>
                          <span>·</span>
                          <span>{selectedSeat.student.nomor_peserta}</span>
                        </>
                      )}
                    </div>
                    <h2 className="font-display text-lg font-bold text-[#10243A] mt-0.5">
                      {selectedSeat.student?.nama || 'Kursi Kosong'}
                    </h2>
                    {selectedSeat.student && (
                      <p className="text-xs text-[#718096] mt-0.5">
                        Kelas {selectedSeat.student.kelas} · NISN {selectedSeat.student.nisn || '-'}
                      </p>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => setSelectedSeatId(null)}
                    className="p-2 rounded-xl text-[#718096] hover:bg-[#F5F7FA] min-h-[40px] min-w-[40px] flex items-center justify-center"
                    aria-label="Tutup panel peserta"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>

                {selectedSeat.student ? (
                  <>
                    {/* Attendance Buttons */}
                    <div className="space-y-2">
                      <p className="text-xs font-semibold text-[#172B4D]">Status Kehadiran Peserta</p>
                      <div className="grid grid-cols-2 gap-2.5">
                        <button
                          type="button"
                          disabled={readOnlyMonitor || schedule.computed_status !== 'aktif'}
                          onClick={() => handleAttendance(selectedSeat, 'hadir')}
                          className={`py-2.5 px-3 rounded-xl border text-sm font-semibold min-h-[46px] inline-flex items-center justify-center gap-1.5 transition-colors disabled:opacity-50 ${
                            selectedSeat.attendance.status === 'hadir'
                              ? 'bg-[#087F5B] border-[#087F5B] text-white'
                              : 'bg-white border-[#E5EAF0] text-[#172B4D] hover:bg-[#E8F5EF]'
                          }`}
                        >
                          <CheckCircle2 className="w-4 h-4" />
                          Hadir
                        </button>
                        <button
                          type="button"
                          disabled={readOnlyMonitor || schedule.computed_status !== 'aktif'}
                          onClick={() => handleAttendance(selectedSeat, 'tidak_hadir')}
                          className={`py-2.5 px-3 rounded-xl border text-sm font-semibold min-h-[46px] inline-flex items-center justify-center gap-1.5 transition-colors disabled:opacity-50 ${
                            selectedSeat.attendance.status === 'tidak_hadir'
                              ? 'bg-rose-700 border-rose-700 text-white'
                              : 'bg-white border-[#E5EAF0] text-[#172B4D] hover:bg-rose-50'
                          }`}
                        >
                          <X className="w-4 h-4" />
                          Tidak Hadir
                        </button>
                      </div>
                    </div>

                    {/* Izin Keluar / Kembali */}
                    {!readOnlyMonitor && schedule.computed_status === 'aktif' && (
                      <div className="border-t border-[#E5EAF0] pt-4 space-y-2.5">
                        <p className="text-xs font-semibold text-[#172B4D]">Izin Keluar Ruangan</p>
                        {selectedSeat.activeExit ? (
                          <div className="p-3.5 rounded-xl bg-[#F5F7FA] border border-[#E5EAF0] space-y-2.5">
                            <div className="text-xs text-[#172B4D]">
                              <span className="font-bold">Sedang di luar ruangan</span> · Alasan:{' '}
                              {selectedSeat.activeExit.alasan}
                              <div className="font-mono-tabular text-[#718096] mt-0.5">
                                Keluar: {selectedSeat.activeExit.waktu_keluar}
                              </div>
                            </div>
                            <button
                              type="button"
                              onClick={() => handleExitAction('kembali')}
                              className="w-full py-2.5 px-3 rounded-xl bg-[#10243A] hover:bg-[#0B1929] text-white text-sm font-semibold min-h-[46px]"
                            >
                              Catat KEMBALI ke Ruangan
                            </button>
                          </div>
                        ) : (
                          <div className="space-y-2">
                            <div className="flex flex-wrap gap-1.5">
                              {[...EXIT_REASON_PRESETS, 'Lainnya'].map((preset) => (
                                <button
                                  key={preset}
                                  type="button"
                                  onClick={() => setExitReason(preset)}
                                  className={`px-3 py-1.5 rounded-lg text-xs font-medium border min-h-[38px] ${
                                    exitReason === preset
                                      ? 'bg-[#10243A] text-white border-[#10243A]'
                                      : 'bg-white text-[#172B4D] border-[#E5EAF0]'
                                  }`}
                                >
                                  {preset}
                                </button>
                              ))}
                            </div>
                            {exitReason === 'Lainnya' && (
                              <input
                                type="text"
                                value={customExitReason}
                                onChange={(e) => setCustomExitReason(e.target.value)}
                                placeholder="Tuliskan alasan izin keluar..."
                                className="w-full px-3.5 py-2 rounded-xl border border-[#E5EAF0] text-sm min-h-[42px]"
                              />
                            )}
                            <button
                              type="button"
                              onClick={() => handleExitAction('keluar')}
                              className="w-full py-2.5 px-3 rounded-xl border border-[#E5EAF0] bg-[#F5F7FA] hover:bg-slate-200/70 text-[#10243A] text-sm font-semibold min-h-[46px] inline-flex items-center justify-center gap-1.5"
                            >
                              <LogOut className="w-4 h-4" />
                              Catat IZIN KELUAR
                            </button>
                          </div>
                        )}
                      </div>
                    )}

                    {/* Warning System */}
                    {!readOnlyMonitor && schedule.computed_status === 'aktif' && (
                      <form onSubmit={handleSaveWarning} className="border-t border-[#E5EAF0] pt-4 space-y-3">
                        <div className="flex items-center justify-between">
                          <p className="text-xs font-semibold text-[#172B4D]">
                            {correctingWarningId
                              ? `Entri Koreksi Peringatan #${correctingWarningId} (BR-12)`
                              : 'Catat Peringatan Peserta'}
                          </p>
                          {correctingWarningId && (
                            <button
                              type="button"
                              onClick={() => setCorrectingWarningId(null)}
                              className="text-xs text-[#718096] underline"
                            >
                              Batal koreksi
                            </button>
                          )}
                        </div>

                        <div className="grid grid-cols-3 gap-2">
                          {([1, 2, 3] as const).map((lvl) => (
                            <button
                              key={lvl}
                              type="button"
                              onClick={() => setWarningLevel(lvl)}
                              className={`py-2.5 px-2 rounded-xl border text-xs font-bold min-h-[44px] transition-colors ${
                                warningLevel === lvl
                                  ? lvl === 1
                                    ? 'bg-[#087F5B] border-[#087F5B] text-white'
                                    : lvl === 2
                                    ? 'bg-amber-600 border-amber-600 text-white'
                                    : 'bg-rose-700 border-rose-700 text-white'
                                  : 'bg-white border-[#E5EAF0] text-[#172B4D]'
                              }`}
                            >
                              Peringatan {lvl}
                            </button>
                          ))}
                        </div>

                        {warningLevel === 3 && (
                          <p className="text-xs text-rose-800 bg-rose-50 border border-rose-200 rounded-xl p-2.5">
                            Peringatan 3 mengirim laporan otomatis ke Panitia (Admin). Sistem tidak mengeluarkan peserta secara otomatis (BR-06).
                          </p>
                        )}

                        <textarea
                          rows={2}
                          value={warningReason}
                          onChange={(e) => setWarningReason(e.target.value)}
                          placeholder="Tuliskan alasan peringatan secara objektif (wajib diisi)..."
                          className="w-full px-3.5 py-2.5 rounded-xl border border-[#E5EAF0] text-sm focus:outline-none focus:ring-2 focus:ring-[#087F5B]"
                        />

                        <button
                          type="submit"
                          disabled={!warningReason.trim()}
                          className="w-full py-2.5 px-4 rounded-xl bg-[#10243A] hover:bg-[#0B1929] text-white text-sm font-semibold min-h-[46px] disabled:opacity-40"
                        >
                          Simpan Peringatan {warningLevel}
                        </button>
                      </form>
                    )}

                    {/* Chronological History */}
                    <div className="border-t border-[#E5EAF0] pt-4 space-y-2">
                      <p className="text-xs font-semibold text-[#172B4D]">Riwayat Peringatan & Izin Keluar</p>
                      {selectedSeat.warnings.length === 0 && selectedSeat.exitHistory.length === 0 ? (
                        <p className="text-xs text-[#718096]">Belum ada catatan untuk peserta ini.</p>
                      ) : (
                        <div className="space-y-2 max-h-56 overflow-y-auto pr-1">
                          {selectedSeat.warnings.map((w) => (
                            <div key={`w-${w.id}`} className="p-3 rounded-xl border border-[#E5EAF0] text-xs space-y-1">
                              <div className="flex items-center justify-between gap-2">
                                <span className="font-bold text-[#10243A]">
                                  Peringatan {w.tingkat} {w.is_correction ? '(Koreksi)' : ''}
                                </span>
                                <span className="font-mono-tabular text-[#718096]">
                                  {w.waktu_server.slice(11, 19)} WIB
                                </span>
                              </div>
                              <p className="text-[#172B4D]">{w.alasan}</p>
                              <div className="flex items-center justify-between text-[11px] text-[#718096]">
                                <span>Oleh: {w.dicatat_oleh_nama}</span>
                                {!readOnlyMonitor && !w.is_correction && schedule.computed_status === 'aktif' && (
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setCorrectingWarningId(w.id);
                                      setWarningLevel(w.tingkat);
                                    }}
                                    className="text-[#087F5B] hover:underline font-semibold"
                                  >
                                    Buat Entri Koreksi
                                  </button>
                                )}
                              </div>
                            </div>
                          ))}
                          {selectedSeat.exitHistory.map((ex) => (
                            <div
                              key={`e-${ex.id}`}
                              className="p-3 rounded-xl border border-[#E5EAF0] bg-[#F5F7FA] text-xs space-y-0.5"
                            >
                              <div className="flex items-center justify-between">
                                <span className="font-semibold text-[#10243A]">Izin Keluar · {ex.alasan}</span>
                                <span className="font-mono-tabular text-[#172B4D]">
                                  Durasi: {formatDuration(ex.durasi_detik)}
                                </span>
                              </div>
                              <p className="font-mono-tabular text-[11px] text-[#718096]">
                                Keluar: {ex.waktu_keluar.slice(11, 19)} · Kembali:{' '}
                                {ex.waktu_kembali ? ex.waktu_kembali.slice(11, 19) : 'Masih di luar'}
                              </p>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </>
                ) : (
                  <p className="text-sm text-[#718096]">Kursi ini tidak memiliki peserta terdaftar.</p>
                )}
              </div>
            )}
          </div>
        )}

        {/* TAB 2: ADMINISTRASI RUANG */}
        {activeTab === 'dokumen' && roomDataset && (
          <div className="bg-white border border-[#E5EAF0] rounded-2xl p-6 space-y-5 shadow-card">
            <div>
              <h2 className="font-display text-base font-bold text-[#10243A]">
                Administrasi Ruang & Sesi Terhubung Otomatis
              </h2>
              <p className="text-sm text-[#718096] mt-0.5">
                Dokumen ruang terisi otomatis dari data terkonfirmasi untuk {room.kode} ({schedule.subject_nama}).
              </p>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3.5">
              {[
                ['cover', '01. Cover Ruang & Sesi'],
                ['denah_lingkungan', '02. Denah Lingkungan Ujian'],
                ['denah_peserta', '03. Denah Peserta Ruang'],
                ['jadwal_ujian', '04. Jadwal Ujian'],
                ['tata_tertib_peserta', '05. Tata Tertib Peserta'],
                ['tata_tertib_pengawas', '06. Tata Tertib Pengawas'],
                ['daftar_hadir_peserta', '07. Daftar Hadir Peserta'],
                ['daftar_hadir_pengawas', '08. Daftar Hadir Pengawas'],
                ['berita_acara', '09. Format Berita Acara'],
                ['catatan_kejadian', '10. Catatan Kejadian Khusus'],
              ].map(([key, title]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setPreviewDoc({ key, title })}
                  className="text-left p-4 rounded-xl border border-[#E5EAF0] hover:border-[#087F5B] hover:bg-[#E8F5EF]/50 transition-colors flex items-center justify-between gap-3 min-h-[60px]"
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <FileText className="w-4 h-4 text-[#087F5B] shrink-0" />
                    <span className="text-sm font-semibold text-[#172B4D] truncate">{title}</span>
                  </div>
                  <span className="text-xs font-semibold text-[#087F5B] shrink-0">Buka</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* TAB 3: CATATAN KEJADIAN */}
        {activeTab === 'kejadian' && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
            {!readOnlyMonitor && (
              <form
                onSubmit={handleAddIncident}
                className="lg:col-span-5 bg-white border border-[#E5EAF0] rounded-2xl p-6 space-y-4 shadow-card"
              >
                <h2 className="font-display text-base font-bold text-[#10243A]">
                  Tambah Catatan Kejadian Khusus
                </h2>
                <textarea
                  rows={4}
                  required
                  value={incidentDesc}
                  onChange={(e) => setIncidentDesc(e.target.value)}
                  placeholder="Catat kendala teknis, kekurangan naskah, atau kejadian khusus selama ujian berlangsung..."
                  className="w-full px-3.5 py-2.5 rounded-xl border border-[#E5EAF0] text-sm focus:outline-none focus:ring-2 focus:ring-[#087F5B]"
                />
                <button
                  type="submit"
                  disabled={submitting || !incidentDesc.trim()}
                  className="w-full py-2.5 px-4 rounded-xl bg-[#087F5B] hover:bg-[#06694B] text-white text-sm font-semibold min-h-[46px] disabled:opacity-50"
                >
                  Simpan Catatan Kejadian
                </button>
              </form>
            )}
            <div
              className={`${
                readOnlyMonitor ? 'lg:col-span-12' : 'lg:col-span-7'
              } bg-white border border-[#E5EAF0] rounded-2xl p-6 space-y-3 shadow-card`}
            >
              <h2 className="font-display text-base font-bold text-[#10243A]">
                Daftar Kejadian Ruang {room.kode}
              </h2>
              {incidents.length === 0 ? (
                <p className="text-sm text-[#718096]">Belum ada kejadian khusus tercatat pada sesi ini.</p>
              ) : (
                <div className="divide-y divide-[#E5EAF0]">
                  {incidents.map((inc) => (
                    <div key={inc.id} className="py-3.5 space-y-1">
                      <div className="flex items-center justify-between text-xs text-[#718096]">
                        <span className="font-semibold text-[#10243A]">{inc.dicatat_oleh_nama}</span>
                        <span className="font-mono-tabular">{inc.waktu}</span>
                      </div>
                      <p className="text-sm text-[#172B4D]">{inc.deskripsi}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* TAB 4: UPLOAD BERKAS & PENYELESAIAN */}
        {activeTab === 'berkas' && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
            <div className="bg-white border border-[#E5EAF0] rounded-2xl p-6 space-y-4 shadow-card">
              <div className="flex items-center justify-between border-b border-[#E5EAF0] pb-3.5">
                <div>
                  <h2 className="font-display text-base font-bold text-[#10243A]">
                    Berita Acara Pelaksanaan Ujian
                  </h2>
                  <div className="mt-1.5">{reportStatusBadge(baReport?.status || 'belum_dikerjakan')}</div>
                </div>
                {baReport && <span className="font-mono-tabular text-xs text-[#718096]">v{baReport.version}</span>}
              </div>

              {baReport?.verifications && baReport.verifications.length > 0 && (
                <div className="p-3.5 rounded-xl bg-[#F5F7FA] border border-[#E5EAF0] text-xs space-y-1">
                  <p className="font-semibold text-[#10243A]">Catatan Verifikasi Admin Terbaru:</p>
                  <p className="text-[#172B4D]">
                    [{baReport.verifications[0].status}] {baReport.verifications[0].catatan || 'Disetujui tanpa catatan.'}
                  </p>
                </div>
              )}

              <div className="grid grid-cols-3 gap-2 text-center p-3.5 rounded-xl bg-[#F5F7FA] border border-[#E5EAF0]">
                <div>
                  <p className="text-xs text-[#718096]">Terdaftar</p>
                  <p className="font-mono-tabular text-lg font-bold text-[#10243A]">{seatedStudents.length}</p>
                </div>
                <div>
                  <p className="text-xs text-[#718096]">Hadir</p>
                  <p className="font-mono-tabular text-lg font-bold text-[#087F5B]">{hadirCount}</p>
                </div>
                <div>
                  <p className="text-xs text-[#718096]">Tidak Hadir</p>
                  <p className="font-mono-tabular text-lg font-bold text-rose-700">{tidakHadirCount}</p>
                </div>
              </div>

              {belumCount > 0 && (
                <div className="p-3.5 rounded-xl bg-amber-50 border border-amber-200 text-xs text-amber-900 flex items-start gap-2">
                  <ShieldAlert className="w-4 h-4 shrink-0 text-amber-700 mt-0.5" />
                  <span>
                    Kelengkapan BR-15: Masih ada {belumCount} peserta berstatus "Belum Dicatat" pada denah.
                  </span>
                </div>
              )}

              {!readOnlyMonitor && baReport?.status !== 'terverifikasi' && (
                <form onSubmit={handleSubmitBeritaAcara} className="space-y-3.5">
                  <div>
                    <label className="block text-xs font-semibold text-[#172B4D] mb-1">Kondisi Pelaksanaan</label>
                    <select
                      value={baKondisi}
                      onChange={(e) => setBaKondisi(e.target.value)}
                      className="w-full px-3.5 py-2.5 rounded-xl border border-[#E5EAF0] text-sm bg-white min-h-[44px]"
                    >
                      <option value="Lancar dan Tertib">Lancar dan Tertib</option>
                      <option value="Lancar dengan Catatan Khusus">Lancar dengan Catatan Khusus</option>
                      <option value="Terdapat Gangguan Teknis / Tata Tertib">
                        Terdapat Gangguan Teknis / Tata Tertib
                      </option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-[#172B4D] mb-1">Catatan Berita Acara</label>
                    <textarea
                      rows={3}
                      value={baCatatan}
                      onChange={(e) => setBaCatatan(e.target.value)}
                      placeholder="Tambahkan ringkasan kondisi pelaksanaan ujian di ruang ini..."
                      className="w-full px-3.5 py-2.5 rounded-xl border border-[#E5EAF0] text-sm"
                    />
                  </div>
                  <SignaturePad
                    value={baSignature}
                    onChange={setBaSignature}
                    label="Tanda Tangan Digital Pengawas *"
                  />
                  <button
                    type="submit"
                    disabled={submitting || belumCount > 0 || !baSignature}
                    className="w-full py-2.5 px-4 rounded-xl bg-[#087F5B] hover:bg-[#06694B] text-white text-sm font-semibold min-h-[46px] inline-flex items-center justify-center gap-2 disabled:opacity-50"
                  >
                    <Send className="w-4 h-4" />
                    Kirim Berita Acara ke Admin
                  </button>
                </form>
              )}
            </div>

            <div className="bg-white border border-[#E5EAF0] rounded-2xl p-6 space-y-4 shadow-card">
              <div className="flex items-center justify-between border-b border-[#E5EAF0] pb-3.5">
                <div>
                  <h2 className="font-display text-base font-bold text-[#10243A]">
                    Daftar Hadir Bertanda Tangan
                  </h2>
                  <div className="mt-1.5">{reportStatusBadge(dhReport?.status || 'belum_dikerjakan')}</div>
                </div>
                {roomDataset && (
                  <button
                    type="button"
                    onClick={() =>
                      setPreviewDoc({
                        key: 'daftar_hadir_peserta',
                        title: '07. Daftar Hadir Peserta',
                      })
                    }
                    className="text-xs font-semibold text-[#087F5B] hover:underline"
                  >
                    Unduh Format Daftar Hadir
                  </button>
                )}
              </div>

              {dhReport?.verifications && dhReport.verifications.length > 0 && (
                <div className="p-3.5 rounded-xl bg-[#F5F7FA] border border-[#E5EAF0] text-xs space-y-1">
                  <p className="font-semibold text-[#10243A]">Catatan Verifikasi Admin Terbaru:</p>
                  <p className="text-[#172B4D]">
                    [{dhReport.verifications[0].status}] {dhReport.verifications[0].catatan || 'Disetujui.'}
                  </p>
                </div>
              )}

              {!readOnlyMonitor && dhReport?.status !== 'terverifikasi' && (
                <form onSubmit={handleUploadDaftarHadir} className="space-y-3.5">
                  {blobNotice && (
                    <div className="p-3 rounded-xl bg-amber-50 border border-amber-200 text-xs text-amber-900 flex items-start gap-2">
                      <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-amber-700" />
                      <span>{blobNotice}</span>
                    </div>
                  )}
                  <div>
                    <label className="block text-xs font-semibold text-[#172B4D] mb-1.5">
                      Unggah Hasil Scan / Foto Daftar Hadir (PDF, PNG, JPG) *
                    </label>
                    <input
                      type="file"
                      accept=".pdf,image/png,image/jpeg,image/webp"
                      onChange={(e) => setDhFile(e.target.files?.[0] || null)}
                      className="block w-full text-sm text-[#718096] file:mr-3 file:py-2 file:px-3.5 file:rounded-lg file:border file:border-[#E5EAF0] file:text-xs file:font-semibold file:bg-[#F5F7FA] file:text-[#172B4D]"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-[#172B4D] mb-1">Catatan Tambahan</label>
                    <input
                      type="text"
                      value={dhCatatan}
                      onChange={(e) => setDhCatatan(e.target.value)}
                      placeholder="Opsional..."
                      className="w-full px-3.5 py-2 rounded-xl border border-[#E5EAF0] text-sm min-h-[44px]"
                    />
                  </div>
                  <button
                    type="submit"
                    disabled={submitting || !dhFile}
                    className="w-full py-2.5 px-4 rounded-xl bg-[#10243A] hover:bg-[#0B1929] text-white text-sm font-semibold min-h-[46px] inline-flex items-center justify-center gap-2 disabled:opacity-50"
                  >
                    <Upload className="w-4 h-4" />
                    Unggah & Kirim Daftar Hadir
                  </button>
                </form>
              )}

              {dhReport?.status === 'terverifikasi' && (
                <div className="p-3.5 rounded-xl bg-[#E8F5EF] border border-[#087F5B]/30 text-xs text-[#087F5B] font-medium">
                  Dokumen Daftar Hadir telah Terverifikasi oleh Admin dan dikunci (BR-16).
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {previewDoc && roomDataset && (
        <DocumentViewerModal
          docKey={previewDoc.key}
          title={previewDoc.title}
          version={1}
          dataset={roomDataset}
          defaultRoomKode={room.kode}
          onClose={() => setPreviewDoc(null)}
        />
      )}

      <ToastNotification
        message={toast?.msg || null}
        type={toast?.type || 'success'}
        onDismiss={() => setToast(null)}
      />
    </div>
  );
};
