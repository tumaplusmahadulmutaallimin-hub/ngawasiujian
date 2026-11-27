import React, { useCallback, useEffect, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  BarChart3,
  Bell,
  Building2,
  Calendar,
  CheckCircle2,
  ClipboardList,
  Clock,
  Download,
  Eye,
  FileCheck2,
  FileSpreadsheet,
  FileText,
  FolderArchive,
  Inbox,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Plus,
  RefreshCw,
  ScrollText,
  Search,
  ShieldCheck,
  Upload,
  UserCheck,
  Users,
  X,
} from 'lucide-react';
import { apiFetch, downloadAuthenticatedFile, getAuthToken } from '../lib/api.ts';
import { generateAdminDocumentPdf, generateRecapPdf, type DocDataset } from '../lib/pdfGenerator.ts';
import type {
  AuditLogRecord,
  AuthUser,
  ExamRecord,
  ImportBatchRecord,
  ImportDocType,
  NotificationRecord,
  RoomRecord,
  SupervisionScheduleItem,
  SupervisorRecord,
} from '../types.ts';
import { BrandMark, useServerWibClock } from './BrandMark.tsx';
import { DocumentViewerModal } from './DocumentViewerModal.tsx';
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

interface AdminWorkspaceProps {
  user: AuthUser;
  onLogout: () => void;
}

type AdminSection =
  | 'monitoring'
  | 'jadwal'
  | 'impor'
  | 'dokumen'
  | 'ruang'
  | 'pengawas'
  | 'laporan'
  | 'notifikasi'
  | 'audit';

const DOC_TYPE_LABELS: Record<ImportDocType, string> = {
  data_peserta: 'Data Peserta',
  data_pengawas: 'Data Pengawas',
  jadwal_ujian: 'Jadwal Ujian',
  jadwal_pengawasan: 'Jadwal Pengawasan',
  pembagian_ruang: 'Pembagian Ruang',
  denah_peserta: 'Denah Peserta',
  daftar_hadir_peserta: 'Daftar Hadir Peserta',
  denah_lingkungan: 'Denah Lingkungan Ujian',
  dokumen_pendukung: 'Dokumen Pendukung Lainnya',
};

export const AdminWorkspace: React.FC<AdminWorkspaceProps> = ({ user, onLogout }) => {
  const wibClock = useServerWibClock();
  const [section, setSection] = useState<AdminSection>('monitoring');
  const [monitoringRoomId, setMonitoringRoomId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [headerSearch, setHeaderSearch] = useState('');
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' | 'info' } | null>(
    null
  );

  // Data states
  const [monitoring, setMonitoring] = useState<{
    summary: Record<string, number>;
    schedules: SupervisionScheduleItem[];
    level3Alerts: Array<Record<string, unknown>>;
  } | null>(null);
  const [recentActivity, setRecentActivity] = useState<AuditLogRecord[]>([]);
  const [exams, setExams] = useState<ExamRecord[]>([]);
  const [rooms, setRooms] = useState<Array<RoomRecord & { seats: Array<Record<string, unknown>> }>>([]);
  const [supervisors, setSupervisors] = useState<SupervisorRecord[]>([]);
  const [reports, setReports] = useState<Array<Record<string, unknown>>>([]);
  const [notifications, setNotifications] = useState<NotificationRecord[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLogRecord[]>([]);
  const [auditQuery, setAuditQuery] = useState('');

  // Import states
  const [batches, setBatches] = useState<Array<Record<string, unknown>>>([]);
  const [activeBatch, setActiveBatch] = useState<ImportBatchRecord | null>(null);
  const [uploadingImport, setUploadingImport] = useState(false);

  // 11 Docs Generator states
  const [docCatalog, setDocCatalog] = useState<Array<{ doc_key: string; title: string }>>([]);
  const [docVersions, setDocVersions] = useState<Array<Record<string, unknown>>>([]);
  const [docDataset, setDocDataset] = useState<DocDataset | null>(null);
  const [previewDoc, setPreviewDoc] = useState<{ key: string; title: string; version: number } | null>(null);

  // Modals / Forms
  const [newExamForm, setNewExamForm] = useState({
    nama: '',
    madrasah_nama: 'MAN 1 Nusantara',
    tahun_ajaran: '2026/2027',
    tanggal_mulai: '',
    tanggal_selesai: '',
  });
  const [assignModalScheduleId, setAssignModalScheduleId] = useState<number | null>(null);
  const [assignSupId, setAssignSupId] = useState<number | ''>('');
  const [assignPeran, setAssignPeran] = useState<'utama' | 'pendamping'>('utama');

  const [resetSupModal, setResetSupModal] = useState<{ id: number; nama: string } | null>(null);
  const [resetNewPass, setResetNewPass] = useState('');

  const [verifyModalReport, setVerifyModalReport] = useState<Record<string, unknown> | null>(null);
  const [verifyNote, setVerifyNote] = useState('');

  const loadSectionData = useCallback(async () => {
    try {
      const [mon, notif] = await Promise.all([
        apiFetch<typeof monitoring>('/api/admin/monitoring'),
        apiFetch<NotificationRecord[]>('/api/notifications'),
      ]);
      setMonitoring(mon);
      setNotifications(notif);

      if (section === 'monitoring') {
        const recent = await apiFetch<AuditLogRecord[]>('/api/admin/audit-logs');
        setRecentActivity(recent.slice(0, 8));
      }
      if (section === 'jadwal' || section === 'pengawas') {
        const [ex, sups] = await Promise.all([
          apiFetch<ExamRecord[]>('/api/admin/exams'),
          apiFetch<SupervisorRecord[]>('/api/admin/supervisors'),
        ]);
        setExams(ex);
        setSupervisors(sups);
      }
      if (section === 'impor') {
        const b = await apiFetch<Array<Record<string, unknown>>>('/api/admin/import/batches');
        setBatches(b);
      }
      if (section === 'dokumen') {
        const [gen, ds] = await Promise.all([
          apiFetch<{ catalog: Array<{ doc_key: string; title: string }>; versions: Array<Record<string, unknown>> }>(
            '/api/admin/documents/generated'
          ),
          apiFetch<DocDataset>('/api/admin/documents/dataset'),
        ]);
        setDocCatalog(gen.catalog);
        setDocVersions(gen.versions);
        setDocDataset(ds);
      }
      if (section === 'ruang') {
        const rm = await apiFetch<Array<RoomRecord & { seats: Array<Record<string, unknown>> }>>('/api/admin/rooms');
        setRooms(rm);
      }
      if (section === 'laporan') {
        const reps = await apiFetch<Array<Record<string, unknown>>>('/api/admin/reports');
        setReports(reps);
      }
      if (section === 'audit') {
        const logs = await apiFetch<AuditLogRecord[]>(
          `/api/admin/audit-logs${auditQuery ? `?q=${encodeURIComponent(auditQuery)}` : ''}`
        );
        setAuditLogs(logs);
      }
    } catch (err) {
      setToast({
        message: err instanceof Error ? err.message : 'Gagal memuat data admin.',
        type: 'error',
      });
    } finally {
      setLoading(false);
    }
  }, [section, auditQuery]);

  useEffect(() => {
    loadSectionData();
  }, [loadSectionData]);

  // Real-time WebSocket monitoring updates
  useEffect(() => {
    const token = getAuthToken();
    if (!token) return;
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${window.location.host}/ws?token=${encodeURIComponent(token)}`);
    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data) as { type?: string };
        if (msg.type === 'monitoring:updated' || msg.type === 'warning:level3' || msg.type === 'notification:new') {
          loadSectionData();
          if (msg.type === 'warning:level3') {
            setToast({
              message:
                'Peringatan Tingkat 3 baru dilaporkan dari ruang ujian! Periksa panel Peringatan Peserta.',
              type: 'error',
            });
          }
        }
      } catch {
        // Ignore
      }
    };
    return () => ws.close();
  }, [loadSectionData]);

  if (monitoringRoomId !== null) {
    return (
      <SupervisionRoom
        scheduleId={monitoringRoomId}
        currentUser={user}
        readOnlyMonitor
        onBack={() => {
          setMonitoringRoomId(null);
          loadSectionData();
        }}
      />
    );
  }

  const unreadNotifs = notifications.filter((n) => n.dibaca === 0).length;

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadingImport(true);
    try {
      const form = new FormData();
      form.append('file', file);
      const batch = await apiFetch<ImportBatchRecord>('/api/admin/import/upload', {
        method: 'POST',
        body: form,
      });
      setActiveBatch(batch);
      setToast({ message: `Dokumen "${file.name}" berhasil diekstrak ke pratinjau.`, type: 'success' });
      await loadSectionData();
    } catch (err) {
      setToast({
        message: err instanceof Error ? err.message : 'Gagal mengunggah dan mengekstrak dokumen.',
        type: 'error',
      });
    } finally {
      setUploadingImport(false);
      e.target.value = '';
    }
  };

  const handleLoadSampleSaum = async () => {
    setUploadingImport(true);
    try {
      const res = await apiFetch<{ batchesImported: number }>('/api/admin/import/sample-package', {
        method: 'POST',
      });
      setToast({
        message: `Paket sampel SAUM (${res.batchesImported} dokumen: Pengawas, Peserta, Denah, dan Jadwal Ujian Aktif WIB) berhasil diimpor.`,
        type: 'success',
      });
      await loadSectionData();
    } catch (err) {
      setToast({
        message: err instanceof Error ? err.message : 'Gagal memuat paket sampel SAUM.',
        type: 'error',
      });
    } finally {
      setUploadingImport(false);
    }
  };

  const handlePreviewCellEdit = (rowIndex: number, key: string, value: string) => {
    if (!activeBatch) return;
    const nextRows = activeBatch.extracted_rows.map((row, idx) =>
      idx === rowIndex ? { ...row, [key]: value === '' ? null : value } : row
    );
    setActiveBatch({ ...activeBatch, extracted_rows: nextRows });
  };

  const handleSaveBatchCorrections = async () => {
    if (!activeBatch) return;
    try {
      const updated = await apiFetch<{
        detected_type: ImportDocType;
        extracted_rows: Array<Record<string, unknown>>;
        unreadable_fields: ImportBatchRecord['unreadable_fields'];
        duplicates: ImportBatchRecord['duplicates'];
      }>(`/api/admin/import/${activeBatch.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          detected_type: activeBatch.detected_type,
          extracted_rows: activeBatch.extracted_rows,
        }),
      });
      setActiveBatch({ ...activeBatch, ...updated });
      setToast({ message: 'Koreksi pratinjau disimpan dan validasi ulang selesai.', type: 'success' });
    } catch (err) {
      setToast({
        message: err instanceof Error ? err.message : 'Gagal menyimpan koreksi.',
        type: 'error',
      });
    }
  };

  const handleConfirmBatch = async () => {
    if (!activeBatch) return;
    try {
      const res = await apiFetch<{ inserted: number; updated: number; skipped: number }>(
        `/api/admin/import/${activeBatch.id}/confirm`,
        {
          method: 'POST',
          body: JSON.stringify({
            detected_type: activeBatch.detected_type,
            extracted_rows: activeBatch.extracted_rows,
          }),
        }
      );
      setToast({
        message: `Konfirmasi simpan berhasil: ${res.inserted} data baru, ${res.updated} diperbarui, ${res.skipped} dilewati.`,
        type: 'success',
      });
      setActiveBatch(null);
      await loadSectionData();
    } catch (err) {
      setToast({
        message: err instanceof Error ? err.message : 'Gagal mengonfirmasi penyimpanan.',
        type: 'error',
      });
    }
  };

  const handleRegenerateAllDocs = async () => {
    try {
      await apiFetch('/api/admin/documents/generated/regenerate', {
        method: 'POST',
        body: JSON.stringify({}),
      });
      setToast({
        message: 'Seluruh 11 dokumen administrasi pengawasan telah diperbarui ke versi terbaru.',
        type: 'success',
      });
      await loadSectionData();
    } catch (err) {
      setToast({
        message: err instanceof Error ? err.message : 'Gagal memperbarui dokumen.',
        type: 'error',
      });
    }
  };

  const handleCreateExam = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await apiFetch('/api/admin/exams', {
        method: 'POST',
        body: JSON.stringify(newExamForm),
      });
      setNewExamForm({
        nama: '',
        madrasah_nama: 'MAN 1 Nusantara',
        tahun_ajaran: '2026/2027',
        tanggal_mulai: '',
        tanggal_selesai: '',
      });
      setToast({ message: 'Kegiatan ujian baru berhasil dibuat.', type: 'success' });
      await loadSectionData();
    } catch (err) {
      setToast({
        message: err instanceof Error ? err.message : 'Gagal membuat kegiatan ujian.',
        type: 'error',
      });
    }
  };

  const handleAssignSupervisor = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!assignModalScheduleId || !assignSupId) return;
    try {
      await apiFetch(`/api/admin/schedules/${assignModalScheduleId}/assign`, {
        method: 'POST',
        body: JSON.stringify({ supervisorId: Number(assignSupId), peran: assignPeran }),
      });
      setAssignModalScheduleId(null);
      setAssignSupId('');
      setToast({
        message: 'Penugasan pengawas disimpan dan notifikasi dikirim ke pengawas.',
        type: 'success',
      });
      await loadSectionData();
    } catch (err) {
      setToast({
        message: err instanceof Error ? err.message : 'Gagal menugaskan pengawas.',
        type: 'error',
      });
    }
  };

  const handleVerifyReport = async (status: 'terverifikasi' | 'perlu_perbaikan') => {
    if (!verifyModalReport) return;
    try {
      await apiFetch(`/api/admin/reports/${verifyModalReport.id}/verify`, {
        method: 'POST',
        body: JSON.stringify({ status, catatan: verifyNote }),
      });
      setVerifyModalReport(null);
      setVerifyNote('');
      setToast({
        message: `Laporan telah ditandai "${status.replace('_', ' ')}".`,
        type: 'success',
      });
      await loadSectionData();
    } catch (err) {
      setToast({
        message: err instanceof Error ? err.message : 'Gagal memverifikasi laporan.',
        type: 'error',
      });
    }
  };

  const navItems: Array<{
    key: AdminSection;
    label: string;
    icon: React.ComponentType<{ className?: string }>;
    badge?: number;
  }> = [
    { key: 'monitoring', label: 'Dashboard Monitoring', icon: LayoutDashboard },
    { key: 'impor', label: 'Impor Dokumen SAUM', icon: Upload },
    { key: 'dokumen', label: '11 Dokumen Otomatis', icon: FolderArchive },
    { key: 'jadwal', label: 'Kegiatan & Jadwal', icon: Calendar },
    { key: 'ruang', label: 'Ruang & Denah', icon: Building2 },
    { key: 'pengawas', label: 'Pengawas & Akun', icon: Users },
    { key: 'laporan', label: 'Laporan & Verifikasi', icon: ClipboardList },
    { key: 'notifikasi', label: 'Notifikasi', icon: Bell, badge: unreadNotifs },
    { key: 'audit', label: 'Audit Log', icon: ScrollText },
  ];

  const batchKeys =
    activeBatch && activeBatch.extracted_rows.length > 0
      ? Array.from(
          new Set(
            activeBatch.extracted_rows.flatMap((r) => Object.keys(r).filter((k) => !k.startsWith('_')))
          )
        )
      : [];

  // Derived real metrics for charts & search filters
  const q = headerSearch.trim().toLowerCase();
  const filteredSchedules = (monitoring?.schedules || []).filter((sch) => {
    if (!q) return true;
    return (
      sch.room_kode.toLowerCase().includes(q) ||
      sch.room_nama.toLowerCase().includes(q) ||
      sch.subject_nama.toLowerCase().includes(q) ||
      sch.co_supervisors.some((c) => c.nama_lengkap.toLowerCase().includes(q))
    );
  });
  const filteredSupervisors = supervisors.filter((sup) => {
    if (!q) return true;
    return (
      sup.nama_lengkap.toLowerCase().includes(q) ||
      (sup.nip_nuptk || '').toLowerCase().includes(q) ||
      (sup.username || '').toLowerCase().includes(q)
    );
  });
  const filteredRooms = rooms.filter((r) => {
    if (!q) return true;
    return r.kode.toLowerCase().includes(q) || r.nama.toLowerCase().includes(q);
  });
  const filteredReports = reports.filter((rep) => {
    if (!q) return true;
    return (
      String(rep.room_kode || '').toLowerCase().includes(q) ||
      String(rep.subject_nama || '').toLowerCase().includes(q) ||
      String(rep.supervisor_nama || '').toLowerCase().includes(q)
    );
  });

  // Real chart calculations (zero fabrication)
  const schedulesAll = monitoring?.schedules || [];
  const countAktif = schedulesAll.filter((s) => s.computed_status === 'aktif').length;
  const countAkanDatang = schedulesAll.filter((s) => s.computed_status === 'akan_datang').length;
  const countSelesai = schedulesAll.filter((s) => s.computed_status === 'selesai').length;
  const countDibatalkan = schedulesAll.filter((s) => s.computed_status === 'dibatalkan').length;
  const totalSch = Math.max(1, schedulesAll.length);

  const repTerverifikasi = schedulesAll.filter((s) => s.report_status === 'terverifikasi').length;
  const repMenunggu = schedulesAll.filter((s) => s.report_status === 'menunggu_verifikasi').length;
  const repPerbaikan = schedulesAll.filter((s) => s.report_status === 'perlu_perbaikan').length;
  const repBelum = schedulesAll.length - repTerverifikasi - repMenunggu - repPerbaikan;

  const studentHadir = monitoring?.summary.studentHadir || 0;
  const studentAbsen = monitoring?.summary.studentTidakHadir || 0;
  const totalRecordedStudents = studentHadir + studentAbsen;
  const attendancePct =
    totalRecordedStudents > 0 ? Math.round((studentHadir / totalRecordedStudents) * 100) : 0;

  const supCheckedIn = monitoring?.summary.checkedInSupervisors || 0;
  const supTotal = monitoring?.summary.totalSupervisors || 0;
  const supPct = supTotal > 0 ? Math.round((supCheckedIn / supTotal) * 100) : 0;

  return (
    <div className="min-h-screen bg-[#F5F7FA] text-[#172B4D] flex flex-col lg:flex-row">
      {/* Deep Navy Sidebar */}
      <aside className="lg:w-72 bg-[#10243A] text-white flex flex-col shrink-0 border-b lg:border-b-0 lg:border-r border-[#10243A]">
        <div className="p-5 border-b border-white/10 flex lg:flex-col lg:items-start items-center justify-between gap-3">
          <BrandMark inverse />
          <div className="hidden lg:flex items-center gap-2 text-[11px] font-medium text-[#C9A45C]">
            <ShieldCheck className="w-3.5 h-3.5 shrink-0" />
            <span>Konsol Panitia & Admin Madrasah</span>
          </div>
        </div>

        <nav className="p-3 flex lg:flex-col gap-1 overflow-x-auto lg:overflow-x-visible flex-1">
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = section === item.key;
            return (
              <button
                key={item.key}
                type="button"
                onClick={() => setSection(item.key)}
                className={`flex items-center justify-between gap-2.5 px-3.5 py-2.5 rounded-xl text-xs sm:text-sm font-medium whitespace-nowrap transition-colors min-h-[42px] shrink-0 ${
                  active
                    ? 'bg-[#087F5B] text-white shadow-card'
                    : 'text-slate-300 hover:bg-white/10 hover:text-white'
                }`}
              >
                <span className="flex items-center gap-2.5">
                  <Icon className="w-4 h-4 shrink-0" />
                  <span>{item.label}</span>
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

        <div className="hidden lg:block p-4 border-t border-white/10 space-y-3 bg-black/15">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-[#087F5B] text-white flex items-center justify-center text-xs font-bold border border-[#C9A45C]/40 shrink-0">
              {user.namaLengkap.slice(0, 2).toUpperCase()}
            </div>
            <div className="min-w-0">
              <p className="text-xs font-semibold text-white truncate">{user.namaLengkap}</p>
              <p className="text-[11px] text-slate-300 font-mono-tabular truncate">
                @{user.username} · Panitia Admin
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onLogout}
            className="w-full flex items-center justify-center gap-2 py-2 px-3 rounded-lg border border-white/15 bg-white/5 hover:bg-white/10 text-xs font-medium text-slate-100 min-h-[40px] transition-colors"
          >
            <LogOut className="w-3.5 h-3.5" />
            Keluar Sistem
          </button>
        </div>
      </aside>

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top Header with Search, WIB Clock, Notification Bell & Profile */}
        <header className="bg-white border-b border-[#E5EAF0] px-4 sm:px-6 py-3 flex flex-wrap items-center justify-between gap-3 sticky top-0 z-20">
          <div className="min-w-0">
            <h1 className="font-display text-base sm:text-lg font-bold text-[#10243A] truncate">
              {navItems.find((n) => n.key === section)?.label}
            </h1>
            <p className="text-[11px] text-[#718096] hidden sm:block">
              SIPENGUJI · Pusat Kendali Ujian Madrasah
            </p>
          </div>

          <div className="flex items-center gap-2.5 sm:gap-3 flex-1 justify-end max-w-2xl">
            {/* Search Box */}
            <div className="relative flex-1 max-w-xs hidden md:block">
              <Search className="w-4 h-4 text-[#718096] absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={section === 'audit' ? auditQuery : headerSearch}
                onChange={(e) => {
                  if (section === 'audit') {
                    setAuditQuery(e.target.value);
                  } else {
                    setHeaderSearch(e.target.value);
                  }
                }}
                placeholder={
                  section === 'audit'
                    ? 'Cari aksi, entitas, pelaku...'
                    : 'Cari ruang, mapel, atau pengawas...'
                }
                className="w-full pl-9 pr-8 py-2 rounded-xl border border-[#E5EAF0] bg-[#F5F7FA] focus:bg-white text-xs text-[#172B4D] placeholder:text-[#718096] min-h-[40px]"
              />
              {(section === 'audit' ? auditQuery : headerSearch) && (
                <button
                  type="button"
                  onClick={() => (section === 'audit' ? setAuditQuery('') : setHeaderSearch(''))}
                  aria-label="Bersihkan pencarian"
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[#718096] hover:text-[#172B4D]"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            {/* Server WIB Clock */}
            <div className="px-3 py-1.5 rounded-xl bg-[#F5F7FA] border border-[#E5EAF0] font-mono-tabular text-xs font-semibold text-[#172B4D] hidden sm:flex items-center gap-1.5 shrink-0">
              <Clock className="w-3.5 h-3.5 text-[#087F5B]" />
              <span>
                {wibClock.date} · {wibClock.time} WIB
              </span>
            </div>

            {/* Notification Bell */}
            <button
              type="button"
              onClick={() => setSection('notifikasi')}
              aria-label="Buka Notifikasi"
              className="relative p-2.5 rounded-xl border border-[#E5EAF0] bg-white hover:bg-[#F5F7FA] text-[#172B4D] min-h-[40px] min-w-[40px] flex items-center justify-center shrink-0 transition-colors"
            >
              <Bell className="w-4 h-4" />
              {unreadNotifs > 0 && (
                <span className="absolute -top-1 -right-1 px-1.5 py-0.5 rounded-full bg-[#087F5B] text-white text-[10px] font-mono-tabular font-bold leading-none">
                  {unreadNotifs}
                </span>
              )}
            </button>

            {/* Profile Badge (Desktop) / Logout (Mobile) */}
            <div className="hidden lg:flex items-center gap-2 pl-2 border-l border-[#E5EAF0] shrink-0">
              <div className="w-8 h-8 rounded-full bg-[#10243A] text-white text-xs font-bold flex items-center justify-center">
                {user.namaLengkap.slice(0, 2).toUpperCase()}
              </div>
              <div className="leading-tight">
                <p className="text-xs font-semibold text-[#172B4D]">{user.namaLengkap}</p>
                <p className="text-[10px] text-[#718096]">Admin</p>
              </div>
            </div>
            <button
              type="button"
              onClick={onLogout}
              className="lg:hidden px-3 py-2 rounded-xl border border-[#E5EAF0] text-xs font-semibold text-[#172B4D] min-h-[40px]"
            >
              Keluar
            </button>
          </div>
        </header>

        <main className="flex-1 p-4 sm:p-6 max-w-7xl w-full mx-auto space-y-6">
          {loading && !monitoring ? (
            <div className="space-y-4">
              <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
                <SkeletonBlock rows={1} />
                <SkeletonBlock rows={1} />
                <SkeletonBlock rows={1} />
                <SkeletonBlock rows={1} />
                <SkeletonBlock rows={1} />
              </div>
              <SkeletonBlock rows={5} />
            </div>
          ) : (
            <>
              {/* 1. DASHBOARD MONITORING (FR-MON) */}
              {section === 'monitoring' && monitoring && (
                <div className="space-y-6">
                  {/* Summary KPI Cards */}
                  <section className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
                    <StatCard
                      label="Pengawas Hadir / Total"
                      value={`${monitoring.summary.checkedInSupervisors} / ${monitoring.summary.totalSupervisors}`}
                      subtext={`${supPct}% kehadiran pengawas`}
                      icon={<UserCheck className="w-4 h-4" />}
                      accent="emerald"
                    />
                    <StatCard
                      label="Ruang Berlangsung"
                      value={`${monitoring.summary.activeRoomsCount} / ${monitoring.summary.totalRooms}`}
                      subtext={`${countAktif} sesi aktif WIB`}
                      icon={<Building2 className="w-4 h-4" />}
                      accent="navy"
                    />
                    <StatCard
                      label="Peserta Hadir / Absen"
                      value={`${monitoring.summary.studentHadir} / ${monitoring.summary.studentTidakHadir}`}
                      subtext={
                        totalRecordedStudents > 0
                          ? `${attendancePct}% tingkat kehadiran`
                          : 'Belum ada presensi tercatat'
                      }
                      icon={<Users className="w-4 h-4" />}
                      accent="emerald"
                    />
                    <StatCard
                      label="Izin Keluar (Aktif / Total)"
                      value={`${monitoring.summary.activeExits} / ${monitoring.summary.totalExits}`}
                      subtext="Pemantauan keluar ruang"
                      icon={<Clock className="w-4 h-4" />}
                      accent="gold"
                    />
                    <StatCard
                      label="Peringatan 3 / Laporan Pending"
                      value={`${monitoring.summary.level3Count} / ${monitoring.summary.unverifiedReports}`}
                      subtext="Perlu perhatian Panitia"
                      icon={<AlertTriangle className="w-4 h-4" />}
                      accent={
                        monitoring.summary.level3Count > 0 || monitoring.summary.unverifiedReports > 0
                          ? 'rose'
                          : 'navy'
                      }
                    />
                  </section>

                  {/* Data Visualizations: Grafik Aktivitas Pengawasan, Rekap Kehadiran & Status Pengawas */}
                  <section className="grid grid-cols-1 lg:grid-cols-12 gap-5">
                    {/* Grafik Aktivitas Pengawasan & Status Jadwal + Berkas */}
                    <div className="lg:col-span-7 bg-white border border-[#E5EAF0] rounded-xl p-5 shadow-card space-y-5">
                      <div className="flex items-center justify-between gap-2">
                        <div>
                          <h2 className="font-display text-sm font-bold text-[#10243A] flex items-center gap-2">
                            <BarChart3 className="w-4 h-4 text-[#087F5B]" />
                            <span>Grafik Aktivitas Pengawasan & Ringkasan Jadwal</span>
                          </h2>
                          <p className="text-xs text-[#718096] mt-0.5">
                            Distribusi status seluruh sesi ujian dan kelengkapan berkas pengawas secara real-time.
                          </p>
                        </div>
                        <span className="font-mono-tabular text-xs font-semibold text-[#10243A] bg-[#F5F7FA] px-2.5 py-1 rounded-md border border-[#E5EAF0]">
                          {schedulesAll.length} Sesi
                        </span>
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
                        {/* Distribusi Status Sesi */}
                        <div className="space-y-3">
                          <p className="text-xs font-semibold text-[#172B4D]">Status Jadwal Ujian</p>
                          {(
                            [
                              ['Sedang Aktif', countAktif, '#087F5B', 'bg-[#087F5B]'],
                              ['Akan Datang', countAkanDatang, '#C9A45C', 'bg-[#C9A45C]'],
                              ['Selesai', countSelesai, '#10243A', 'bg-[#10243A]'],
                              ['Dibatalkan', countDibatalkan, '#E11D48', 'bg-rose-600'],
                            ] as const
                          ).map(([label, val, _hex, barClass]) => {
                            const pct = schedulesAll.length > 0 ? Math.round((val / totalSch) * 100) : 0;
                            return (
                              <div key={label} className="space-y-1">
                                <div className="flex items-center justify-between text-xs">
                                  <span className="text-[#718096] font-medium">{label}</span>
                                  <span className="font-mono-tabular font-bold text-[#172B4D]">
                                    {val} ({pct}%)
                                  </span>
                                </div>
                                <div className="h-2 rounded-full bg-[#F5F7FA] overflow-hidden border border-[#E5EAF0]">
                                  <div
                                    className={`h-full rounded-full ${barClass} transition-all`}
                                    style={{ width: `${pct}%` }}
                                  />
                                </div>
                              </div>
                            );
                          })}
                        </div>

                        {/* Distribusi Pengumpulan Berkas */}
                        <div className="space-y-3">
                          <p className="text-xs font-semibold text-[#172B4D]">Kelengkapan Berkas Ruang</p>
                          {(
                            [
                              ['Terverifikasi', repTerverifikasi, 'bg-[#087F5B]'],
                              ['Menunggu Verifikasi', repMenunggu, 'bg-amber-500'],
                              ['Perlu Perbaikan', repPerbaikan, 'bg-rose-600'],
                              ['Belum Selesai', Math.max(0, repBelum), 'bg-slate-400'],
                            ] as const
                          ).map(([label, val, barClass]) => {
                            const pct = schedulesAll.length > 0 ? Math.round((val / totalSch) * 100) : 0;
                            return (
                              <div key={label} className="space-y-1">
                                <div className="flex items-center justify-between text-xs">
                                  <span className="text-[#718096] font-medium">{label}</span>
                                  <span className="font-mono-tabular font-bold text-[#172B4D]">
                                    {val} ({pct}%)
                                  </span>
                                </div>
                                <div className="h-2 rounded-full bg-[#F5F7FA] overflow-hidden border border-[#E5EAF0]">
                                  <div
                                    className={`h-full rounded-full ${barClass} transition-all`}
                                    style={{ width: `${pct}%` }}
                                  />
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    </div>

                    {/* Rekap Kehadiran Peserta & Status Pengawas */}
                    <div className="lg:col-span-5 bg-white border border-[#E5EAF0] rounded-xl p-5 shadow-card flex flex-col justify-between gap-4">
                      <div>
                        <h2 className="font-display text-sm font-bold text-[#10243A]">
                          Rekap Kehadiran Peserta & Pengawas
                        </h2>
                        <p className="text-xs text-[#718096] mt-0.5">
                          Proporsi kehadiran berdasarkan pencatatan ruang ujian.
                        </p>
                      </div>

                      <div className="flex items-center gap-5 py-1">
                        {/* SVG Donut Ring */}
                        <div className="relative w-24 h-24 shrink-0">
                          <svg viewBox="0 0 36 36" className="w-full h-full -rotate-90">
                            <circle
                              cx="18"
                              cy="18"
                              r="15.5"
                              fill="none"
                              stroke="#E5EAF0"
                              strokeWidth="3.2"
                            />
                            <circle
                              cx="18"
                              cy="18"
                              r="15.5"
                              fill="none"
                              stroke="#087F5B"
                              strokeWidth="3.2"
                              strokeDasharray={`${attendancePct} ${100 - attendancePct}`}
                              strokeLinecap="round"
                            />
                          </svg>
                          <div className="absolute inset-0 flex flex-col items-center justify-center">
                            <span className="font-mono-tabular text-base font-bold text-[#10243A]">
                              {attendancePct}%
                            </span>
                            <span className="text-[10px] text-[#718096]">Hadir</span>
                          </div>
                        </div>

                        <div className="flex-1 space-y-2.5 text-xs">
                          <div className="flex items-center justify-between">
                            <span className="flex items-center gap-1.5 text-[#718096]">
                              <span className="w-2.5 h-2.5 rounded-full bg-[#087F5B]" />
                              Peserta Hadir
                            </span>
                            <span className="font-mono-tabular font-bold text-[#172B4D]">
                              {studentHadir}
                            </span>
                          </div>
                          <div className="flex items-center justify-between">
                            <span className="flex items-center gap-1.5 text-[#718096]">
                              <span className="w-2.5 h-2.5 rounded-full bg-rose-500" />
                              Peserta Tidak Hadir
                            </span>
                            <span className="font-mono-tabular font-bold text-[#172B4D]">
                              {studentAbsen}
                            </span>
                          </div>
                          <div className="pt-2 border-t border-[#E5EAF0] space-y-1.5">
                            <div className="flex items-center justify-between">
                              <span className="text-[#718096]">Status Pengawas Hadir</span>
                              <span className="font-mono-tabular font-bold text-[#087F5B]">
                                {supCheckedIn} / {supTotal} ({supPct}%)
                              </span>
                            </div>
                            <div className="h-2 rounded-full bg-[#F5F7FA] overflow-hidden border border-[#E5EAF0]">
                              <div
                                className="h-full rounded-full bg-[#10243A] transition-all"
                                style={{ width: `${supPct}%` }}
                              />
                            </div>
                          </div>
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-[#E5EAF0]">
                        <button
                          type="button"
                          onClick={() =>
                            generateRecapPdf(
                              monitoring.summary,
                              monitoring.schedules,
                              `${wibClock.date} ${wibClock.time} WIB`
                            )
                          }
                          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-[#087F5B] hover:bg-[#06694b] text-white text-xs font-semibold min-h-[38px]"
                        >
                          <Download className="w-3.5 h-3.5" />
                          Rekap PDF
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            downloadAuthenticatedFile('/api/admin/recap/export?format=xlsx', 'Rekap_SIPENGUJI.xlsx')
                          }
                          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-[#E5EAF0] bg-[#F5F7FA] hover:bg-slate-200/70 text-xs font-semibold text-[#172B4D] min-h-[38px]"
                        >
                          <FileSpreadsheet className="w-3.5 h-3.5 text-[#087F5B]" />
                          Excel
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            downloadAuthenticatedFile('/api/admin/recap/export?format=csv', 'Rekap_SIPENGUJI.csv')
                          }
                          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-[#E5EAF0] bg-[#F5F7FA] hover:bg-slate-200/70 text-xs font-semibold text-[#172B4D] min-h-[38px]"
                        >
                          CSV
                        </button>
                      </div>
                    </div>
                  </section>

                  {/* Monitoring Ruang Ujian Table (FR-MON-02) */}
                  <section className="bg-white border border-[#E5EAF0] rounded-xl overflow-hidden shadow-card">
                    <div className="p-4 sm:p-5 border-b border-[#E5EAF0] flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <h2 className="font-display text-sm font-bold text-[#10243A]">
                          Monitoring Ruang Ujian & Ringkasan Jadwal
                        </h2>
                        <p className="text-xs text-[#718096] mt-0.5">
                          Pilih "Pantau Ruang" untuk melihat denah kursi dan status pengawasan secara langsung.
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={loadSectionData}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[#E5EAF0] bg-[#F5F7FA] hover:bg-slate-200/70 text-xs font-semibold text-[#172B4D]"
                      >
                        <RefreshCw className="w-3.5 h-3.5 text-[#087F5B]" />
                        Segarkan
                      </button>
                    </div>
                    {monitoring.schedules.length === 0 ? (
                      <EmptyState
                        icon={<Upload className="w-6 h-6" />}
                        title="Belum Ada Data Ruang & Jadwal Ujian"
                        description="Mulai operasional dengan mengimpor dokumen ekspor SAUM atau memuat paket sampel SAUM untuk uji coba."
                        action={
                          <button
                            type="button"
                            onClick={() => setSection('impor')}
                            className="px-4 py-2.5 rounded-xl bg-[#087F5B] hover:bg-[#06694b] text-white text-xs font-semibold min-h-[42px]"
                          >
                            Buka Impor Dokumen SAUM
                          </button>
                        }
                      />
                    ) : filteredSchedules.length === 0 ? (
                      <div className="p-8 text-center text-sm text-[#718096]">
                        Tidak ada ruang atau jadwal yang cocok dengan kata kunci "{headerSearch}".
                      </div>
                    ) : (
                      <div className="overflow-x-auto">
                        <table className="w-full text-left border-collapse text-xs sm:text-sm">
                          <thead>
                            <tr className="border-b border-[#E5EAF0] bg-[#F5F7FA] text-xs text-[#718096]">
                              <th className="py-3 px-4 font-semibold">Ruang</th>
                              <th className="py-3 px-4 font-semibold">Jadwal (WIB)</th>
                              <th className="py-3 px-4 font-semibold">Mata Pelajaran</th>
                              <th className="py-3 px-4 font-semibold">Pengawas</th>
                              <th className="py-3 px-4 font-semibold">Status Sesi</th>
                              <th className="py-3 px-4 font-semibold">Laporan</th>
                              <th className="py-3 px-4 font-semibold text-right">Aksi</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-[#E5EAF0]">
                            {filteredSchedules.map((sch) => (
                              <tr key={sch.id} className="hover:bg-[#F5F7FA]/70 transition-colors">
                                <td className="py-3.5 px-4 font-semibold text-[#10243A] whitespace-nowrap">
                                  <span className="font-mono-tabular">{sch.room_kode}</span> · {sch.room_nama}
                                </td>
                                <td className="py-3.5 px-4 font-mono-tabular text-xs text-[#718096] whitespace-nowrap">
                                  {sch.tanggal} · {sch.jam_mulai}-{sch.jam_selesai}
                                </td>
                                <td className="py-3.5 px-4 text-[#172B4D] font-medium">{sch.subject_nama}</td>
                                <td className="py-3.5 px-4 text-xs text-[#172B4D]">
                                  {sch.co_supervisors.length === 0 ? (
                                    <span className="text-[#718096]">Belum ditugaskan</span>
                                  ) : (
                                    <div className="flex flex-wrap gap-1.5">
                                      {sch.co_supervisors.map((c) => (
                                        <span
                                          key={c.supervisor_id}
                                          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md border text-[11px] font-medium ${
                                            c.checked_in
                                              ? 'bg-[#E8F5EF] text-[#087F5B] border-[#B7E4D0]'
                                              : 'bg-[#F5F7FA] text-[#718096] border-[#E5EAF0]'
                                          }`}
                                        >
                                          {c.nama_lengkap}
                                          {c.checked_in ? ' · Hadir' : ''}
                                        </span>
                                      ))}
                                    </div>
                                  )}
                                </td>
                                <td className="py-3.5 px-4">{scheduleStatusBadge(sch.computed_status)}</td>
                                <td className="py-3.5 px-4">{reportStatusBadge(sch.report_status)}</td>
                                <td className="py-3.5 px-4 text-right">
                                  <button
                                    type="button"
                                    onClick={() => setMonitoringRoomId(sch.id)}
                                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[#E5EAF0] bg-white hover:bg-[#10243A] hover:text-white text-xs font-semibold text-[#172B4D] min-h-[36px] transition-colors"
                                  >
                                    <Eye className="w-3.5 h-3.5" />
                                    Pantau Ruang
                                  </button>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </section>

                  {/* Lower Dashboard Row: Peringatan Peserta & Aktivitas Terbaru */}
                  <section className="grid grid-cols-1 lg:grid-cols-2 gap-5">
                    {/* Peringatan Peserta (Level 3 Alerts) */}
                    <div className="bg-white border border-[#E5EAF0] rounded-xl overflow-hidden shadow-card">
                      <div className="p-4 sm:p-5 border-b border-[#E5EAF0] flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0" />
                          <h3 className="font-display text-sm font-bold text-[#10243A]">
                            Peringatan Peserta (Tingkat 3)
                          </h3>
                        </div>
                        <StatusBadge tone={monitoring.level3Alerts.length > 0 ? 'rose' : 'emerald'}>
                          {monitoring.level3Alerts.length} Kasus
                        </StatusBadge>
                      </div>
                      {monitoring.level3Alerts.length === 0 ? (
                        <div className="p-6 text-xs text-[#718096] flex items-center gap-2.5">
                          <CheckCircle2 className="w-4 h-4 text-[#087F5B] shrink-0" />
                          <span>Tidak ada pelanggaran berat (Tingkat 3) yang dilaporkan saat ini.</span>
                        </div>
                      ) : (
                        <div className="divide-y divide-[#E5EAF0]">
                          {monitoring.level3Alerts.map((w) => (
                            <div key={String(w.id)} className="p-4 flex items-start justify-between gap-3">
                              <div className="space-y-0.5 text-xs">
                                <p className="font-bold text-[#172B4D]">
                                  {String(w.student_nama)} ({String(w.nomor_peserta)})
                                </p>
                                <p className="text-[#087F5B] font-semibold">
                                  {String(w.room_kode)} · {String(w.subject_nama)}
                                </p>
                                <p className="text-[#718096]">Alasan: {String(w.alasan)}</p>
                              </div>
                              <span className="font-mono-tabular text-[11px] text-[#718096] shrink-0">
                                {String(w.waktu_server)}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* Aktivitas Terbaru (Real Audit Logs) */}
                    <div className="bg-white border border-[#E5EAF0] rounded-xl overflow-hidden shadow-card">
                      <div className="p-4 sm:p-5 border-b border-[#E5EAF0] flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <Activity className="w-4 h-4 text-[#087F5B] shrink-0" />
                          <h3 className="font-display text-sm font-bold text-[#10243A]">
                            Aktivitas Terbaru Sistem
                          </h3>
                        </div>
                        <button
                          type="button"
                          onClick={() => setSection('audit')}
                          className="text-xs font-semibold text-[#087F5B] hover:underline"
                        >
                          Audit Log Lengkap
                        </button>
                      </div>
                      {recentActivity.length === 0 ? (
                        <div className="p-6 text-xs text-[#718096]">Belum ada aktivitas tercatat.</div>
                      ) : (
                        <div className="divide-y divide-[#E5EAF0]">
                          {recentActivity.slice(0, 6).map((log) => (
                            <div key={log.id} className="p-3.5 sm:px-5 flex items-center justify-between gap-3 text-xs">
                              <div className="min-w-0">
                                <p className="font-semibold text-[#172B4D] truncate">
                                  <span className="font-mono-tabular text-[#087F5B]">{log.aksi}</span>{' '}
                                  · {log.entitas}
                                </p>
                                <p className="text-[#718096] truncate">
                                  Oleh {log.username || 'sistem'} {log.entitas_id ? `(#${log.entitas_id})` : ''}
                                </p>
                              </div>
                              <span className="font-mono-tabular text-[11px] text-[#718096] shrink-0">
                                {log.waktu_server.slice(11, 19)} WIB
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </section>
                </div>
              )}

              {/* 2. IMPOR DOKUMEN SAUM (FR-IMP) */}
              {section === 'impor' && (
                <div className="space-y-6">
                  <div className="bg-white border border-[#E5EAF0] rounded-xl p-6 space-y-5 shadow-card">
                    <div className="flex flex-wrap items-start justify-between gap-4">
                      <div>
                        <h2 className="font-display text-base font-bold text-[#10243A]">
                          Unggah Dokumen Ekspor SAUM
                        </h2>
                        <p className="text-sm text-[#718096] mt-1">
                          Mendukung XLSX, CSV, PDF teks, PDF scan, dan gambar scan (PNG/JPG). Sel yang tidak terbaca ditandai dan tidak diisi otomatis (BR-08).
                        </p>
                      </div>
                      <button
                        type="button"
                        disabled={uploadingImport}
                        onClick={handleLoadSampleSaum}
                        className="px-4 py-2.5 rounded-xl border border-[#087F5B] bg-[#E8F5EF] hover:bg-[#d3eee1] text-[#087F5B] text-xs font-bold min-h-[42px] transition-colors"
                      >
                        Muat Paket Sampel SAUM (Siap Uji)
                      </button>
                    </div>

                    <label className="block border-2 border-dashed border-[#E5EAF0] hover:border-[#087F5B] rounded-xl p-8 text-center cursor-pointer transition-colors bg-[#F5F7FA]">
                      <Upload className="w-7 h-7 text-[#087F5B] mx-auto mb-2" />
                      <p className="text-sm font-semibold text-[#10243A]">
                        {uploadingImport
                          ? 'Sedang mengarsipkan SHA-256 dan mengekstrak dokumen...'
                          : 'Pilih atau jatuhkan file ekspor SAUM (.xlsx, .csv, .pdf, .png, .jpg)'}
                      </p>
                      <p className="text-xs text-[#718096] mt-1">
                        Ukuran maksimal 20 MB · Arsip sumber bersifat permanen
                      </p>
                      <input
                        type="file"
                        accept=".xlsx,.xls,.csv,.pdf,image/png,image/jpeg,image/webp"
                        disabled={uploadingImport}
                        onChange={handleFileUpload}
                        className="hidden"
                      />
                    </label>

                    <div className="flex flex-wrap items-center gap-2 text-xs text-[#718096] pt-1">
                      <span className="font-semibold text-[#172B4D]">Unduh Template Ekspor SAUM:</span>
                      {(
                        [
                          ['data_pengawas', 'Data Pengawas'],
                          ['data_peserta', 'Data Peserta'],
                          ['denah_peserta', 'Denah Peserta'],
                          ['jadwal_pengawasan', 'Jadwal Pengawasan'],
                        ] as const
                      ).map(([tKey, tLabel]) => (
                        <button
                          key={tKey}
                          type="button"
                          onClick={() =>
                            downloadAuthenticatedFile(`/api/admin/import/template/${tKey}`, `Template_SAUM_${tKey}.xlsx`)
                          }
                          className="px-3 py-1.5 rounded-lg border border-[#E5EAF0] bg-white hover:bg-[#F5F7FA] text-[#172B4D] font-medium"
                        >
                          {tLabel} (.xlsx)
                        </button>
                      ))}
                    </div>
                  </div>

                  {activeBatch && (
                    <div className="bg-white border border-[#E5EAF0] rounded-xl p-6 space-y-5 shadow-card">
                      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-[#E5EAF0] pb-4">
                        <div>
                          <h3 className="font-display text-base font-bold text-[#10243A]">
                            Pratinjau & Validasi: {activeBatch.filename}
                          </h3>
                          <p className="text-xs text-[#718096] font-mono-tabular mt-0.5">
                            SHA-256: {activeBatch.sha256.slice(0, 20)}... · Keyakinan Klasifikasi:{' '}
                            {Math.round(activeBatch.confidence * 100)}%
                          </p>
                        </div>
                        <div className="flex items-center gap-2">
                          <label className="text-xs font-semibold text-[#172B4D]">Jenis Dokumen:</label>
                          <select
                            value={activeBatch.detected_type}
                            onChange={(e) =>
                              setActiveBatch({ ...activeBatch, detected_type: e.target.value as ImportDocType })
                            }
                            className="px-3 py-2 rounded-lg border border-[#E5EAF0] text-xs font-semibold bg-white min-h-[38px]"
                          >
                            {Object.entries(DOC_TYPE_LABELS).map(([k, lbl]) => (
                              <option key={k} value={k}>
                                {lbl}
                              </option>
                            ))}
                          </select>
                        </div>
                      </div>

                      {activeBatch.confidence < 0.75 && (
                        <div className="p-3 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-900">
                          Klasifikasi otomatis belum sepenuhnya yakin. Pastikan jenis dokumen di kanan atas sudah sesuai sebelum konfirmasi (FR-IMP-03).
                        </div>
                      )}

                      {activeBatch.unreadable_fields.length > 0 && (
                        <div className="p-3.5 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-950 space-y-1">
                          <p className="font-semibold">
                            Ditemukan {activeBatch.unreadable_fields.length} sel kosong / tidak terbaca (BR-08 — tidak ditebak otomatis):
                          </p>
                          <ul className="list-disc pl-4 space-y-0.5">
                            {activeBatch.unreadable_fields.slice(0, 8).map((u, i) => (
                              <li key={i}>
                                Baris {u.rowIndex + 1} · Kolom <code>{u.field}</code>: {u.reason}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}

                      {activeBatch.duplicates.length > 0 && (
                        <div className="p-3.5 rounded-lg bg-rose-50 border border-rose-200 text-xs text-rose-900 space-y-1">
                          <p className="font-semibold">Deteksi Duplikasi ({activeBatch.duplicates.length}):</p>
                          <ul className="list-disc pl-4 space-y-0.5">
                            {activeBatch.duplicates.slice(0, 8).map((d, i) => (
                              <li key={i}>
                                Baris {d.rowIndex + 1} · {d.field} = {d.value} ({d.source})
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}

                      <div className="overflow-x-auto border border-[#E5EAF0] rounded-lg max-h-96">
                        <table className="w-full text-left border-collapse text-xs">
                          <thead className="bg-[#F5F7FA] sticky top-0">
                            <tr>
                              <th className="py-2.5 px-3 border-b border-[#E5EAF0] font-mono-tabular">#</th>
                              {batchKeys.map((k) => (
                                <th key={k} className="py-2.5 px-3 border-b border-[#E5EAF0] font-semibold">
                                  {k}
                                </th>
                              ))}
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-[#E5EAF0]">
                            {activeBatch.extracted_rows.map((row, rIdx) => (
                              <tr key={rIdx}>
                                <td className="py-1.5 px-3 font-mono-tabular text-[#718096]">{rIdx + 1}</td>
                                {batchKeys.map((k) => {
                                  const val = row[k];
                                  const isMissing = activeBatch.unreadable_fields.some(
                                    (u) => u.rowIndex === rIdx && (u.field === k || u.field === '*')
                                  );
                                  return (
                                    <td key={k} className="p-1">
                                      <input
                                        type="text"
                                        value={val === null || val === undefined ? '' : String(val)}
                                        placeholder="(kosong)"
                                        onChange={(e) => handlePreviewCellEdit(rIdx, k, e.target.value)}
                                        className={`w-full min-w-[110px] px-2 py-1.5 rounded border text-xs ${
                                          isMissing
                                            ? 'border-amber-400 bg-amber-50'
                                            : 'border-[#E5EAF0] bg-white'
                                        }`}
                                      />
                                    </td>
                                  );
                                })}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>

                      <div className="flex flex-wrap items-center justify-end gap-3 pt-2">
                        <button
                          type="button"
                          onClick={handleSaveBatchCorrections}
                          className="px-4 py-2.5 rounded-xl border border-[#E5EAF0] bg-white hover:bg-[#F5F7FA] text-xs font-semibold min-h-[42px]"
                        >
                          Simpan Koreksi & Validasi Ulang
                        </button>
                        <button
                          type="button"
                          onClick={handleConfirmBatch}
                          className="px-5 py-2.5 rounded-xl bg-[#087F5B] hover:bg-[#06694b] text-white text-xs sm:text-sm font-semibold min-h-[44px]"
                        >
                          KONFIRMASI SIMPAN
                        </button>
                      </div>
                    </div>
                  )}

                  <div className="bg-white border border-[#E5EAF0] rounded-xl overflow-hidden shadow-card">
                    <div className="p-4 sm:p-5 border-b border-[#E5EAF0]">
                      <h3 className="font-display text-sm font-bold text-[#10243A]">Riwayat Arsip Impor Dokumen</h3>
                    </div>
                    {batches.length === 0 ? (
                      <div className="p-6 text-xs text-[#718096]">Belum ada berkas impor yang diunggah.</div>
                    ) : (
                      <div className="overflow-x-auto">
                        <table className="w-full text-left border-collapse text-xs">
                          <thead>
                            <tr className="bg-[#F5F7FA] border-b border-[#E5EAF0] text-[#718096]">
                              <th className="py-3 px-4 font-semibold">Berkas</th>
                              <th className="py-3 px-4 font-semibold">Jenis Terdeteksi</th>
                              <th className="py-3 px-4 font-semibold">SHA-256</th>
                              <th className="py-3 px-4 font-semibold">Status</th>
                              <th className="py-3 px-4 font-semibold text-right">Aksi</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-[#E5EAF0]">
                            {batches.map((b) => (
                              <tr key={String(b.id)} className="hover:bg-[#F5F7FA]/60">
                                <td className="py-3 px-4 font-semibold text-[#172B4D]">{String(b.filename)}</td>
                                <td className="py-3 px-4">
                                  {DOC_TYPE_LABELS[b.detected_type as ImportDocType] || String(b.detected_type)}
                                </td>
                                <td className="py-3 px-4 font-mono-tabular text-[#718096]">
                                  {String(b.sha256).slice(0, 14)}...
                                </td>
                                <td className="py-3 px-4">
                                  <StatusBadge tone={b.status === 'confirmed' ? 'emerald' : 'gold'}>
                                    {b.status === 'confirmed' ? 'Terkonfirmasi' : String(b.status)}
                                  </StatusBadge>
                                </td>
                                <td className="py-3 px-4 text-right">
                                  {b.status === 'preview' && (
                                    <button
                                      type="button"
                                      onClick={async () => {
                                        const full = await apiFetch<ImportBatchRecord>(`/api/admin/import/${b.id}`);
                                        setActiveBatch(full);
                                      }}
                                      className="text-[#087F5B] font-semibold hover:underline"
                                    >
                                      Lanjutkan Pratinjau
                                    </button>
                                  )}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* 3. GENERATOR 11 DOKUMEN ADMINISTRASI (FR-GEN) */}
              {section === 'dokumen' && (
                <div className="space-y-5">
                  <div className="bg-white border border-[#E5EAF0] rounded-xl p-5 flex flex-wrap items-center justify-between gap-4 shadow-card">
                    <div>
                      <h2 className="font-display text-base font-bold text-[#10243A]">
                        Generator Administrasi Pengawasan (11 Dokumen Resmi)
                      </h2>
                      <p className="text-xs sm:text-sm text-[#718096] mt-0.5">
                        Dokumen otomatis mengambil data terbaru. Perubahan data menandai dokumen perlu dibuat ulang (FR-GEN-03).
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={handleRegenerateAllDocs}
                      className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-[#087F5B] hover:bg-[#06694b] text-white text-xs sm:text-sm font-semibold min-h-[42px]"
                    >
                      <RefreshCw className="w-4 h-4" />
                      Buat Ulang Semua Dokumen
                    </button>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {docCatalog.map((item) => {
                      const verRow = docVersions.find((v) => v.doc_key === item.doc_key);
                      const version = verRow ? Number(verRow.version) : 1;
                      const stale = verRow ? Boolean(verRow.needs_regeneration) : false;

                      return (
                        <div
                          key={item.doc_key}
                          className="bg-white border border-[#E5EAF0] rounded-xl p-4 sm:p-5 flex flex-wrap items-center justify-between gap-3 shadow-card"
                        >
                          <div className="min-w-0 space-y-1">
                            <div className="flex items-center gap-2">
                              <div className="w-8 h-8 rounded-lg bg-[#E8F5EF] text-[#087F5B] flex items-center justify-center shrink-0">
                                <FileText className="w-4 h-4" />
                              </div>
                              <h3 className="text-sm font-bold text-[#10243A] truncate">{item.title}</h3>
                            </div>
                            <div className="flex items-center gap-2 pl-10">
                              <span className="text-xs text-[#718096] font-mono-tabular">Versi {version}</span>
                              <StatusBadge tone={stale ? 'amber' : 'emerald'}>
                                {stale ? 'Perlu Dibuat Ulang' : 'Terkini'}
                              </StatusBadge>
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              disabled={!docDataset}
                              onClick={() => setPreviewDoc({ key: item.doc_key, title: item.title, version })}
                              className="px-3 py-1.5 rounded-lg border border-[#E5EAF0] bg-white hover:bg-[#F5F7FA] text-xs font-semibold text-[#172B4D] min-h-[38px]"
                            >
                              Pratinjau / Cetak
                            </button>
                            <button
                              type="button"
                              disabled={!docDataset}
                              onClick={() =>
                                docDataset && generateAdminDocumentPdf(item.doc_key, item.title, docDataset, version)
                              }
                              className="px-3 py-1.5 rounded-lg bg-[#10243A] hover:bg-[#1a3554] text-white text-xs font-semibold min-h-[38px]"
                            >
                              PDF
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* 4. KEGIATAN & JADWAL (FR-JDW) */}
              {section === 'jadwal' && (
                <div className="space-y-6">
                  <form
                    onSubmit={handleCreateExam}
                    className="bg-white border border-[#E5EAF0] rounded-xl p-5 space-y-4 shadow-card"
                  >
                    <div className="flex items-center gap-2">
                      <Plus className="w-4 h-4 text-[#087F5B]" />
                      <h2 className="font-display text-sm font-bold text-[#10243A]">Buat Kegiatan Ujian Baru</h2>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                      <input
                        type="text"
                        required
                        placeholder="Nama Kegiatan (mis. UM 2026)"
                        value={newExamForm.nama}
                        onChange={(e) => setNewExamForm({ ...newExamForm, nama: e.target.value })}
                        className="px-3.5 py-2 rounded-xl border border-[#E5EAF0] text-sm min-h-[42px]"
                      />
                      <input
                        type="text"
                        required
                        placeholder="Nama Madrasah"
                        value={newExamForm.madrasah_nama}
                        onChange={(e) => setNewExamForm({ ...newExamForm, madrasah_nama: e.target.value })}
                        className="px-3.5 py-2 rounded-xl border border-[#E5EAF0] text-sm min-h-[42px]"
                      />
                      <input
                        type="text"
                        required
                        placeholder="Tahun Ajaran (2026/2027)"
                        value={newExamForm.tahun_ajaran}
                        onChange={(e) => setNewExamForm({ ...newExamForm, tahun_ajaran: e.target.value })}
                        className="px-3.5 py-2 rounded-xl border border-[#E5EAF0] text-sm min-h-[42px]"
                      />
                      <input
                        type="date"
                        required
                        value={newExamForm.tanggal_mulai}
                        onChange={(e) => setNewExamForm({ ...newExamForm, tanggal_mulai: e.target.value })}
                        className="px-3.5 py-2 rounded-xl border border-[#E5EAF0] text-sm min-h-[42px]"
                      />
                      <input
                        type="date"
                        required
                        value={newExamForm.tanggal_selesai}
                        onChange={(e) => setNewExamForm({ ...newExamForm, tanggal_selesai: e.target.value })}
                        className="px-3.5 py-2 rounded-xl border border-[#E5EAF0] text-sm min-h-[42px]"
                      />
                      <button
                        type="submit"
                        className="px-4 py-2 rounded-xl bg-[#087F5B] hover:bg-[#06694b] text-white text-sm font-semibold min-h-[42px]"
                      >
                        Simpan Kegiatan
                      </button>
                    </div>
                    {exams.length > 0 && (
                      <p className="text-xs text-[#718096]">
                        Kegiatan aktif: {exams.map((e) => `${e.nama} (${e.madrasah_nama})`).join(' · ')}
                      </p>
                    )}
                  </form>

                  <div className="bg-white border border-[#E5EAF0] rounded-xl overflow-hidden shadow-card">
                    <div className="p-4 sm:p-5 border-b border-[#E5EAF0]">
                      <h2 className="font-display text-sm font-bold text-[#10243A]">
                        Jadwal & Penugasan Pengawas (Waktu Server WIB)
                      </h2>
                    </div>
                    {filteredSchedules.length === 0 ? (
                      <EmptyState
                        icon={<Calendar className="w-6 h-6" />}
                        title="Belum Ada Jadwal Pengawasan"
                        description="Impor jadwal pengawasan dari menu Impor Dokumen SAUM untuk memulai penugasan."
                      />
                    ) : (
                      <div className="overflow-x-auto">
                        <table className="w-full text-left border-collapse text-xs">
                          <thead>
                            <tr className="bg-[#F5F7FA] border-b border-[#E5EAF0] text-[#718096]">
                              <th className="py-3 px-4 font-semibold">Tanggal & Waktu</th>
                              <th className="py-3 px-4 font-semibold">Ruang</th>
                              <th className="py-3 px-4 font-semibold">Mata Pelajaran</th>
                              <th className="py-3 px-4 font-semibold">Pengawas Ditugaskan</th>
                              <th className="py-3 px-4 font-semibold">Status Server</th>
                              <th className="py-3 px-4 font-semibold text-right">Kelola</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-[#E5EAF0]">
                            {filteredSchedules.map((sch) => (
                              <tr key={sch.id} className="hover:bg-[#F5F7FA]/60">
                                <td className="py-3 px-4 font-mono-tabular whitespace-nowrap">
                                  {sch.tanggal} · {sch.jam_mulai}-{sch.jam_selesai}
                                </td>
                                <td className="py-3 px-4 font-semibold text-[#10243A]">{sch.room_kode}</td>
                                <td className="py-3 px-4">{sch.subject_nama}</td>
                                <td className="py-3 px-4">
                                  {sch.co_supervisors.map((c) => `${c.nama_lengkap} (${c.peran})`).join(', ') ||
                                    'Belum ditugaskan'}
                                </td>
                                <td className="py-3 px-4">{scheduleStatusBadge(sch.computed_status)}</td>
                                <td className="py-3 px-4 text-right space-x-2 whitespace-nowrap">
                                  <button
                                    type="button"
                                    onClick={() => setAssignModalScheduleId(sch.id)}
                                    className="px-3 py-1.5 rounded-lg border border-[#E5EAF0] bg-white hover:bg-[#F5F7FA] font-semibold"
                                  >
                                    Tugaskan
                                  </button>
                                  <button
                                    type="button"
                                    onClick={async () => {
                                      await apiFetch(`/api/admin/schedules/${sch.id}/cancel`, {
                                        method: 'POST',
                                        body: JSON.stringify({ cancelled: sch.computed_status !== 'dibatalkan' }),
                                      });
                                      loadSectionData();
                                    }}
                                    className="px-3 py-1.5 rounded-lg border border-rose-200 text-rose-700 hover:bg-rose-50 font-semibold"
                                  >
                                    {sch.computed_status === 'dibatalkan' ? 'Aktifkan' : 'Batalkan'}
                                  </button>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* 5. RUANG & DENAH */}
              {section === 'ruang' && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                  {filteredRooms.length === 0 ? (
                    <div className="col-span-full">
                      <EmptyState
                        icon={<Building2 className="w-6 h-6" />}
                        title="Belum Ada Ruang Ujian"
                        description="Unggah dokumen pembagian ruang atau denah peserta pada menu Impor Dokumen SAUM."
                        action={
                          <button
                            type="button"
                            onClick={() => setSection('impor')}
                            className="px-4 py-2.5 rounded-xl bg-[#087F5B] text-white text-xs font-semibold"
                          >
                            Buka Impor Dokumen SAUM
                          </button>
                        }
                      />
                    </div>
                  ) : (
                    filteredRooms.map((r) => (
                      <div
                        key={r.id}
                        className="bg-white border border-[#E5EAF0] rounded-xl p-5 space-y-4 shadow-card"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div>
                            <h3 className="font-display text-base font-bold text-[#10243A]">
                              {r.kode} — {r.nama}
                            </h3>
                            <p className="text-xs text-[#718096] font-mono-tabular">
                              Grid {r.rows_count} baris × {r.cols_count} kolom · {r.seats.length} kursi terdaftar
                            </p>
                          </div>
                          <StatusBadge tone="navy">{r.seats.length} Kursi</StatusBadge>
                        </div>
                        <div className="p-2 rounded-lg bg-[#10243A] text-white text-[10px] font-semibold tracking-wider uppercase text-center">
                          Papan Tulis & Meja Pengawas
                        </div>
                        <div
                          className="grid gap-1.5"
                          style={{
                            gridTemplateColumns: `repeat(${Math.max(1, r.cols_count)}, minmax(0, 1fr))`,
                          }}
                        >
                          {r.seats.map((s) => (
                            <div
                              key={String(s.id)}
                              className="p-2 rounded-lg border border-[#E5EAF0] bg-[#F5F7FA] text-[11px]"
                            >
                              <p className="font-mono-tabular font-bold text-[#10243A]">
                                {String(s.kode_kursi)}
                              </p>
                              <p className="truncate text-[#718096]">
                                {s.student_nama ? String(s.student_nama) : 'Kosong'}
                              </p>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              )}

              {/* 6. PENGAWAS & AKUN (FR-MON-04, BR-18) */}
              {section === 'pengawas' && (
                <div className="bg-white border border-[#E5EAF0] rounded-xl overflow-hidden shadow-card">
                  <div className="p-4 sm:p-5 border-b border-[#E5EAF0]">
                    <h2 className="font-display text-sm font-bold text-[#10243A]">
                      Daftar Pengawas & Manajemen Akun
                    </h2>
                    <p className="text-xs text-[#718096] mt-0.5">
                      Berikan Kode Verifikasi kepada pengawas untuk melakukan aktivasi akun pada menu Buat Akun Pengawas.
                    </p>
                  </div>
                  {filteredSupervisors.length === 0 ? (
                    <EmptyState
                      icon={<Users className="w-6 h-6" />}
                      title="Belum Ada Data Pengawas"
                      description="Impor data pengawas dari SAUM agar daftar dan kode verifikasi otomatis dibuat."
                    />
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-left border-collapse text-xs">
                        <thead>
                          <tr className="bg-[#F5F7FA] border-b border-[#E5EAF0] text-[#718096]">
                            <th className="py-3 px-4 font-semibold">Nama Lengkap</th>
                            <th className="py-3 px-4 font-semibold">NIP / NUPTK</th>
                            <th className="py-3 px-4 font-semibold">Kode Verifikasi</th>
                            <th className="py-3 px-4 font-semibold">Akun</th>
                            <th className="py-3 px-4 font-semibold">Status</th>
                            <th className="py-3 px-4 font-semibold text-right">Aksi</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-[#E5EAF0]">
                          {filteredSupervisors.map((sup) => (
                            <tr key={sup.id} className="hover:bg-[#F5F7FA]/60">
                              <td className="py-3 px-4 font-semibold text-[#172B4D]">{sup.nama_lengkap}</td>
                              <td className="py-3 px-4 font-mono-tabular text-[#718096]">
                                {sup.nip_nuptk || '-'}
                              </td>
                              <td className="py-3 px-4 font-mono-tabular font-bold text-[#087F5B]">
                                {sup.kode_verifikasi || '-'}
                              </td>
                              <td className="py-3 px-4">
                                {sup.username ? (
                                  <span className="font-mono-tabular text-[#172B4D]">@{sup.username}</span>
                                ) : (
                                  <span className="text-[#718096]">Belum registrasi</span>
                                )}
                              </td>
                              <td className="py-3 px-4">
                                <StatusBadge tone={sup.status === 'active' ? 'emerald' : 'rose'}>
                                  {sup.status === 'active' ? 'Aktif' : 'Nonaktif'}
                                </StatusBadge>
                              </td>
                              <td className="py-3 px-4 text-right space-x-2 whitespace-nowrap">
                                {sup.user_id && (
                                  <button
                                    type="button"
                                    onClick={() => setResetSupModal({ id: sup.id, nama: sup.nama_lengkap })}
                                    className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-[#E5EAF0] bg-white hover:bg-[#F5F7FA] font-semibold"
                                  >
                                    <KeyRound className="w-3 h-3 text-[#C9A45C]" />
                                    Reset Password
                                  </button>
                                )}
                                <button
                                  type="button"
                                  onClick={async () => {
                                    await apiFetch(`/api/admin/supervisors/${sup.id}/toggle-status`, {
                                      method: 'POST',
                                    });
                                    loadSectionData();
                                  }}
                                  className="px-2.5 py-1.5 rounded-lg border border-[#E5EAF0] bg-white hover:bg-[#F5F7FA] font-semibold"
                                >
                                  {sup.status === 'active' ? 'Nonaktifkan' : 'Aktifkan'}
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}

              {/* 7. LAPORAN & VERIFIKASI (FR-MON-03) */}
              {section === 'laporan' && (
                <div className="bg-white border border-[#E5EAF0] rounded-xl overflow-hidden shadow-card">
                  <div className="p-4 sm:p-5 border-b border-[#E5EAF0]">
                    <h2 className="font-display text-sm font-bold text-[#10243A]">
                      Verifikasi Berita Acara & Daftar Hadir Pengawas
                    </h2>
                  </div>
                  {filteredReports.length === 0 ? (
                    <EmptyState
                      icon={<FileCheck2 className="w-6 h-6" />}
                      title="Belum Ada Berkas Laporan"
                      description="Berita Acara dan Daftar Hadir yang dikirim oleh pengawas ruang akan muncul di sini untuk diverifikasi."
                    />
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-left border-collapse text-xs">
                        <thead>
                          <tr className="bg-[#F5F7FA] border-b border-[#E5EAF0] text-[#718096]">
                            <th className="py-3 px-4 font-semibold">Ruang & Mapel</th>
                            <th className="py-3 px-4 font-semibold">Jenis Berkas</th>
                            <th className="py-3 px-4 font-semibold">Pengirim</th>
                            <th className="py-3 px-4 font-semibold">Dikirim (WIB)</th>
                            <th className="py-3 px-4 font-semibold">Status</th>
                            <th className="py-3 px-4 font-semibold text-right">Aksi</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-[#E5EAF0]">
                          {filteredReports.map((rep) => (
                            <tr key={String(rep.id)} className="hover:bg-[#F5F7FA]/60">
                              <td className="py-3 px-4 font-semibold text-[#10243A]">
                                {String(rep.room_kode)} · {String(rep.subject_nama)}
                              </td>
                              <td className="py-3 px-4">
                                {rep.jenis === 'berita_acara' ? 'Berita Acara' : 'Daftar Hadir'} (v{String(rep.version)})
                              </td>
                              <td className="py-3 px-4">{String(rep.supervisor_nama)}</td>
                              <td className="py-3 px-4 font-mono-tabular text-[#718096]">
                                {String(rep.dikirim_pada || '-')}
                              </td>
                              <td className="py-3 px-4">{reportStatusBadge(String(rep.status))}</td>
                              <td className="py-3 px-4 text-right space-x-2 whitespace-nowrap">
                                {Boolean(rep.file_path) && (
                                  <button
                                    type="button"
                                    onClick={() =>
                                      downloadAuthenticatedFile(
                                        String(rep.file_path),
                                        `Daftar_Hadir_${rep.room_kode}.pdf`
                                      )
                                    }
                                    className="px-2.5 py-1.5 rounded-lg border border-[#E5EAF0] hover:bg-[#F5F7FA] font-semibold"
                                  >
                                    Unduh Berkas
                                  </button>
                                )}
                                <button
                                  type="button"
                                  onClick={() => setVerifyModalReport(rep)}
                                  className="px-3 py-1.5 rounded-lg bg-[#087F5B] hover:bg-[#06694b] text-white font-semibold"
                                >
                                  Tinjau & Verifikasi
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}

              {/* 8. NOTIFIKASI */}
              {section === 'notifikasi' && (
                <div className="bg-white border border-[#E5EAF0] rounded-xl overflow-hidden shadow-card">
                  <div className="p-4 sm:p-5 border-b border-[#E5EAF0] flex items-center justify-between">
                    <h2 className="font-display text-sm font-bold text-[#10243A]">Pusat Notifikasi Panitia</h2>
                    {notifications.length > 0 && (
                      <button
                        type="button"
                        onClick={async () => {
                          await apiFetch('/api/notifications/read-all', { method: 'POST' });
                          loadSectionData();
                        }}
                        className="text-xs font-semibold text-[#087F5B] hover:underline"
                      >
                        Tandai semua dibaca
                      </button>
                    )}
                  </div>
                  {notifications.length === 0 ? (
                    <EmptyState
                      icon={<Inbox className="w-6 h-6" />}
                      title="Tidak Ada Notifikasi"
                      description="Notifikasi laporan baru dan peringatan tingkat 3 dari ruang ujian akan tampil di sini."
                    />
                  ) : (
                    <div className="divide-y divide-[#E5EAF0]">
                      {notifications.map((n) => (
                        <div
                          key={n.id}
                          className={`p-4 sm:p-5 space-y-1 ${n.dibaca === 0 ? 'bg-[#E8F5EF]/45' : ''}`}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <p className="text-sm font-bold text-[#172B4D]">{n.judul}</p>
                            <span className="text-xs font-mono-tabular text-[#718096]">{n.dibuat_pada}</span>
                          </div>
                          <p className="text-sm text-[#172B4D]/85">{n.isi}</p>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* 9. AUDIT LOG (BR-17, AC-MON-02/03) */}
              {section === 'audit' && (
                <div className="bg-white border border-[#E5EAF0] rounded-xl overflow-hidden shadow-card">
                  <div className="p-4 sm:p-5 border-b border-[#E5EAF0] flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <h2 className="font-display text-sm font-bold text-[#10243A]">
                        Jejak Audit Sistem (Append-Only)
                      </h2>
                      <p className="text-xs text-[#718096]">
                        Seluruh tindakan kritis tercatat permanen dengan waktu server WIB dan tidak dapat diubah atau dihapus.
                      </p>
                    </div>
                    <div className="relative">
                      <Search className="w-4 h-4 text-[#718096] absolute left-3 top-1/2 -translate-y-1/2" />
                      <input
                        type="text"
                        value={auditQuery}
                        onChange={(e) => setAuditQuery(e.target.value)}
                        placeholder="Cari aksi, entitas, atau pelaku..."
                        className="pl-9 pr-3 py-2 rounded-xl border border-[#E5EAF0] bg-[#F5F7FA] text-xs min-h-[38px]"
                      />
                    </div>
                  </div>
                  {auditLogs.length === 0 ? (
                    <EmptyState
                      icon={<ScrollText className="w-6 h-6" />}
                      title="Tidak Ada Catatan Audit"
                      description="Belum ada log yang cocok dengan filter pencarian saat ini."
                    />
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-left border-collapse text-xs">
                        <thead>
                          <tr className="bg-[#F5F7FA] border-b border-[#E5EAF0] text-[#718096]">
                            <th className="py-3 px-4 font-semibold">Waktu Server (WIB)</th>
                            <th className="py-3 px-4 font-semibold">Pelaku</th>
                            <th className="py-3 px-4 font-semibold">Aksi</th>
                            <th className="py-3 px-4 font-semibold">Entitas</th>
                            <th className="py-3 px-4 font-semibold">Detail</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-[#E5EAF0]">
                          {auditLogs.map((log) => (
                            <tr key={log.id} className="hover:bg-[#F5F7FA]/60">
                              <td className="py-2.5 px-4 font-mono-tabular whitespace-nowrap text-[#718096]">
                                {log.waktu_server}
                              </td>
                              <td className="py-2.5 px-4 font-semibold text-[#172B4D]">
                                {log.username || '-'}
                              </td>
                              <td className="py-2.5 px-4 font-mono-tabular font-bold text-[#087F5B]">
                                {log.aksi}
                              </td>
                              <td className="py-2.5 px-4 font-mono-tabular">
                                {log.entitas} {log.entitas_id ? `#${log.entitas_id}` : ''}
                              </td>
                              <td className="py-2.5 px-4 text-[#718096] max-w-md truncate">
                                {log.nilai_baru || '-'}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </main>
      </div>

      {/* Assign Supervisor Modal */}
      {assignModalScheduleId !== null && (
        <div className="fixed inset-0 z-50 bg-[#10243A]/60 backdrop-blur-xs flex items-center justify-center p-4">
          <form
            onSubmit={handleAssignSupervisor}
            className="bg-white rounded-2xl border border-[#E5EAF0] max-w-md w-full p-6 space-y-4 shadow-elevated"
          >
            <h3 className="font-display text-base font-bold text-[#10243A]">Tugaskan Pengawas Ruang</h3>
            <div>
              <label className="block text-xs font-semibold text-[#172B4D] mb-1.5">Pilih Pengawas</label>
              <select
                required
                value={assignSupId}
                onChange={(e) => setAssignSupId(e.target.value ? Number(e.target.value) : '')}
                className="w-full px-3.5 py-2.5 rounded-xl border border-[#E5EAF0] text-sm bg-white min-h-[44px]"
              >
                <option value="">-- Pilih pengawas --</option>
                {supervisors
                  .filter((s) => s.status === 'active')
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.nama_lengkap}
                    </option>
                  ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-semibold text-[#172B4D] mb-1.5">Peran</label>
              <select
                value={assignPeran}
                onChange={(e) => setAssignPeran(e.target.value as 'utama' | 'pendamping')}
                className="w-full px-3.5 py-2.5 rounded-xl border border-[#E5EAF0] text-sm bg-white min-h-[44px]"
              >
                <option value="utama">Pengawas Utama</option>
                <option value="pendamping">Pengawas Pendamping</option>
              </select>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setAssignModalScheduleId(null)}
                className="px-4 py-2 rounded-xl border border-[#E5EAF0] text-xs font-semibold text-[#172B4D]"
              >
                Batal
              </button>
              <button
                type="submit"
                className="px-4 py-2 rounded-xl bg-[#087F5B] text-white text-xs font-semibold"
              >
                Simpan Penugasan
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Reset Password Modal */}
      {resetSupModal && (
        <div className="fixed inset-0 z-50 bg-[#10243A]/60 backdrop-blur-xs flex items-center justify-center p-4">
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              await apiFetch(`/api/admin/supervisors/${resetSupModal.id}/reset-password`, {
                method: 'POST',
                body: JSON.stringify({ newPassword: resetNewPass }),
              });
              setToast({
                message: `Password untuk ${resetSupModal.nama} berhasil direset.`,
                type: 'success',
              });
              setResetSupModal(null);
              setResetNewPass('');
            }}
            className="bg-white rounded-2xl border border-[#E5EAF0] max-w-md w-full p-6 space-y-4 shadow-elevated"
          >
            <h3 className="font-display text-base font-bold text-[#10243A]">
              Reset Password: {resetSupModal.nama}
            </h3>
            <input
              type="password"
              required
              minLength={8}
              value={resetNewPass}
              onChange={(e) => setResetNewPass(e.target.value)}
              placeholder="Password baru (min. 8 karakter)"
              className="w-full px-3.5 py-2.5 rounded-xl border border-[#E5EAF0] text-sm min-h-[44px]"
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setResetSupModal(null)}
                className="px-4 py-2 rounded-xl border border-[#E5EAF0] text-xs font-semibold"
              >
                Batal
              </button>
              <button type="submit" className="px-4 py-2 rounded-xl bg-[#087F5B] text-white text-xs font-semibold">
                Simpan Password Baru
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Verify Report Modal */}
      {verifyModalReport && (
        <div className="fixed inset-0 z-50 bg-[#10243A]/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl border border-[#E5EAF0] max-w-lg w-full p-6 space-y-4 shadow-elevated">
            <h3 className="font-display text-base font-bold text-[#10243A]">
              Verifikasi Berkas Pengawasan ({String(verifyModalReport.room_kode)})
            </h3>
            {Boolean(verifyModalReport.data_json) && (
              <pre className="p-3.5 rounded-xl bg-[#F5F7FA] border border-[#E5EAF0] text-xs overflow-x-auto max-h-48">
                {JSON.stringify(
                  (() => {
                    const parsed = JSON.parse(String(verifyModalReport.data_json)) as Record<string, unknown>;
                    const { ttd_url: _omit, ...rest } = parsed;
                    return rest;
                  })(),
                  null,
                  2
                )}
              </pre>
            )}
            <div>
              <label className="block text-xs font-semibold text-[#172B4D] mb-1.5">
                Catatan Verifikasi (wajib diisi jika meminta perbaikan)
              </label>
              <textarea
                rows={3}
                value={verifyNote}
                onChange={(e) => setVerifyNote(e.target.value)}
                className="w-full px-3.5 py-2.5 rounded-xl border border-[#E5EAF0] text-sm"
                placeholder="Catatan untuk pengawas..."
              />
            </div>
            <div className="flex flex-wrap justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setVerifyModalReport(null)}
                className="px-4 py-2 rounded-xl border border-[#E5EAF0] text-xs font-semibold"
              >
                Tutup
              </button>
              <button
                type="button"
                onClick={() => handleVerifyReport('perlu_perbaikan')}
                className="px-4 py-2 rounded-xl border border-amber-400 bg-amber-50 text-amber-900 text-xs font-semibold"
              >
                Minta Perbaikan
              </button>
              <button
                type="button"
                onClick={() => handleVerifyReport('terverifikasi')}
                className="px-4 py-2 rounded-xl bg-[#087F5B] text-white text-xs font-semibold inline-flex items-center gap-1.5"
              >
                <CheckCircle2 className="w-3.5 h-3.5" />
                Setujui (Terverifikasi)
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Document Viewer Modal */}
      {previewDoc && docDataset && (
        <DocumentViewerModal
          docKey={previewDoc.key}
          title={previewDoc.title}
          version={previewDoc.version}
          dataset={docDataset}
          onClose={() => setPreviewDoc(null)}
        />
      )}

      <ToastNotification
        message={toast?.message || null}
        type={toast?.type || 'success'}
        onDismiss={() => setToast(null)}
      />
    </div>
  );
};
