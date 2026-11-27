export type UserRole = 'admin' | 'supervisor';

export type ScheduleStatus = 'akan_datang' | 'aktif' | 'selesai' | 'dibatalkan';

export type AttendanceStatus = 'hadir' | 'tidak_hadir' | 'belum';

export type ReportStatus =
  | 'belum_dikerjakan'
  | 'belum_dikirim'
  | 'menunggu_verifikasi'
  | 'perlu_perbaikan'
  | 'terverifikasi';

export type ImportDocType =
  | 'data_peserta'
  | 'data_pengawas'
  | 'jadwal_ujian'
  | 'jadwal_pengawasan'
  | 'pembagian_ruang'
  | 'denah_peserta'
  | 'daftar_hadir_peserta'
  | 'denah_lingkungan'
  | 'dokumen_pendukung';

export interface AuthUser {
  id: number;
  username: string;
  role: UserRole;
  status: 'active' | 'inactive';
  supervisorId: number | null;
  namaLengkap: string;
  nipNuptk?: string | null;
  fotoUrl?: string | null;
  ttdUrl?: string | null;
  mustChangePassword?: boolean;
}

export interface ServerWibTime {
  date: string; // YYYY-MM-DD
  time: string; // HH:mm:ss
  isoWib: string;
  timestampMs: number;
}

export interface SupervisorRecord {
  id: number;
  user_id: number | null;
  username?: string | null;
  user_status?: string | null;
  nama_lengkap: string;
  nip_nuptk: string | null;
  nomor_identitas: string | null;
  tempat_lahir: string | null;
  tgl_lahir: string | null;
  alamat: string | null;
  whatsapp: string | null;
  foto_url: string | null;
  ttd_url: string | null;
  kode_verifikasi: string | null;
  status: 'active' | 'inactive';
  created_at: string;
}

export interface ExamRecord {
  id: number;
  nama: string;
  madrasah_nama: string;
  tahun_ajaran: string;
  tanggal_mulai: string;
  tanggal_selesai: string;
  status: 'draft' | 'aktif' | 'selesai';
  warning_minutes_before_end: number;
  created_at: string;
}

export interface RoomRecord {
  id: number;
  kode: string;
  nama: string;
  kapasitas: number;
  rows_count: number;
  cols_count: number;
  layout_json: string | null;
  denah_lingkungan_json: string | null;
}

export interface StudentRecord {
  id: number;
  exam_id: number;
  nomor_peserta: string;
  nisn: string | null;
  nis: string | null;
  nama: string;
  kelas: string;
}

export interface SeatWithState {
  id: number;
  room_id: number;
  kode_kursi: string;
  baris: number;
  kolom: number;
  posisi_x: number;
  posisi_y: number;
  student_id: number | null;
  student: StudentRecord | null;
  attendance: {
    status: AttendanceStatus;
    dicatat_oleh: number | null;
    waktu: string | null;
    updated_version: number;
  };
  warnings: WarningRecord[];
  highestWarningLevel: 0 | 1 | 2 | 3;
  activeExit: ExitPermissionRecord | null;
  exitHistory: ExitPermissionRecord[];
}

export interface WarningRecord {
  id: number;
  student_id: number;
  exam_schedule_id: number;
  tingkat: 1 | 2 | 3;
  alasan: string;
  is_correction: number;
  corrects_warning_id: number | null;
  dicatat_oleh: number;
  dicatat_oleh_nama: string;
  waktu_server: string;
  idempotency_key: string | null;
}

export interface ExitPermissionRecord {
  id: number;
  student_id: number;
  exam_schedule_id: number;
  alasan: string;
  waktu_keluar: string;
  waktu_kembali: string | null;
  durasi_detik: number | null;
  dicatat_oleh: number;
  dicatat_oleh_nama: string;
  idempotency_key: string | null;
}

export interface IncidentReportRecord {
  id: number;
  exam_schedule_id: number;
  deskripsi: string;
  waktu: string;
  dicatat_oleh: number;
  dicatat_oleh_nama: string;
}

export interface SupervisionScheduleItem {
  id: number; // exam_schedule_id
  exam_id: number;
  exam_nama: string;
  madrasah_nama: string;
  tahun_ajaran: string;
  warning_minutes_before_end: number;
  session_id: number;
  nama_sesi: string;
  subject_id: number;
  subject_kode: string;
  subject_nama: string;
  room_id: number;
  room_kode: string;
  room_nama: string;
  room_kapasitas: number;
  tanggal: string;
  jam_mulai: string;
  jam_selesai: string;
  computed_status: ScheduleStatus;
  remaining_seconds: number;
  assignment_id?: number;
  peran?: 'utama' | 'pendamping';
  supervisor_checked_in?: boolean;
  co_supervisors: Array<{
    supervisor_id: number;
    nama_lengkap: string;
    nip_nuptk: string | null;
    peran: 'utama' | 'pendamping';
    checked_in: boolean;
    waktu_hadir: string | null;
  }>;
  report_status: ReportStatus;
}

export interface SupervisionReportRecord {
  id: number;
  exam_schedule_id: number;
  supervisor_id: number;
  supervisor_nama?: string;
  jenis: 'berita_acara' | 'daftar_hadir';
  data_json: string | null;
  file_path: string | null;
  status: ReportStatus;
  dikirim_pada: string | null;
  version: number;
  verifications?: Array<{
    id: number;
    admin_nama: string;
    status: string;
    catatan: string | null;
    waktu: string;
  }>;
}

export interface NotificationRecord {
  id: number;
  user_id: number;
  judul: string;
  isi: string;
  kategori: string;
  link_target: string | null;
  dibaca: number;
  dibuat_pada: string;
}

export interface AuditLogRecord {
  id: number;
  user_id: number | null;
  username: string | null;
  aksi: string;
  entitas: string;
  entitas_id: string | null;
  nilai_lama: string | null;
  nilai_baru: string | null;
  waktu_server: string;
  ip: string | null;
}

export interface ImportBatchRecord {
  id: number;
  exam_id: number | null;
  filename: string;
  sha256: string;
  detected_type: ImportDocType;
  confidence: number;
  status: 'preview' | 'confirmed' | 'failed';
  extracted_rows: Array<Record<string, unknown>>;
  unreadable_fields: Array<{ rowIndex: number; field: string; reason: string }>;
  duplicates: Array<{ rowIndex: number; field: string; value: string; source: string }>;
  created_at: string;
  confirmed_at: string | null;
}

export interface PendingSyncAction {
  id: string;
  scheduleId: number;
  endpoint: string;
  method: 'POST';
  body: Record<string, unknown>;
  label: string;
  createdAt: string;
}
