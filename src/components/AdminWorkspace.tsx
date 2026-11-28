import React, { useCallback, useEffect, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  BarChart3,
  Bell,
  Building2,
  Calendar,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  Clock,
  Download,
  Eye,
  FileCheck2,
  FileSpreadsheet,
  FileText,
  Filter,
  FolderArchive,
  GraduationCap,
  Inbox,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Pencil,
  Plus,
  RefreshCw,
  ScrollText,
  Search,
  ShieldCheck,
  Trash2,
  Upload,
  UserCheck,
  Users,
  X,
} from 'lucide-react';
import { apiFetch, downloadAuthenticatedFile } from '../lib/api.ts';
import {
  generateAdminDocumentPdf,
  generateRecapPdf,
  generateStudentsPdf,
  type DocDataset,
} from '../lib/pdfGenerator.ts';
import type {
  AuditLogRecord,
  AuthUser,
  ChecklistDocStatus,
  DocumentChecklistItem,
  ExamRecord,
  ImportBatchRecord,
  ImportDocType,
  ImportPageLog,
  ImportSummaryReport,
  NotificationRecord,
  RoomRecord,
  StudentRecord,
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
  onUserUpdated: (user: AuthUser) => void;
}

type AdminSection =
  | 'monitoring'
  | 'impor'
  | 'peserta'
  | 'dokumen'
  | 'jadwal'
  | 'ruang'
  | 'pengawas'
  | 'laporan'
  | 'notifikasi'
  | 'audit';

const DOC_TYPE_LABELS: Record<ImportDocType, string> = {
  data_peserta: 'Data Peserta / DNPU',
  data_pengawas: 'Data Pengawas',
  jadwal_ujian: 'Jadwal Ujian',
  jadwal_pengawasan: 'Jadwal Pengawasan',
  pembagian_ruang: 'Pembagian Ruang',
  denah_peserta: 'Denah Peserta',
  daftar_hadir_peserta: 'Daftar Hadir Peserta',
  denah_lingkungan: 'Denah Lingkungan Ujian',
  dokumen_pendukung: 'Dokumen Pendukung Lainnya',
};

const IMPORT_STAGES: Array<{
  stageKey: ImportDocType;
  stepNo: number;
  title: string;
  subtitle: string;
  hasTemplate: boolean;
}> = [
  {
    stageKey: 'data_peserta',
    stepNo: 1,
    title: 'Data Peserta / DNPU',
    subtitle:
      'Sheet "Data Peserta" (13 kolom: No, NISN, NIS, Nama Lengkap, JK, Kelas, Nomor Peserta, User Ujian, Password Ujian, Sesi, Ruang, Meja, Status)',
    hasTemplate: true,
  },
  {
    stageKey: 'data_pengawas',
    stepNo: 2,
    title: 'Data Pengawas',
    subtitle: 'Daftar pengawas ruang ujian (Nama Lengkap, NIP/NUPTK, WhatsApp, Kode Verifikasi)',
    hasTemplate: true,
  },
  {
    stageKey: 'denah_peserta',
    stepNo: 3,
    title: 'Denah Peserta',
    subtitle: 'Pembagian ruang dan posisi kursi peserta (Kode Ruang, Kode Kursi, Baris, Kolom, Nomor Peserta)',
    hasTemplate: true,
  },
  {
    stageKey: 'jadwal_pengawasan',
    stepNo: 4,
    title: 'Jadwal Pengawasan',
    subtitle: 'Jadwal sesi ujian, mata pelajaran, ruang, serta pengawas utama & pendamping',
    hasTemplate: true,
  },
  {
    stageKey: 'dokumen_pendukung',
    stepNo: 5,
    title: 'Dokumen Pendukung Lainnya',
    subtitle: 'SK Panitia, tata tertib, atau arsip pendukung lainnya (disimpan permanen tanpa fabrikasi baris)',
    hasTemplate: false,
  },
];

const DNPU_KEY_ORDER = [
  'no_urut',
  'nisn',
  'nis',
  'nama',
  'jk',
  'kelas',
  'nomor_peserta',
  'user_ujian',
  'password_ujian',
  'sesi',
  'ruang',
  'meja',
  'status',
];

const FIELD_LABELS: Record<string, string> = {
  no_urut: 'No',
  nisn: 'NISN',
  nis: 'NIS',
  nama: 'Nama Lengkap',
  jk: 'JK',
  kelas: 'Kelas',
  nomor_peserta: 'Nomor Peserta',
  user_ujian: 'User Ujian',
  password_ujian: 'Password Ujian',
  sesi: 'Sesi',
  ruang: 'Ruang',
  meja: 'Meja',
  status: 'Status',
  nama_lengkap: 'Nama Lengkap',
  nip_nuptk: 'NIP / NUPTK',
  whatsapp: 'WhatsApp',
  kode_verifikasi: 'Kode Verifikasi',
  kode_ruang: 'Kode Ruang',
  nama_ruang: 'Nama Ruang',
  kode_kursi: 'Kode Kursi',
  baris: 'Baris',
  kolom: 'Kolom',
  nama_sesi: 'Sesi',
  tanggal: 'Tanggal',
  jam_mulai: 'Jam Mulai',
  jam_selesai: 'Jam Selesai',
  kode_mapel: 'Kode Mapel',
  mata_pelajaran: 'Mata Pelajaran',
  pengawas_utama: 'Pengawas Utama',
  pengawas_pendamping: 'Pengawas Pendamping',
};

export const AdminWorkspace: React.FC<AdminWorkspaceProps> = ({
  user,
  onLogout,
  onUserUpdated,
}) => {
  const wibClock = useServerWibClock();
  const [section, setSection] = useState<AdminSection>('monitoring');
  const [monitoringRoomId, setMonitoringRoomId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [headerSearch, setHeaderSearch] = useState('');
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' | 'info' } | null>(
    null
  );

  // Forced/manual password change modal state
  const [showChangePassModal, setShowChangePassModal] = useState(Boolean(user.mustChangePassword));
  const [currPassInput, setCurrPassInput] = useState('');
  const [newPassInput, setNewPassInput] = useState('');
  const [confirmPassInput, setConfirmPassInput] = useState('');
  const [changePassError, setChangePassError] = useState<string | null>(null);
  const [changingPass, setChangingPass] = useState(false);

  useEffect(() => {
    if (user.mustChangePassword) {
      setShowChangePassModal(true);
    }
  }, [user.mustChangePassword]);

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

  // Import states (staged)
  const [batches, setBatches] = useState<Array<Record<string, unknown>>>([]);
  const [checklist, setChecklist] = useState<DocumentChecklistItem[]>([]);
  const [checklistReady, setChecklistReady] = useState(false);
  const [stageFiles, setStageFiles] = useState<Partial<Record<ImportDocType, File | null>>>({});
  const [processingStage, setProcessingStage] = useState<ImportDocType | null>(null);
  const [stageError, setStageError] = useState<{
    stageKey: ImportDocType;
    message: string;
    pageLogs?: ImportPageLog[];
  } | null>(null);
  const [activeBatch, setActiveBatch] = useState<ImportBatchRecord | null>(null);
  const [previewPage, setPreviewPage] = useState(1);
  const [confirmingBatch, setConfirmingBatch] = useState(false);
  const [lastImportResult, setLastImportResult] = useState<{
    filename: string;
    docType: ImportDocType;
    summary: ImportSummaryReport;
  } | null>(null);
  const [issuesModalReport, setIssuesModalReport] = useState<{
    title: string;
    reasons: Array<{ rowIndex: number; field?: string; value?: string; reason: string }>;
  } | null>(null);
  const [uploadingImport, setUploadingImport] = useState(false);
  const [blobNotice, setBlobNotice] = useState<string | null>(null);
  const [resetTrialModal, setResetTrialModal] = useState<{
    summary: Record<string, number>;
    confirmText: string;
    includeSupervisorAccounts: boolean;
    resetting: boolean;
  } | null>(null);

  // Data Peserta states
  const [studentsData, setStudentsData] = useState<{
    items: StudentRecord[];
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
    filterOptions: {
      kelasList: string[];
      sesiList: string[];
      ruangList: string[];
      statusList: string[];
    };
  }>({
    items: [],
    total: 0,
    page: 1,
    pageSize: 25,
    totalPages: 1,
    filterOptions: { kelasList: [], sesiList: [], ruangList: [], statusList: ['Aktif'] },
  });
  const [studentQuery, setStudentQuery] = useState('');
  const [studentKelasFilter, setStudentKelasFilter] = useState('');
  const [studentSesiFilter, setStudentSesiFilter] = useState('');
  const [studentRuangFilter, setStudentRuangFilter] = useState('');
  const [studentStatusFilter, setStudentStatusFilter] = useState('');
  const [studentPage, setStudentPage] = useState(1);
  const [studentPageSize, setStudentPageSize] = useState(25);
  const [detailStudent, setDetailStudent] = useState<StudentRecord | null>(null);
  const [editStudentModal, setEditStudentModal] = useState<{
    mode: 'create' | 'edit';
    form: Partial<StudentRecord>;
  } | null>(null);
  const [savingStudent, setSavingStudent] = useState(false);
  const [deleteStudentTarget, setDeleteStudentTarget] = useState<StudentRecord | null>(null);

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

  const buildStudentQueryParams = useCallback(
    (overrideAll = false) => {
      const sp = new URLSearchParams();
      if (studentQuery.trim()) sp.set('q', studentQuery.trim());
      if (studentKelasFilter) sp.set('kelas', studentKelasFilter);
      if (studentSesiFilter) sp.set('sesi', studentSesiFilter);
      if (studentRuangFilter) sp.set('ruang', studentRuangFilter);
      if (studentStatusFilter) sp.set('status', studentStatusFilter);
      if (overrideAll) {
        sp.set('all', '1');
      } else {
        sp.set('page', String(studentPage));
        sp.set('pageSize', String(studentPageSize));
      }
      return sp.toString();
    },
    [
      studentQuery,
      studentKelasFilter,
      studentSesiFilter,
      studentRuangFilter,
      studentStatusFilter,
      studentPage,
      studentPageSize,
    ]
  );

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
        const [b, cl] = await Promise.all([
          apiFetch<Array<Record<string, unknown>>>('/api/admin/import/batches'),
          apiFetch<{ checklist: DocumentChecklistItem[]; overallReady: boolean }>(
            '/api/admin/import/checklist'
          ),
        ]);
        setBatches(b);
        setChecklist(cl.checklist);
        setChecklistReady(cl.overallReady);
      }
      if (section === 'peserta') {
        const res = await apiFetch<typeof studentsData>(
          `/api/admin/students?${buildStudentQueryParams(false)}`
        );
        setStudentsData(res);
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
  }, [section, auditQuery, buildStudentQueryParams]);

  const prevLevel3CountRef = React.useRef<number | null>(null);

  useEffect(() => {
    const currentCount = monitoring?.summary?.level3Count;
    if (typeof currentCount === 'number') {
      if (prevLevel3CountRef.current !== null && currentCount > prevLevel3CountRef.current) {
        setToast({
          message:
            'Peringatan Tingkat 3 baru dilaporkan dari ruang ujian! Periksa panel Peringatan Peserta.',
          type: 'error',
        });
      }
      prevLevel3CountRef.current = currentCount;
    }
  }, [monitoring?.summary?.level3Count]);

  useEffect(() => {
    apiFetch<{ blobConfigured?: boolean; blobNotice?: string | null }>('/api/health')
      .then((res) => {
        setBlobNotice(res.blobConfigured === false ? res.blobNotice || null : null);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    loadSectionData();
    const poll = () => {
      if (typeof document !== 'undefined' && document.hidden) return;
      loadSectionData();
    };
    const intervalId = setInterval(poll, 10_000);
    const onFocus = () => {
      if (typeof document === 'undefined' || !document.hidden) {
        loadSectionData();
      }
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      clearInterval(intervalId);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
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

  const handleStageUploadProcess = async (stageKey: ImportDocType) => {
    const file = stageFiles[stageKey];
    if (!file) {
      setToast({ message: `Pilih berkas untuk tahap ${DOC_TYPE_LABELS[stageKey]} terlebih dahulu.`, type: 'error' });
      return;
    }
    setProcessingStage(stageKey);
    setUploadingImport(true);
    setStageError(null);
    setLastImportResult(null);
    try {
      const form = new FormData();
      form.append('targetType', stageKey);
      form.append('file', file);
      const batch = await apiFetch<ImportBatchRecord>('/api/admin/import/upload', {
        method: 'POST',
        body: form,
      });
      setActiveBatch(batch);
      setPreviewPage(1);
      setStageFiles((prev) => ({ ...prev, [stageKey]: null }));
      const rowCount = batch.extracted_rows.length;
      setToast({
        message:
          batch.detected_type === 'dokumen_pendukung'
            ? `Berkas "${file.name}" diarsipkan untuk konfirmasi.`
            : `Berkas "${file.name}" terbaca (${rowCount} baris). Silakan periksa pratinjau lalu klik KONFIRMASI SIMPAN.`,
        type: 'success',
      });
      await loadSectionData();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Gagal mengunggah dan memproses dokumen.';
      setStageError({ stageKey, message: msg });
      setToast({ message: msg, type: 'error' });
      await loadSectionData();
    } finally {
      setProcessingStage(null);
      setUploadingImport(false);
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

  const handleOpenResetTrialModal = async () => {
    try {
      const summary = await apiFetch<Record<string, number>>('/api/admin/import/trial-data-summary');
      setResetTrialModal({
        summary,
        confirmText: '',
        includeSupervisorAccounts: false,
        resetting: false,
      });
    } catch (err) {
      setToast({
        message: err instanceof Error ? err.message : 'Gagal memuat ringkasan data uji coba.',
        type: 'error',
      });
    }
  };

  const handleConfirmResetTrialData = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!resetTrialModal) return;
    setResetTrialModal({ ...resetTrialModal, resetting: true });
    try {
      const res = await apiFetch<{ ok: boolean; cleared: Record<string, number> }>(
        '/api/admin/import/reset-trial-data',
        {
          method: 'POST',
          body: JSON.stringify({
            confirmationText: resetTrialModal.confirmText,
            includeSupervisorAccounts: resetTrialModal.includeSupervisorAccounts,
          }),
        }
      );
      setResetTrialModal(null);
      setActiveBatch(null);
      setLastImportResult(null);
      setStageError(null);
      setStageFiles({});
      setToast({
        message: `Data uji coba berhasil dibersihkan (${res.cleared.students ?? 0} peserta, ${res.cleared.batches ?? 0} riwayat impor, ${res.cleared.schedules ?? 0} jadwal). Silakan impor ulang dokumen SAUM.`,
        type: 'success',
      });
      await loadSectionData();
    } catch (err) {
      setResetTrialModal((prev) => (prev ? { ...prev, resetting: false } : null));
      setToast({
        message: err instanceof Error ? err.message : 'Gagal membersihkan data uji coba.',
        type: 'error',
      });
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
        row_issues?: ImportBatchRecord['row_issues'];
        summary?: ImportSummaryReport;
      }>(`/api/admin/import/${activeBatch.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          detected_type: activeBatch.detected_type,
          extracted_rows: activeBatch.extracted_rows,
        }),
      });
      setActiveBatch({ ...activeBatch, ...updated });
      setToast({ message: 'Koreksi pratinjau disimpan dan validasi ulang selesai.', type: 'success' });
      await loadSectionData();
    } catch (err) {
      setToast({
        message: err instanceof Error ? err.message : 'Gagal menyimpan koreksi.',
        type: 'error',
      });
    }
  };

  const handleConfirmBatch = async () => {
    if (!activeBatch) return;
    setConfirmingBatch(true);
    try {
      const res = await apiFetch<ImportSummaryReport & { ok: boolean }>(
        `/api/admin/import/${activeBatch.id}/confirm`,
        {
          method: 'POST',
          body: JSON.stringify({
            detected_type: activeBatch.detected_type,
            extracted_rows: activeBatch.extracted_rows,
          }),
        }
      );
      setLastImportResult({
        filename: activeBatch.filename,
        docType: activeBatch.detected_type,
        summary: res,
      });
      const hasIssues = res.failedCount > 0 || res.duplicatesCount > 0;
      const zeroSaved =
        activeBatch.detected_type !== 'dokumen_pendukung' &&
        res.inserted + res.updated + res.unchanged === 0;
      if (zeroSaved) {
        setToast({
          message: `Konfirmasi selesai, namun 0 data tersimpan (${res.failedCount} gagal, ${res.duplicatesCount} duplikat). Periksa detail baris bermasalah.`,
          type: 'error',
        });
      } else {
        setToast({
          message: `Impor selesai: ${res.inserted} baru, ${res.updated} diperbarui, ${res.unchanged} tidak berubah${
            hasIssues ? `, ${res.failedCount} gagal, ${res.duplicatesCount} duplikat` : ''
          }.`,
          type: hasIssues ? 'info' : 'success',
        });
      }
      setActiveBatch(null);
      await loadSectionData();
    } catch (err) {
      setToast({
        message: err instanceof Error ? err.message : 'Gagal mengonfirmasi penyimpanan.',
        type: 'error',
      });
    } finally {
      setConfirmingBatch(false);
    }
  };

  const handleSaveStudent = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editStudentModal) return;
    setSavingStudent(true);
    try {
      if (editStudentModal.mode === 'create') {
        await apiFetch('/api/admin/students', {
          method: 'POST',
          body: JSON.stringify(editStudentModal.form),
        });
        setToast({ message: 'Data peserta baru berhasil ditambahkan.', type: 'success' });
      } else if (editStudentModal.form.id) {
        await apiFetch(`/api/admin/students/${editStudentModal.form.id}`, {
          method: 'PUT',
          body: JSON.stringify(editStudentModal.form),
        });
        setToast({ message: 'Data peserta berhasil diperbarui.', type: 'success' });
      }
      setEditStudentModal(null);
      await loadSectionData();
    } catch (err) {
      setToast({
        message: err instanceof Error ? err.message : 'Gagal menyimpan data peserta.',
        type: 'error',
      });
    } finally {
      setSavingStudent(false);
    }
  };

  const handleDeleteStudent = async () => {
    if (!deleteStudentTarget) return;
    try {
      await apiFetch(`/api/admin/students/${deleteStudentTarget.id}`, {
        method: 'DELETE',
      });
      setToast({
        message: `Peserta "${deleteStudentTarget.nama}" telah dihapus.`,
        type: 'success',
      });
      setDeleteStudentTarget(null);
      await loadSectionData();
    } catch (err) {
      setToast({
        message: err instanceof Error ? err.message : 'Gagal menghapus data peserta.',
        type: 'error',
      });
    }
  };

  const handleExportStudentsPdf = async () => {
    try {
      const res = await apiFetch<{ items: StudentRecord[] }>(
        `/api/admin/students?${buildStudentQueryParams(true)}`
      );
      if (res.items.length === 0) {
        setToast({ message: 'Tidak ada data peserta untuk diekspor.', type: 'info' });
        return;
      }
      generateStudentsPdf(res.items);
      setToast({ message: `Ekspor PDF ${res.items.length} data peserta selesai.`, type: 'success' });
    } catch (err) {
      setToast({
        message: err instanceof Error ? err.message : 'Gagal mengekspor PDF peserta.',
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

  const handleChangeOwnPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setChangePassError(null);
    if (newPassInput.length < 8) {
      setChangePassError('Password baru minimal 8 karakter.');
      return;
    }
    if (newPassInput !== confirmPassInput) {
      setChangePassError('Konfirmasi password baru tidak cocok.');
      return;
    }
    setChangingPass(true);
    try {
      const res = await apiFetch<{ ok: boolean; user: AuthUser }>('/api/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({
          currentPassword: currPassInput,
          newPassword: newPassInput,
        }),
      });
      onUserUpdated(res.user);
      setShowChangePassModal(false);
      setCurrPassInput('');
      setNewPassInput('');
      setConfirmPassInput('');
      setToast({
        message: 'Password akun Admin berhasil diperbarui dan dicatat pada audit log.',
        type: 'success',
      });
    } catch (err) {
      setChangePassError(err instanceof Error ? err.message : 'Gagal mengganti password.');
    } finally {
      setChangingPass(false);
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
    { key: 'peserta', label: 'Data Peserta', icon: GraduationCap },
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
      ? (() => {
          const allKeys = Array.from(
            new Set(
              activeBatch.extracted_rows.flatMap((r) => Object.keys(r).filter((k) => !k.startsWith('_')))
            )
          );
          if (
            activeBatch.detected_type === 'data_peserta' ||
            activeBatch.target_type === 'data_peserta'
          ) {
            const ordered = DNPU_KEY_ORDER.filter((k) => allKeys.includes(k));
            const extras = allKeys.filter((k) => !DNPU_KEY_ORDER.includes(k));
            return [...ordered, ...extras];
          }
          return allKeys;
        })()
      : [];

  const PREVIEW_PAGE_SIZE = 30;
  const previewTotalRows = activeBatch?.extracted_rows.length ?? 0;
  const previewTotalPages = Math.max(1, Math.ceil(previewTotalRows / PREVIEW_PAGE_SIZE));
  const safePreviewPage = Math.min(previewPage, previewTotalPages);
  const previewStartIdx = (safePreviewPage - 1) * PREVIEW_PAGE_SIZE;
  const previewRowsSlice = activeBatch
    ? activeBatch.extracted_rows.slice(previewStartIdx, previewStartIdx + PREVIEW_PAGE_SIZE)
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
          <div className="space-y-2">
            <button
              type="button"
              onClick={() => {
                setChangePassError(null);
                setShowChangePassModal(true);
              }}
              className="w-full flex items-center justify-center gap-2 py-2 px-3 rounded-lg border border-white/15 bg-white/5 hover:bg-white/10 text-xs font-medium text-slate-100 min-h-[38px] transition-colors"
            >
              <KeyRound className="w-3.5 h-3.5 text-[#C9A45C]" />
              Ganti Password
            </button>
            <button
              type="button"
              onClick={onLogout}
              className="w-full flex items-center justify-center gap-2 py-2 px-3 rounded-lg border border-white/15 bg-white/5 hover:bg-white/10 text-xs font-medium text-slate-100 min-h-[40px] transition-colors"
            >
              <LogOut className="w-3.5 h-3.5" />
              Keluar Sistem
            </button>
          </div>
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
          {user.mustChangePassword && (
            <div className="bg-amber-50 border border-amber-300 rounded-xl p-4 flex flex-wrap items-center justify-between gap-3 shadow-card">
              <div className="flex items-start gap-3">
                <AlertTriangle className="w-5 h-5 text-amber-700 shrink-0 mt-0.5" />
                <div className="text-xs sm:text-sm text-amber-950">
                  <p className="font-bold">Keamanan Akun: Segera Ganti Password Bawaan Admin</p>
                  <p className="text-amber-900 mt-0.5">
                    Anda masih menggunakan password awal. Demi keamanan data ujian madrasah, ganti password akun Admin sekarang.
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => {
                  setChangePassError(null);
                  setShowChangePassModal(true);
                }}
                className="px-4 py-2 rounded-xl bg-[#10243A] hover:bg-[#1a3554] text-white text-xs font-semibold min-h-[40px] shrink-0"
              >
                Ganti Password Sekarang
              </button>
            </div>
          )}

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

              {/* 2. IMPOR DOKUMEN SAUM BERTAHAP & CHECKLIST KELENGKAPAN (FR-IMP) */}
              {section === 'impor' && (
                <div className="space-y-6">
                  {/* Header + Blob notice */}
                  <div className="bg-white border border-[#E5EAF0] rounded-xl p-5 sm:p-6 space-y-4 shadow-card">
                    <div className="flex flex-wrap items-start justify-between gap-4">
                      <div>
                        <h2 className="font-display text-base font-bold text-[#10243A]">
                          Impor Dokumen Ekspor SAUM (Bertahap Per Jenis Dokumen)
                        </h2>
                        <p className="text-xs sm:text-sm text-[#718096] mt-1">
                          Unggah dan proses satu per satu sesuai jenis dokumen SAUM. Mendukung XLSX, CSV, PDF teks, PDF scan OCR, dan gambar (PNG/JPG). Sel yang tidak terbaca ditandai dan tidak ditebak otomatis.
                        </p>
                      </div>
                      <div className="flex flex-wrap items-center gap-2 shrink-0">
                        <button
                          type="button"
                          disabled={uploadingImport}
                          onClick={handleLoadSampleSaum}
                          className="px-4 py-2.5 rounded-xl border border-[#087F5B] bg-[#E8F5EF] hover:bg-[#d3eee1] text-[#087F5B] text-xs font-bold min-h-[42px] transition-colors"
                        >
                          Muat Paket Sampel SAUM (Siap Uji)
                        </button>
                        <button
                          type="button"
                          disabled={uploadingImport}
                          onClick={handleOpenResetTrialModal}
                          className="px-4 py-2.5 rounded-xl border border-rose-300 bg-rose-50 hover:bg-rose-100 text-rose-800 text-xs font-bold min-h-[42px] transition-colors inline-flex items-center gap-1.5"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                          Bersihkan Data Uji Coba
                        </button>
                      </div>
                    </div>

                    {blobNotice && (
                      <div className="p-3.5 rounded-xl bg-amber-50 border border-amber-200 text-xs text-amber-900 flex items-start gap-2.5">
                        <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-amber-700" />
                        <span>{blobNotice}</span>
                      </div>
                    )}
                  </div>

                  {/* Checklist Kelengkapan Dokumen */}
                  <div className="bg-white border border-[#E5EAF0] rounded-xl overflow-hidden shadow-card">
                    <div className="p-4 sm:p-5 border-b border-[#E5EAF0] flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <h3 className="font-display text-sm font-bold text-[#10243A] flex items-center gap-2">
                          <FileCheck2 className="w-4 h-4 text-[#087F5B]" />
                          <span>Checklist Kelengkapan Dokumen SAUM</span>
                        </h3>
                        <p className="text-xs text-[#718096] mt-0.5">
                          Pantau status unggah, jumlah baris terbaca, gagal, dan alasan melewati untuk setiap tahapan dokumen.
                        </p>
                      </div>
                      <StatusBadge tone={checklistReady ? 'emerald' : 'amber'}>
                        {checklistReady ? 'Semua Dokumen Wajib Lengkap' : 'Ada Dokumen Belum Lengkap'}
                      </StatusBadge>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-left border-collapse text-xs">
                        <thead>
                          <tr className="bg-[#F5F7FA] border-b border-[#E5EAF0] text-[#718096]">
                            <th className="py-3 px-4 font-semibold">Tahap Dokumen</th>
                            <th className="py-3 px-4 font-semibold">Status</th>
                            <th className="py-3 px-4 font-semibold">File Terakhir</th>
                            <th className="py-3 px-4 font-semibold text-right">Terbaca</th>
                            <th className="py-3 px-4 font-semibold text-right">Gagal / Lewati</th>
                            <th className="py-3 px-4 font-semibold">Keterangan / Alasan</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-[#E5EAF0]">
                          {checklist.map((item) => {
                            const effectiveStatus: ChecklistDocStatus =
                              processingStage === item.stageKey ? 'Sedang Diproses' : item.status;
                            const badgeTone =
                              effectiveStatus === 'Berhasil Diproses'
                                ? 'emerald'
                                : effectiveStatus === 'Berhasil Diunggah'
                                ? 'navy'
                                : effectiveStatus === 'Sedang Diproses'
                                ? 'gold'
                                : effectiveStatus === 'Perlu Pemeriksaan'
                                ? 'amber'
                                : effectiveStatus === 'Gagal Diproses'
                                ? 'rose'
                                : 'slate';
                            return (
                              <tr key={item.stageKey} className="hover:bg-[#F5F7FA]/60">
                                <td className="py-3 px-4 font-semibold text-[#10243A]">
                                  {item.label}{' '}
                                  {item.required && (
                                    <span className="text-[10px] font-bold text-[#087F5B]">(Wajib)</span>
                                  )}
                                </td>
                                <td className="py-3 px-4">
                                  <StatusBadge tone={badgeTone}>{effectiveStatus}</StatusBadge>
                                </td>
                                <td className="py-3 px-4 font-mono-tabular text-[#172B4D]">
                                  {item.filename || '-'}
                                </td>
                                <td className="py-3 px-4 text-right font-mono-tabular font-semibold text-[#087F5B]">
                                  {item.readCount}
                                </td>
                                <td className="py-3 px-4 text-right font-mono-tabular text-rose-700">
                                  {item.failedCount + item.duplicatesCount}
                                </td>
                                <td className="py-3 px-4 text-[#718096] max-w-md">
                                  {item.missingNote ||
                                    (item.skipReasons.length > 0
                                      ? item.skipReasons.slice(0, 2).join('; ')
                                      : item.confirmedAt
                                      ? `Terkonfirmasi (${item.insertedCount} baru, ${item.updatedCount} perbarui, ${item.unchangedCount} tetap)`
                                      : '-')}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  {/* 5 Tahap Unggah Terpisah */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {IMPORT_STAGES.map((stage) => {
                      const clItem = checklist.find((c) => c.stageKey === stage.stageKey);
                      const selectedFile = stageFiles[stage.stageKey] || null;
                      const isProcessing = processingStage === stage.stageKey;
                      const stageStatus: ChecklistDocStatus = isProcessing
                        ? 'Sedang Diproses'
                        : clItem?.status || 'Belum Diunggah';
                      const stageTone =
                        stageStatus === 'Berhasil Diproses'
                          ? 'emerald'
                          : stageStatus === 'Berhasil Diunggah'
                          ? 'navy'
                          : stageStatus === 'Sedang Diproses'
                          ? 'gold'
                          : stageStatus === 'Perlu Pemeriksaan'
                          ? 'amber'
                          : stageStatus === 'Gagal Diproses'
                          ? 'rose'
                          : 'slate';

                      return (
                        <div
                          key={stage.stageKey}
                          className="bg-white border border-[#E5EAF0] rounded-xl p-5 space-y-3.5 shadow-card flex flex-col justify-between"
                        >
                          <div className="space-y-2">
                            <div className="flex items-start justify-between gap-2">
                              <div className="flex items-center gap-2.5">
                                <span className="w-7 h-7 rounded-lg bg-[#10243A] text-white text-xs font-mono-tabular font-bold flex items-center justify-center shrink-0">
                                  {stage.stepNo}
                                </span>
                                <h3 className="font-display text-sm font-bold text-[#10243A]">
                                  {stage.title}
                                </h3>
                              </div>
                              <StatusBadge tone={stageTone}>{stageStatus}</StatusBadge>
                            </div>
                            <p className="text-xs text-[#718096] leading-relaxed">{stage.subtitle}</p>
                          </div>

                          <div className="space-y-2.5 pt-1">
                            <label className="block border border-dashed border-[#CBD5E1] hover:border-[#087F5B] rounded-xl px-3.5 py-3 bg-[#F5F7FA] cursor-pointer transition-colors">
                              <span className="text-xs font-semibold text-[#172B4D] block truncate">
                                {selectedFile
                                  ? `File dipilih: ${selectedFile.name}`
                                  : 'Pilih file (.xlsx, .csv, .pdf, .png, .jpg)'}
                              </span>
                              <input
                                type="file"
                                accept=".xlsx,.xls,.csv,.pdf,image/png,image/jpeg,image/webp"
                                disabled={uploadingImport}
                                onChange={(e) => {
                                  const f = e.target.files?.[0] || null;
                                  setStageFiles((prev) => ({ ...prev, [stage.stageKey]: f }));
                                  e.target.value = '';
                                }}
                                className="hidden"
                              />
                            </label>

                            <div className="flex flex-wrap items-center justify-between gap-2">
                              {stage.hasTemplate ? (
                                <button
                                  type="button"
                                  onClick={() =>
                                    downloadAuthenticatedFile(
                                      `/api/admin/import/template/${stage.stageKey}`,
                                      `Template_SAUM_${stage.stageKey}.xlsx`
                                    )
                                  }
                                  className="px-3 py-2 rounded-lg border border-[#E5EAF0] bg-white hover:bg-[#F5F7FA] text-[11px] font-semibold text-[#172B4D] inline-flex items-center gap-1.5 min-h-[38px]"
                                >
                                  <Download className="w-3.5 h-3.5 text-[#087F5B]" />
                                  Unduh Template (.xlsx)
                                </button>
                              ) : (
                                <span className="text-[11px] text-[#718096]">Arsip dokumen pendukung</span>
                              )}

                              <button
                                type="button"
                                disabled={!selectedFile || uploadingImport}
                                onClick={() => handleStageUploadProcess(stage.stageKey)}
                                className="px-4 py-2 rounded-xl bg-[#087F5B] hover:bg-[#06694b] disabled:opacity-50 text-white text-xs font-semibold inline-flex items-center gap-1.5 min-h-[38px]"
                              >
                                <Upload className="w-3.5 h-3.5" />
                                {isProcessing ? 'Sedang Diproses...' : 'Unggah & Proses'}
                              </button>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {/* Error detail panel when extraction fails */}
                  {stageError && (
                    <div className="bg-rose-50 border border-rose-200 rounded-xl p-5 space-y-2 text-xs text-rose-900">
                      <div className="flex items-start justify-between gap-3">
                        <p className="font-bold text-sm">
                          Proses Gagal ({DOC_TYPE_LABELS[stageError.stageKey]}): {stageError.message}
                        </p>
                        <button
                          type="button"
                          onClick={() => setStageError(null)}
                          className="text-rose-700 hover:text-rose-950 p-1"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                      <p className="text-rose-800">
                        Dokumen tetap tercatat pada riwayat dengan status Gagal Diproses. Periksa format file, kejelasan scan, atau template kolom sebelum mengunggah ulang.
                      </p>
                    </div>
                  )}

                  {/* Laporan Hasil Impor Terakhir */}
                  {lastImportResult && (
                    <div className="bg-white border border-[#B7E4D0] rounded-xl p-5 sm:p-6 space-y-4 shadow-card">
                      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[#E5EAF0] pb-3">
                        <div>
                          <h3 className="font-display text-base font-bold text-[#10243A]">
                            Laporan Hasil Impor: {lastImportResult.filename}
                          </h3>
                          <p className="text-xs text-[#718096] mt-0.5">
                            Jenis Dokumen: {DOC_TYPE_LABELS[lastImportResult.docType]}
                          </p>
                        </div>
                        <div className="flex items-center gap-2">
                          {lastImportResult.summary.failureReasons.length > 0 && (
                            <button
                              type="button"
                              onClick={() =>
                                setIssuesModalReport({
                                  title: `Detail Baris Bermasalah — ${lastImportResult.filename}`,
                                  reasons: lastImportResult.summary.failureReasons,
                                })
                              }
                              className="px-3.5 py-2 rounded-xl border border-rose-300 bg-rose-50 hover:bg-rose-100 text-rose-800 text-xs font-semibold"
                            >
                              Lihat Detail Baris Bermasalah ({lastImportResult.summary.failureReasons.length})
                            </button>
                          )}
                          {lastImportResult.docType === 'data_peserta' && (
                            <button
                              type="button"
                              onClick={() => setSection('peserta')}
                              className="px-3.5 py-2 rounded-xl bg-[#10243A] text-white text-xs font-semibold"
                            >
                              Buka Menu Data Peserta
                            </button>
                          )}
                        </div>
                      </div>

                      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
                        <div className="p-3 rounded-xl bg-[#F5F7FA] border border-[#E5EAF0]">
                          <p className="text-[11px] text-[#718096]">Total Baris File</p>
                          <p className="text-lg font-mono-tabular font-bold text-[#10243A]">
                            {lastImportResult.summary.totalRows}
                          </p>
                        </div>
                        <div className="p-3 rounded-xl bg-[#E8F5EF] border border-[#B7E4D0]">
                          <p className="text-[11px] text-[#087F5B]">Berhasil Dibaca</p>
                          <p className="text-lg font-mono-tabular font-bold text-[#087F5B]">
                            {lastImportResult.summary.parsedCount}
                          </p>
                        </div>
                        <div className="p-3 rounded-xl bg-[#E8F5EF] border border-[#B7E4D0]">
                          <p className="text-[11px] text-[#087F5B]">Data Baru</p>
                          <p className="text-lg font-mono-tabular font-bold text-[#087F5B]">
                            {lastImportResult.summary.inserted}
                          </p>
                        </div>
                        <div className="p-3 rounded-xl bg-[#10243A]/5 border border-[#10243A]/15">
                          <p className="text-[11px] text-[#10243A]">Diperbarui</p>
                          <p className="text-lg font-mono-tabular font-bold text-[#10243A]">
                            {lastImportResult.summary.updated}
                          </p>
                        </div>
                        <div className="p-3 rounded-xl bg-[#F5F7FA] border border-[#E5EAF0]">
                          <p className="text-[11px] text-[#718096]">Tidak Berubah</p>
                          <p className="text-lg font-mono-tabular font-bold text-[#172B4D]">
                            {lastImportResult.summary.unchanged}
                          </p>
                        </div>
                        <div className="p-3 rounded-xl bg-amber-50 border border-amber-200">
                          <p className="text-[11px] text-amber-800">Duplikat</p>
                          <p className="text-lg font-mono-tabular font-bold text-amber-900">
                            {lastImportResult.summary.duplicatesCount}
                          </p>
                        </div>
                        <div className="p-3 rounded-xl bg-rose-50 border border-rose-200">
                          <p className="text-[11px] text-rose-800">Gagal Validasi</p>
                          <p className="text-lg font-mono-tabular font-bold text-rose-900">
                            {lastImportResult.summary.failedCount}
                          </p>
                        </div>
                      </div>

                      {lastImportResult.summary.archiveOnlyNote && (
                        <p className="text-xs text-[#718096] bg-[#F5F7FA] p-3 rounded-lg border border-[#E5EAF0]">
                          {lastImportResult.summary.archiveOnlyNote}
                        </p>
                      )}
                    </div>
                  )}

                  {/* Pratinjau & Validasi Sebelum KONFIRMASI SIMPAN */}
                  {activeBatch && (
                    <div className="bg-white border border-[#E5EAF0] rounded-xl p-6 space-y-5 shadow-card">
                      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-[#E5EAF0] pb-4">
                        <div>
                          <h3 className="font-display text-base font-bold text-[#10243A]">
                            Pratinjau & Validasi: {activeBatch.filename}
                          </h3>
                          <p className="text-xs text-[#718096] font-mono-tabular mt-0.5">
                            SHA-256: {activeBatch.sha256.slice(0, 20)}... · Total Baris:{' '}
                            {activeBatch.extracted_rows.length} · Keyakinan Klasifikasi:{' '}
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

                      {activeBatch.file_duplicate_warning && (
                        <div className="p-3.5 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-900">
                          <span className="font-semibold">Info Berkas Duplikat: </span>
                          {activeBatch.file_duplicate_warning}
                        </div>
                      )}

                      {activeBatch.summary && (
                        <div className="grid grid-cols-2 sm:grid-cols-6 gap-2.5 text-xs">
                          <div className="p-2.5 rounded-lg bg-[#F5F7FA] border border-[#E5EAF0]">
                            <span className="text-[#718096] block">Total Baris</span>
                            <strong className="font-mono-tabular text-[#10243A] text-sm">
                              {activeBatch.summary.totalRows}
                            </strong>
                          </div>
                          <div className="p-2.5 rounded-lg bg-[#E8F5EF] border border-[#B7E4D0]">
                            <span className="text-[#087F5B] block">Est. Data Baru</span>
                            <strong className="font-mono-tabular text-[#087F5B] text-sm">
                              {activeBatch.summary.inserted}
                            </strong>
                          </div>
                          <div className="p-2.5 rounded-lg bg-[#10243A]/5 border border-[#10243A]/15">
                            <span className="text-[#10243A] block">Est. Diperbarui</span>
                            <strong className="font-mono-tabular text-[#10243A] text-sm">
                              {activeBatch.summary.updated}
                            </strong>
                          </div>
                          <div className="p-2.5 rounded-lg bg-[#F5F7FA] border border-[#E5EAF0]">
                            <span className="text-[#718096] block">Tidak Berubah</span>
                            <strong className="font-mono-tabular text-[#172B4D] text-sm">
                              {activeBatch.summary.unchanged}
                            </strong>
                          </div>
                          <div className="p-2.5 rounded-lg bg-amber-50 border border-amber-200">
                            <span className="text-amber-800 block">Duplikat Internal</span>
                            <strong className="font-mono-tabular text-amber-900 text-sm">
                              {activeBatch.summary.duplicatesCount}
                            </strong>
                          </div>
                          <div className="p-2.5 rounded-lg bg-rose-50 border border-rose-200">
                            <span className="text-rose-800 block">Gagal Validasi</span>
                            <strong className="font-mono-tabular text-rose-900 text-sm">
                              {activeBatch.summary.failedCount}
                            </strong>
                          </div>
                        </div>
                      )}

                      {activeBatch.page_logs && activeBatch.page_logs.length > 0 && (
                        <div className="p-3.5 rounded-lg bg-[#F5F7FA] border border-[#E5EAF0] text-xs space-y-1.5">
                          <p className="font-semibold text-[#10243A]">
                            Log Pembacaan Halaman PDF / Gambar ({activeBatch.page_logs.length} halaman):
                          </p>
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                            {activeBatch.page_logs.map((pl) => (
                              <div
                                key={pl.pageNumber}
                                className={`p-2 rounded-lg border text-[11px] ${
                                  pl.status === 'failed'
                                    ? 'bg-rose-50 border-rose-200 text-rose-900'
                                    : pl.status === 'unmapped'
                                    ? 'bg-amber-50 border-amber-200 text-amber-900'
                                    : 'bg-white border-[#E5EAF0] text-[#172B4D]'
                                }`}
                              >
                                <span className="font-bold">Halaman {pl.pageNumber}</span> ({pl.method}) ·{' '}
                                {pl.rowCount} baris — {pl.message}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {activeBatch.confidence < 0.75 && (
                        <div className="p-3 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-900">
                          Klasifikasi otomatis belum sepenuhnya yakin. Pastikan jenis dokumen di kanan atas sudah sesuai sebelum konfirmasi (FR-IMP-03).
                        </div>
                      )}

                      {activeBatch.unreadable_fields.length > 0 && (
                        <div className="p-3.5 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-950 space-y-1">
                          <div className="flex items-center justify-between gap-2">
                            <p className="font-semibold">
                              Ditemukan {activeBatch.unreadable_fields.length} sel kosong / tidak terbaca (BR-08 — tidak ditebak otomatis):
                            </p>
                            <button
                              type="button"
                              onClick={() =>
                                setIssuesModalReport({
                                  title: `Detail Field Tidak Terbaca — ${activeBatch.filename}`,
                                  reasons: activeBatch.unreadable_fields,
                                })
                              }
                              className="text-amber-900 underline font-semibold"
                            >
                              Lihat Semua
                            </button>
                          </div>
                          <ul className="list-disc pl-4 space-y-0.5">
                            {activeBatch.unreadable_fields.slice(0, 6).map((u, i) => (
                              <li key={i}>
                                {u.rowIndex >= 0 ? `Baris ${u.rowIndex + 1} · ` : ''}
                                Kolom <code>{FIELD_LABELS[u.field] || u.field}</code>: {u.reason}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}

                      {activeBatch.duplicates.length > 0 && (
                        <div className="p-3.5 rounded-lg bg-rose-50 border border-rose-200 text-xs text-rose-900 space-y-1">
                          <p className="font-semibold">Deteksi Duplikasi / Pembaruan ({activeBatch.duplicates.length}):</p>
                          <ul className="list-disc pl-4 space-y-0.5">
                            {activeBatch.duplicates.slice(0, 6).map((d, i) => (
                              <li key={i}>
                                Baris {d.rowIndex + 1} · {FIELD_LABELS[d.field] || d.field} = {d.value} ({d.source})
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}

                      {activeBatch.extracted_rows.length === 0 ? (
                        <div className="p-4 rounded-xl bg-[#F5F7FA] border border-[#E5EAF0] text-xs text-[#718096]">
                          {activeBatch.detected_type === 'dokumen_pendukung'
                            ? 'Dokumen pendukung tersimpan sebagai arsip sumber. Klik KONFIRMASI SIMPAN untuk mencatat status selesai pada checklist.'
                            : 'Tidak ada baris terstruktur yang terbaca.'}
                        </div>
                      ) : (
                        <>
                          <div className="overflow-x-auto border border-[#E5EAF0] rounded-lg max-h-[420px]">
                            <table className="w-full text-left border-collapse text-xs">
                              <thead className="bg-[#F5F7FA] sticky top-0 z-10">
                                <tr>
                                  <th className="py-2.5 px-3 border-b border-[#E5EAF0] font-mono-tabular">#</th>
                                  {batchKeys.map((k) => (
                                    <th key={k} className="py-2.5 px-3 border-b border-[#E5EAF0] font-semibold whitespace-nowrap">
                                      {FIELD_LABELS[k] || k}
                                    </th>
                                  ))}
                                </tr>
                              </thead>
                              <tbody className="divide-y divide-[#E5EAF0]">
                                {previewRowsSlice.map((row, localIdx) => {
                                  const rIdx = previewStartIdx + localIdx;
                                  return (
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
                                              className={`w-full min-w-[105px] px-2 py-1.5 rounded border text-xs ${
                                                isMissing
                                                  ? 'border-amber-400 bg-amber-50'
                                                  : 'border-[#E5EAF0] bg-white'
                                              }`}
                                            />
                                          </td>
                                        );
                                      })}
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </div>

                          {previewTotalPages > 1 && (
                            <div className="flex items-center justify-between text-xs text-[#718096]">
                              <span>
                                Menampilkan baris {previewStartIdx + 1}–
                                {Math.min(previewStartIdx + PREVIEW_PAGE_SIZE, previewTotalRows)} dari{' '}
                                {previewTotalRows} baris
                              </span>
                              <div className="flex items-center gap-1.5">
                                <button
                                  type="button"
                                  disabled={safePreviewPage <= 1}
                                  onClick={() => setPreviewPage((p) => Math.max(1, p - 1))}
                                  className="px-2.5 py-1.5 rounded-lg border border-[#E5EAF0] bg-white disabled:opacity-50"
                                >
                                  Sebelumnya
                                </button>
                                <span className="font-mono-tabular px-2">
                                  Hal. {safePreviewPage} / {previewTotalPages}
                                </span>
                                <button
                                  type="button"
                                  disabled={safePreviewPage >= previewTotalPages}
                                  onClick={() => setPreviewPage((p) => Math.min(previewTotalPages, p + 1))}
                                  className="px-2.5 py-1.5 rounded-lg border border-[#E5EAF0] bg-white disabled:opacity-50"
                                >
                                  Berikutnya
                                </button>
                              </div>
                            </div>
                          )}
                        </>
                      )}

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
                          disabled={confirmingBatch}
                          onClick={handleConfirmBatch}
                          className="px-5 py-2.5 rounded-xl bg-[#087F5B] hover:bg-[#06694b] disabled:opacity-60 text-white text-xs sm:text-sm font-semibold min-h-[44px]"
                        >
                          {confirmingBatch ? 'Menyimpan...' : 'KONFIRMASI SIMPAN'}
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Riwayat Arsip Impor */}
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
                              <th className="py-3 px-4 font-semibold">Tahap / Jenis</th>
                              <th className="py-3 px-4 font-semibold">Ringkasan</th>
                              <th className="py-3 px-4 font-semibold">SHA-256</th>
                              <th className="py-3 px-4 font-semibold">Status</th>
                              <th className="py-3 px-4 font-semibold text-right">Aksi</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-[#E5EAF0]">
                            {batches.map((b) => {
                              const sum = b.summary as ImportSummaryReport | null | undefined;
                              return (
                                <tr key={String(b.id)} className="hover:bg-[#F5F7FA]/60">
                                  <td className="py-3 px-4 font-semibold text-[#172B4D]">{String(b.filename)}</td>
                                  <td className="py-3 px-4">
                                    {DOC_TYPE_LABELS[(b.target_type || b.detected_type) as ImportDocType] ||
                                      String(b.detected_type)}
                                  </td>
                                  <td className="py-3 px-4 font-mono-tabular text-[#718096]">
                                    {sum
                                      ? `${sum.totalRows} baris · +${sum.inserted} / ~${sum.updated} / =${sum.unchanged}`
                                      : '-'}
                                  </td>
                                  <td className="py-3 px-4 font-mono-tabular text-[#718096]">
                                    {String(b.sha256).slice(0, 14)}...
                                  </td>
                                  <td className="py-3 px-4">
                                    <StatusBadge
                                      tone={
                                        b.status === 'confirmed'
                                          ? 'emerald'
                                          : b.status === 'failed'
                                          ? 'rose'
                                          : 'amber'
                                      }
                                    >
                                      {b.status === 'confirmed'
                                        ? 'Terkonfirmasi'
                                        : b.status === 'failed'
                                        ? 'Gagal Diproses'
                                        : 'Pratinjau'}
                                    </StatusBadge>
                                  </td>
                                  <td className="py-3 px-4 text-right space-x-3">
                                    {b.status === 'preview' && (
                                      <button
                                        type="button"
                                        onClick={async () => {
                                          const full = await apiFetch<ImportBatchRecord>(`/api/admin/import/${b.id}`);
                                          setActiveBatch(full);
                                          setPreviewPage(1);
                                        }}
                                        className="text-[#087F5B] font-semibold hover:underline"
                                      >
                                        Lanjutkan Pratinjau
                                      </button>
                                    )}
                                    {sum && sum.failureReasons && sum.failureReasons.length > 0 && (
                                      <button
                                        type="button"
                                        onClick={() =>
                                          setIssuesModalReport({
                                            title: `Detail Baris Bermasalah — ${String(b.filename)}`,
                                            reasons: sum.failureReasons,
                                          })
                                        }
                                        className="text-rose-700 font-semibold hover:underline"
                                      >
                                        Detail Masalah ({sum.failureReasons.length})
                                      </button>
                                    )}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* 2B. DATA PESERTA (DNPU INTERNAL SIPENGUJI) */}
              {section === 'peserta' && (
                <div className="space-y-5">
                  {/* Header & Action Bar */}
                  <div className="bg-white border border-[#E5EAF0] rounded-xl p-5 flex flex-wrap items-center justify-between gap-4 shadow-card">
                    <div>
                      <h2 className="font-display text-base font-bold text-[#10243A]">
                        Data Peserta Ujian (DNPU Terimpor)
                      </h2>
                      <p className="text-xs sm:text-sm text-[#718096] mt-0.5">
                        Menampilkan data peserta yang tersimpan di database internal SIPENGUJI dari hasil impor DNPU SAUM. Total:{' '}
                        <strong className="font-mono-tabular text-[#10243A]">{studentsData.total}</strong> peserta.
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setSection('impor')}
                        className="px-3.5 py-2 rounded-xl border border-[#087F5B] bg-[#E8F5EF] hover:bg-[#d3eee1] text-[#087F5B] text-xs font-semibold inline-flex items-center gap-1.5 min-h-[40px]"
                      >
                        <Upload className="w-3.5 h-3.5" />
                        Impor / Perbarui DNPU
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          setEditStudentModal({
                            mode: 'create',
                            form: { status: 'Aktif', jk: 'L' },
                          })
                        }
                        className="px-3.5 py-2 rounded-xl bg-[#087F5B] hover:bg-[#06694b] text-white text-xs font-semibold inline-flex items-center gap-1.5 min-h-[40px]"
                      >
                        <Plus className="w-3.5 h-3.5" />
                        Tambah Peserta
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          downloadAuthenticatedFile(
                            `/api/admin/students/export/xlsx?${buildStudentQueryParams(true)}`,
                            'Data_Peserta_SIPENGUJI.xlsx'
                          )
                        }
                        className="px-3.5 py-2 rounded-xl border border-[#E5EAF0] bg-white hover:bg-[#F5F7FA] text-[#172B4D] text-xs font-semibold inline-flex items-center gap-1.5 min-h-[40px]"
                      >
                        <FileSpreadsheet className="w-3.5 h-3.5 text-[#087F5B]" />
                        Ekspor Excel
                      </button>
                      <button
                        type="button"
                        onClick={handleExportStudentsPdf}
                        className="px-3.5 py-2 rounded-xl border border-[#E5EAF0] bg-white hover:bg-[#F5F7FA] text-[#172B4D] text-xs font-semibold inline-flex items-center gap-1.5 min-h-[40px]"
                      >
                        <FileText className="w-3.5 h-3.5 text-[#10243A]" />
                        Ekspor PDF
                      </button>
                    </div>
                  </div>

                  {/* Search & Filter Controls */}
                  <div className="bg-white border border-[#E5EAF0] rounded-xl p-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-3 shadow-card">
                    <div className="sm:col-span-2 relative">
                      <Search className="w-4 h-4 text-[#718096] absolute left-3 top-1/2 -translate-y-1/2" />
                      <input
                        type="text"
                        value={studentQuery}
                        onChange={(e) => {
                          setStudentQuery(e.target.value);
                          setStudentPage(1);
                        }}
                        placeholder="Cari nama, NISN, NIS, atau nomor peserta..."
                        className="w-full pl-9 pr-3 py-2 rounded-xl border border-[#E5EAF0] bg-[#F5F7FA] focus:bg-white text-xs min-h-[40px]"
                      />
                    </div>
                    <select
                      value={studentKelasFilter}
                      onChange={(e) => {
                        setStudentKelasFilter(e.target.value);
                        setStudentPage(1);
                      }}
                      className="px-3 py-2 rounded-xl border border-[#E5EAF0] bg-white text-xs min-h-[40px]"
                    >
                      <option value="">Semua Kelas</option>
                      {studentsData.filterOptions.kelasList.map((k) => (
                        <option key={k} value={k}>
                          Kelas: {k}
                        </option>
                      ))}
                    </select>
                    <select
                      value={studentSesiFilter}
                      onChange={(e) => {
                        setStudentSesiFilter(e.target.value);
                        setStudentPage(1);
                      }}
                      className="px-3 py-2 rounded-xl border border-[#E5EAF0] bg-white text-xs min-h-[40px]"
                    >
                      <option value="">Semua Sesi</option>
                      {studentsData.filterOptions.sesiList.map((s) => (
                        <option key={s} value={s}>
                          Sesi: {s}
                        </option>
                      ))}
                    </select>
                    <select
                      value={studentRuangFilter}
                      onChange={(e) => {
                        setStudentRuangFilter(e.target.value);
                        setStudentPage(1);
                      }}
                      className="px-3 py-2 rounded-xl border border-[#E5EAF0] bg-white text-xs min-h-[40px]"
                    >
                      <option value="">Semua Ruang</option>
                      {studentsData.filterOptions.ruangList.map((r) => (
                        <option key={r} value={r}>
                          Ruang: {r}
                        </option>
                      ))}
                    </select>
                    <div className="flex items-center gap-2">
                      <select
                        value={studentStatusFilter}
                        onChange={(e) => {
                          setStudentStatusFilter(e.target.value);
                          setStudentPage(1);
                        }}
                        className="flex-1 px-3 py-2 rounded-xl border border-[#E5EAF0] bg-white text-xs min-h-[40px]"
                      >
                        <option value="">Semua Status</option>
                        {studentsData.filterOptions.statusList.map((st) => (
                          <option key={st} value={st}>
                            {st}
                          </option>
                        ))}
                      </select>
                      {(studentQuery ||
                        studentKelasFilter ||
                        studentSesiFilter ||
                        studentRuangFilter ||
                        studentStatusFilter) && (
                        <button
                          type="button"
                          onClick={() => {
                            setStudentQuery('');
                            setStudentKelasFilter('');
                            setStudentSesiFilter('');
                            setStudentRuangFilter('');
                            setStudentStatusFilter('');
                            setStudentPage(1);
                          }}
                          title="Reset filter"
                          className="px-2.5 py-2 rounded-xl border border-[#E5EAF0] text-xs text-[#718096] hover:text-[#172B4D] min-h-[40px]"
                        >
                          <Filter className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Table */}
                  <div className="bg-white border border-[#E5EAF0] rounded-xl overflow-hidden shadow-card">
                    {studentsData.items.length === 0 ? (
                      <EmptyState
                        icon={<GraduationCap className="w-6 h-6" />}
                        title="Belum Ada Data Peserta"
                        description="Silakan unggah dokumen Data Peserta / DNPU melalui menu Impor Dokumen SAUM atau tambah peserta secara manual."
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
                    ) : (
                      <>
                        <div className="overflow-x-auto">
                          <table className="w-full text-left border-collapse text-xs">
                            <thead>
                              <tr className="bg-[#F5F7FA] border-b border-[#E5EAF0] text-[#718096]">
                                <th className="py-3 px-3 font-semibold">No</th>
                                <th className="py-3 px-3 font-semibold">NISN / NIS</th>
                                <th className="py-3 px-3 font-semibold">Nama Lengkap</th>
                                <th className="py-3 px-3 font-semibold">JK</th>
                                <th className="py-3 px-3 font-semibold">Kelas</th>
                                <th className="py-3 px-3 font-semibold">Nomor Peserta</th>
                                <th className="py-3 px-3 font-semibold">User Ujian</th>
                                <th className="py-3 px-3 font-semibold">Sesi / Ruang / Meja</th>
                                <th className="py-3 px-3 font-semibold">Status</th>
                                <th className="py-3 px-3 font-semibold text-right">Aksi</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-[#E5EAF0]">
                              {studentsData.items.map((st, idx) => (
                                <tr key={st.id} className="hover:bg-[#F5F7FA]/60">
                                  <td className="py-2.5 px-3 font-mono-tabular text-[#718096]">
                                    {st.no_urut || (studentsData.page - 1) * studentsData.pageSize + idx + 1}
                                  </td>
                                  <td className="py-2.5 px-3 font-mono-tabular">
                                    <div className="text-[#172B4D] font-medium">{st.nisn || '-'}</div>
                                    <div className="text-[11px] text-[#718096]">NIS: {st.nis || '-'}</div>
                                  </td>
                                  <td className="py-2.5 px-3 font-semibold text-[#10243A]">{st.nama}</td>
                                  <td className="py-2.5 px-3 font-mono-tabular">{st.jk || '-'}</td>
                                  <td className="py-2.5 px-3">{st.kelas}</td>
                                  <td className="py-2.5 px-3 font-mono-tabular font-semibold text-[#10243A]">
                                    {st.nomor_peserta}
                                  </td>
                                  <td className="py-2.5 px-3 font-mono-tabular text-[#718096]">
                                    {st.user_ujian || '-'}
                                  </td>
                                  <td className="py-2.5 px-3 font-mono-tabular text-[#172B4D]">
                                    {[st.sesi || '-', st.ruang || '-', st.meja || '-'].join(' · ')}
                                  </td>
                                  <td className="py-2.5 px-3">
                                    <StatusBadge
                                      tone={
                                        (st.status || 'Aktif').toLowerCase().includes('non')
                                          ? 'rose'
                                          : 'emerald'
                                      }
                                    >
                                      {st.status || 'Aktif'}
                                    </StatusBadge>
                                  </td>
                                  <td className="py-2.5 px-3 text-right whitespace-nowrap space-x-1.5">
                                    <button
                                      type="button"
                                      onClick={() => setDetailStudent(st)}
                                      className="p-1.5 rounded-lg border border-[#E5EAF0] hover:bg-[#F5F7FA] text-[#10243A]"
                                      title="Detail Peserta"
                                    >
                                      <Eye className="w-3.5 h-3.5" />
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() =>
                                        setEditStudentModal({
                                          mode: 'edit',
                                          form: { ...st },
                                        })
                                      }
                                      className="p-1.5 rounded-lg border border-[#E5EAF0] hover:bg-[#F5F7FA] text-[#087F5B]"
                                      title="Edit Peserta"
                                    >
                                      <Pencil className="w-3.5 h-3.5" />
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => setDeleteStudentTarget(st)}
                                      className="p-1.5 rounded-lg border border-rose-200 hover:bg-rose-50 text-rose-700"
                                      title="Hapus Peserta"
                                    >
                                      <Trash2 className="w-3.5 h-3.5" />
                                    </button>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>

                        <div className="p-4 border-t border-[#E5EAF0] flex flex-wrap items-center justify-between gap-3 text-xs text-[#718096]">
                          <div className="flex items-center gap-2">
                            <span>
                              Menampilkan {studentsData.items.length} dari {studentsData.total} peserta
                            </span>
                            <select
                              value={studentPageSize}
                              onChange={(e) => {
                                setStudentPageSize(Number(e.target.value));
                                setStudentPage(1);
                              }}
                              className="px-2 py-1 rounded-lg border border-[#E5EAF0] bg-white text-xs"
                            >
                              <option value={25}>25 / halaman</option>
                              <option value={50}>50 / halaman</option>
                              <option value={100}>100 / halaman</option>
                              <option value={200}>200 / halaman</option>
                            </select>
                          </div>
                          <div className="flex items-center gap-1.5">
                            <button
                              type="button"
                              disabled={studentPage <= 1}
                              onClick={() => setStudentPage((p) => Math.max(1, p - 1))}
                              className="px-3 py-1.5 rounded-lg border border-[#E5EAF0] bg-white disabled:opacity-50 inline-flex items-center gap-1"
                            >
                              <ChevronLeft className="w-3.5 h-3.5" />
                              Prev
                            </button>
                            <span className="px-2 font-mono-tabular font-semibold text-[#172B4D]">
                              {studentsData.page} / {studentsData.totalPages}
                            </span>
                            <button
                              type="button"
                              disabled={studentPage >= studentsData.totalPages}
                              onClick={() =>
                                setStudentPage((p) => Math.min(studentsData.totalPages, p + 1))
                              }
                              className="px-3 py-1.5 rounded-lg border border-[#E5EAF0] bg-white disabled:opacity-50 inline-flex items-center gap-1"
                            >
                              Next
                              <ChevronRight className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </div>
                      </>
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

      {/* Change Own Admin Password Modal */}
      {showChangePassModal && (
        <div className="fixed inset-0 z-50 bg-[#10243A]/60 backdrop-blur-xs flex items-center justify-center p-4">
          <form
            onSubmit={handleChangeOwnPassword}
            className="bg-white rounded-2xl border border-[#E5EAF0] max-w-md w-full p-6 space-y-4 shadow-elevated"
          >
            <div className="flex items-start justify-between gap-3 border-b border-[#E5EAF0] pb-3">
              <div>
                <h3 className="font-display text-base font-bold text-[#10243A] flex items-center gap-2">
                  <KeyRound className="w-4 h-4 text-[#087F5B]" />
                  <span>
                    {user.mustChangePassword ? 'Ganti Password Bawaan Admin' : 'Ganti Password Admin'}
                  </span>
                </h3>
                <p className="text-xs text-[#718096] mt-1">
                  {user.mustChangePassword
                    ? 'Anda berhasil masuk dengan akun Admin umum. Silakan buat password baru yang aman (min. 8 karakter).'
                    : 'Perbarui password akun Admin Anda secara berkala.'}
                </p>
              </div>
              {!user.mustChangePassword && (
                <button
                  type="button"
                  onClick={() => setShowChangePassModal(false)}
                  aria-label="Tutup modal ganti password"
                  className="text-[#718096] hover:text-[#172B4D] p-1"
                >
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>

            {changePassError && (
              <div className="p-3 rounded-xl bg-rose-50 border border-rose-200 text-xs text-rose-800">
                {changePassError}
              </div>
            )}

            <div>
              <label className="block text-xs font-semibold text-[#172B4D] mb-1.5">
                Password Saat Ini
              </label>
              <input
                type="password"
                required
                value={currPassInput}
                onChange={(e) => setCurrPassInput(e.target.value)}
                placeholder="Masukkan password saat ini"
                className="w-full px-3.5 py-2.5 rounded-xl border border-[#E5EAF0] text-sm min-h-[44px]"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-[#172B4D] mb-1.5">
                Password Baru (min. 8 karakter)
              </label>
              <input
                type="password"
                required
                minLength={8}
                value={newPassInput}
                onChange={(e) => setNewPassInput(e.target.value)}
                placeholder="Minimal 8 karakter yang kuat"
                className="w-full px-3.5 py-2.5 rounded-xl border border-[#E5EAF0] text-sm min-h-[44px]"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-[#172B4D] mb-1.5">
                Konfirmasi Password Baru
              </label>
              <input
                type="password"
                required
                minLength={8}
                value={confirmPassInput}
                onChange={(e) => setConfirmPassInput(e.target.value)}
                placeholder="Ulangi password baru"
                className="w-full px-3.5 py-2.5 rounded-xl border border-[#E5EAF0] text-sm min-h-[44px]"
              />
            </div>

            <div className="flex flex-wrap justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setShowChangePassModal(false)}
                className="px-4 py-2 rounded-xl border border-[#E5EAF0] text-xs font-semibold text-[#718096] hover:text-[#172B4D] min-h-[40px]"
              >
                {user.mustChangePassword ? 'Ingatkan Nanti' : 'Batal'}
              </button>
              <button
                type="submit"
                disabled={changingPass}
                className="px-4 py-2 rounded-xl bg-[#087F5B] hover:bg-[#06694b] text-white text-xs font-semibold min-h-[40px] disabled:opacity-60"
              >
                {changingPass ? 'Menyimpan...' : 'Simpan Password Baru'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Detail Baris Bermasalah Modal */}
      {issuesModalReport && (
        <div className="fixed inset-0 z-50 bg-[#10243A]/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl border border-[#E5EAF0] max-w-2xl w-full p-6 space-y-4 shadow-elevated max-h-[85vh] flex flex-col">
            <div className="flex items-center justify-between border-b border-[#E5EAF0] pb-3">
              <h3 className="font-display text-base font-bold text-[#10243A]">
                {issuesModalReport.title}
              </h3>
              <button
                type="button"
                onClick={() => setIssuesModalReport(null)}
                className="text-[#718096] hover:text-[#172B4D] p-1"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="overflow-y-auto flex-1 border border-[#E5EAF0] rounded-xl">
              <table className="w-full text-left border-collapse text-xs">
                <thead className="bg-[#F5F7FA] sticky top-0">
                  <tr>
                    <th className="py-2.5 px-3 border-b border-[#E5EAF0] font-semibold">Baris / Hal</th>
                    <th className="py-2.5 px-3 border-b border-[#E5EAF0] font-semibold">Kolom</th>
                    <th className="py-2.5 px-3 border-b border-[#E5EAF0] font-semibold">Nilai</th>
                    <th className="py-2.5 px-3 border-b border-[#E5EAF0] font-semibold">Alasan</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#E5EAF0]">
                  {issuesModalReport.reasons.map((item, idx) => (
                    <tr key={idx}>
                      <td className="py-2 px-3 font-mono-tabular">
                        {item.rowIndex >= 0 ? `Baris ${item.rowIndex + 1}` : 'Dokumen'}
                      </td>
                      <td className="py-2 px-3 font-semibold">
                        {(item.field && (FIELD_LABELS[item.field] || item.field)) || '-'}
                      </td>
                      <td className="py-2 px-3 font-mono-tabular text-[#718096]">{item.value || '-'}</td>
                      <td className="py-2 px-3 text-rose-800">{item.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex justify-end pt-1">
              <button
                type="button"
                onClick={() => setIssuesModalReport(null)}
                className="px-4 py-2 rounded-xl bg-[#10243A] text-white text-xs font-semibold"
              >
                Tutup
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Detail Peserta Modal */}
      {detailStudent && (
        <div className="fixed inset-0 z-50 bg-[#10243A]/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl border border-[#E5EAF0] max-w-lg w-full p-6 space-y-4 shadow-elevated">
            <div className="flex items-start justify-between gap-3 border-b border-[#E5EAF0] pb-3">
              <div>
                <h3 className="font-display text-base font-bold text-[#10243A]">
                  Detail Data Peserta (DNPU)
                </h3>
                <p className="text-xs text-[#718096] mt-0.5">{detailStudent.nama}</p>
              </div>
              <button
                type="button"
                onClick={() => setDetailStudent(null)}
                className="text-[#718096] hover:text-[#172B4D] p-1"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="grid grid-cols-2 gap-3 text-xs">
              {(
                [
                  ['No. Urut', detailStudent.no_urut || '-'],
                  ['Nomor Peserta', detailStudent.nomor_peserta],
                  ['NISN', detailStudent.nisn || '-'],
                  ['NIS', detailStudent.nis || '-'],
                  ['Nama Lengkap', detailStudent.nama],
                  ['Jenis Kelamin', detailStudent.jk || '-'],
                  ['Kelas', detailStudent.kelas],
                  ['Status', detailStudent.status || 'Aktif'],
                  ['User Ujian', detailStudent.user_ujian || '-'],
                  ['Password Ujian', detailStudent.password_ujian || '-'],
                  ['Sesi', detailStudent.sesi || '-'],
                  ['Ruang', detailStudent.ruang || '-'],
                  ['Meja / Kursi', detailStudent.meja || '-'],
                ] as const
              ).map(([lbl, val]) => (
                <div key={lbl} className="p-2.5 rounded-xl bg-[#F5F7FA] border border-[#E5EAF0]">
                  <span className="text-[11px] text-[#718096] block">{lbl}</span>
                  <strong className="font-mono-tabular text-[#10243A] break-all">{val}</strong>
                </div>
              ))}
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => {
                  const target = detailStudent;
                  setDetailStudent(null);
                  setEditStudentModal({ mode: 'edit', form: { ...target } });
                }}
                className="px-4 py-2 rounded-xl border border-[#087F5B] text-[#087F5B] text-xs font-semibold"
              >
                Edit Data
              </button>
              <button
                type="button"
                onClick={() => setDetailStudent(null)}
                className="px-4 py-2 rounded-xl bg-[#10243A] text-white text-xs font-semibold"
              >
                Tutup
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Tambah / Edit Peserta Modal */}
      {editStudentModal && (
        <div className="fixed inset-0 z-50 bg-[#10243A]/60 backdrop-blur-xs flex items-center justify-center p-4">
          <form
            onSubmit={handleSaveStudent}
            className="bg-white rounded-2xl border border-[#E5EAF0] max-w-2xl w-full p-6 space-y-4 shadow-elevated max-h-[90vh] overflow-y-auto"
          >
            <div className="flex items-center justify-between border-b border-[#E5EAF0] pb-3">
              <h3 className="font-display text-base font-bold text-[#10243A]">
                {editStudentModal.mode === 'create' ? 'Tambah Peserta Ujian' : 'Edit Data Peserta Ujian'}
              </h3>
              <button
                type="button"
                onClick={() => setEditStudentModal(null)}
                className="text-[#718096] hover:text-[#172B4D] p-1"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
              {(
                [
                  { key: 'no_urut', label: 'No. Urut' },
                  { key: 'nomor_peserta', label: 'Nomor Peserta *', required: true },
                  { key: 'nisn', label: 'NISN' },
                  { key: 'nis', label: 'NIS' },
                  { key: 'nama', label: 'Nama Lengkap *', required: true },
                  { key: 'jk', label: 'Jenis Kelamin (L/P)' },
                  { key: 'kelas', label: 'Kelas *', required: true },
                  { key: 'user_ujian', label: 'User Ujian' },
                  { key: 'password_ujian', label: 'Password Ujian' },
                  { key: 'sesi', label: 'Sesi' },
                  { key: 'ruang', label: 'Ruang' },
                  { key: 'meja', label: 'Meja / Kursi' },
                  { key: 'status', label: 'Status' },
                ] as Array<{ key: keyof StudentRecord; label: string; required?: boolean }>
              ).map((fld) => (
                <div key={fld.key}>
                  <label className="block font-semibold text-[#172B4D] mb-1">{fld.label}</label>
                  <input
                    type="text"
                    required={fld.required}
                    value={String(editStudentModal.form[fld.key] ?? '')}
                    onChange={(e) =>
                      setEditStudentModal({
                        ...editStudentModal,
                        form: { ...editStudentModal.form, [fld.key]: e.target.value },
                      })
                    }
                    className="w-full px-3 py-2 rounded-xl border border-[#E5EAF0] text-xs min-h-[38px]"
                  />
                </div>
              ))}
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setEditStudentModal(null)}
                className="px-4 py-2 rounded-xl border border-[#E5EAF0] text-xs font-semibold"
              >
                Batal
              </button>
              <button
                type="submit"
                disabled={savingStudent}
                className="px-4 py-2 rounded-xl bg-[#087F5B] text-white text-xs font-semibold disabled:opacity-60"
              >
                {savingStudent ? 'Menyimpan...' : 'Simpan Data Peserta'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Konfirmasi Hapus Peserta Modal */}
      {deleteStudentTarget && (
        <div className="fixed inset-0 z-50 bg-[#10243A]/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl border border-[#E5EAF0] max-w-md w-full p-6 space-y-4 shadow-elevated">
            <h3 className="font-display text-base font-bold text-[#10243A]">Hapus Data Peserta?</h3>
            <p className="text-xs text-[#718096] leading-relaxed">
              Anda yakin ingin menghapus peserta <strong>{deleteStudentTarget.nama}</strong> ({deleteStudentTarget.nomor_peserta})? Tindakan ini akan dicatat pada audit log.
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setDeleteStudentTarget(null)}
                className="px-4 py-2 rounded-xl border border-[#E5EAF0] text-xs font-semibold"
              >
                Batal
              </button>
              <button
                type="button"
                onClick={handleDeleteStudent}
                className="px-4 py-2 rounded-xl bg-rose-600 hover:bg-rose-700 text-white text-xs font-semibold"
              >
                Ya, Hapus Peserta
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Bersihkan Data Uji Coba Modal */}
      {resetTrialModal && (
        <div className="fixed inset-0 z-50 bg-[#10243A]/60 backdrop-blur-xs flex items-center justify-center p-4">
          <form
            onSubmit={handleConfirmResetTrialData}
            className="bg-white rounded-2xl border border-[#E5EAF0] max-w-lg w-full p-6 space-y-4 shadow-elevated"
          >
            <div className="flex items-start justify-between gap-3 border-b border-[#E5EAF0] pb-3">
              <div>
                <h3 className="font-display text-base font-bold text-[#10243A] flex items-center gap-2">
                  <Trash2 className="w-4 h-4 text-rose-600" />
                  <span>Bersihkan Data Uji Coba</span>
                </h3>
                <p className="text-xs text-[#718096] mt-1">
                  Menghapus data impor dan data ujian uji coba agar Anda dapat melakukan impor ulang dari awal. Akun Admin dan Audit Log tetap aman.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setResetTrialModal(null)}
                className="text-[#718096] hover:text-[#172B4D] p-1"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5 text-xs">
              {(
                [
                  ['Data Peserta', resetTrialModal.summary.students ?? 0],
                  ['Riwayat Impor', resetTrialModal.summary.batches ?? 0],
                  ['Arsip Dokumen', resetTrialModal.summary.documents ?? 0],
                  ['Data Pengawas', resetTrialModal.summary.supervisors ?? 0],
                  ['Ruang & Kursi', `${resetTrialModal.summary.rooms ?? 0} / ${resetTrialModal.summary.seats ?? 0}`],
                  ['Jadwal & Laporan', `${resetTrialModal.summary.schedules ?? 0} / ${resetTrialModal.summary.reports ?? 0}`],
                ] as const
              ).map(([lbl, val]) => (
                <div key={lbl} className="p-2.5 rounded-xl bg-[#F5F7FA] border border-[#E5EAF0]">
                  <span className="text-[11px] text-[#718096] block">{lbl}</span>
                  <strong className="font-mono-tabular text-[#10243A]">{val}</strong>
                </div>
              ))}
            </div>

            <label className="flex items-start gap-2.5 p-3 rounded-xl bg-amber-50 border border-amber-200 text-xs text-amber-950 cursor-pointer">
              <input
                type="checkbox"
                checked={resetTrialModal.includeSupervisorAccounts}
                onChange={(e) =>
                  setResetTrialModal({
                    ...resetTrialModal,
                    includeSupervisorAccounts: e.target.checked,
                  })
                }
                className="mt-0.5 rounded border-amber-400"
              />
              <span>
                Hapus juga akun pengawas uji coba yang sudah aktif (
                <strong>{resetTrialModal.summary.supervisorsWithAccount ?? 0}</strong> akun). Jika tidak dicentang, hanya pengawas hasil impor tanpa akun yang dibersihkan.
              </span>
            </label>

            <div>
              <label className="block text-xs font-semibold text-[#172B4D] mb-1.5">
                Ketik <code className="px-1.5 py-0.5 rounded bg-rose-50 text-rose-800">BERSIHKAN DATA</code> untuk konfirmasi
              </label>
              <input
                type="text"
                required
                value={resetTrialModal.confirmText}
                onChange={(e) =>
                  setResetTrialModal({ ...resetTrialModal, confirmText: e.target.value })
                }
                placeholder="BERSIHKAN DATA"
                className="w-full px-3.5 py-2.5 rounded-xl border border-[#E5EAF0] text-sm font-mono-tabular min-h-[42px]"
              />
            </div>

            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setResetTrialModal(null)}
                className="px-4 py-2 rounded-xl border border-[#E5EAF0] text-xs font-semibold"
              >
                Batal
              </button>
              <button
                type="submit"
                disabled={
                  resetTrialModal.resetting ||
                  resetTrialModal.confirmText.trim().toUpperCase() !== 'BERSIHKAN DATA'
                }
                className="px-4 py-2 rounded-xl bg-rose-600 hover:bg-rose-700 disabled:opacity-50 text-white text-xs font-semibold"
              >
                {resetTrialModal.resetting ? 'Membersihkan...' : 'Ya, Bersihkan Data Uji Coba'}
              </button>
            </div>
          </form>
        </div>
      )}

      <ToastNotification
        message={toast?.message || null}
        type={toast?.type || 'success'}
        onDismiss={() => setToast(null)}
      />
    </div>
  );
};
