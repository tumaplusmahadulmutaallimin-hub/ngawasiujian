import crypto from 'crypto';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { getServerWibNow } from './time.ts';

const DATA_DIR = path.resolve(process.cwd(), 'data');
export const UPLOADS_DIR = path.resolve(DATA_DIR, 'uploads');
const DB_PATH = path.resolve(DATA_DIR, 'sipenguji.db');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

export const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'supervisor')),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
    must_change_password INTEGER NOT NULL DEFAULT 0,
    last_active_at TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS supervisors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER UNIQUE REFERENCES users(id) ON DELETE SET NULL,
    nama_lengkap TEXT NOT NULL,
    nip_nuptk TEXT UNIQUE,
    nomor_identitas TEXT,
    tempat_lahir TEXT,
    tgl_lahir TEXT,
    alamat TEXT,
    whatsapp TEXT,
    foto_url TEXT,
    ttd_url TEXT,
    kode_verifikasi TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS exams (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nama TEXT NOT NULL,
    madrasah_nama TEXT NOT NULL DEFAULT 'Madrasah Aliyah Negeri',
    tahun_ajaran TEXT NOT NULL,
    tanggal_mulai TEXT NOT NULL,
    tanggal_selesai TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'aktif' CHECK (status IN ('draft', 'aktif', 'selesai')),
    warning_minutes_before_end INTEGER NOT NULL DEFAULT 15,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS exam_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    exam_id INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
    nama_sesi TEXT NOT NULL,
    tanggal TEXT NOT NULL,
    jam_mulai TEXT NOT NULL,
    jam_selesai TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS subjects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kode TEXT NOT NULL UNIQUE,
    nama TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS rooms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kode TEXT NOT NULL UNIQUE,
    nama TEXT NOT NULL,
    kapasitas INTEGER NOT NULL CHECK (kapasitas > 0),
    rows_count INTEGER NOT NULL DEFAULT 4,
    cols_count INTEGER NOT NULL DEFAULT 5,
    layout_json TEXT,
    denah_lingkungan_json TEXT
  );

  CREATE TABLE IF NOT EXISTS students (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    exam_id INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
    nomor_peserta TEXT NOT NULL,
    nisn TEXT,
    nis TEXT,
    nama TEXT NOT NULL,
    kelas TEXT NOT NULL,
    UNIQUE(exam_id, nomor_peserta)
  );

  CREATE TABLE IF NOT EXISTS seats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    kode_kursi TEXT NOT NULL,
    baris INTEGER NOT NULL,
    kolom INTEGER NOT NULL,
    posisi_x INTEGER NOT NULL DEFAULT 0,
    posisi_y INTEGER NOT NULL DEFAULT 0,
    student_id INTEGER REFERENCES students(id) ON DELETE SET NULL,
    UNIQUE(room_id, kode_kursi)
  );

  CREATE TABLE IF NOT EXISTS exam_schedules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    exam_session_id INTEGER NOT NULL REFERENCES exam_sessions(id) ON DELETE CASCADE,
    subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
    room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    tanggal TEXT NOT NULL,
    jam_mulai TEXT NOT NULL,
    jam_selesai TEXT NOT NULL,
    status_manual_cancel INTEGER NOT NULL DEFAULT 0,
    actual_started_at TEXT,
    actual_finished_at TEXT
  );

  CREATE TABLE IF NOT EXISTS supervision_assignments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    supervisor_id INTEGER NOT NULL REFERENCES supervisors(id) ON DELETE CASCADE,
    room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    exam_session_id INTEGER NOT NULL REFERENCES exam_sessions(id) ON DELETE CASCADE,
    exam_schedule_id INTEGER REFERENCES exam_schedules(id) ON DELETE CASCADE,
    peran TEXT NOT NULL DEFAULT 'utama' CHECK (peran IN ('utama', 'pendamping')),
    status_jadwal TEXT NOT NULL DEFAULT 'akan_datang',
    UNIQUE(supervisor_id, exam_schedule_id)
  );

  CREATE TABLE IF NOT EXISTS documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    exam_id INTEGER REFERENCES exams(id) ON DELETE SET NULL,
    jenis TEXT NOT NULL,
    nama_file TEXT NOT NULL,
    path TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    version INTEGER NOT NULL DEFAULT 1,
    status_verifikasi TEXT NOT NULL DEFAULT 'tersimpan',
    needs_regeneration INTEGER NOT NULL DEFAULT 0,
    meta_json TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS generated_doc_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    exam_id INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
    doc_key TEXT NOT NULL,
    title TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    needs_regeneration INTEGER NOT NULL DEFAULT 0,
    generated_at TEXT NOT NULL,
    generated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    UNIQUE(exam_id, doc_key)
  );

  CREATE TABLE IF NOT EXISTS attendance (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    exam_schedule_id INTEGER NOT NULL REFERENCES exam_schedules(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'belum' CHECK (status IN ('hadir', 'tidak_hadir', 'belum')),
    dicatat_oleh INTEGER REFERENCES users(id) ON DELETE SET NULL,
    waktu TEXT,
    updated_version INTEGER NOT NULL DEFAULT 1,
    UNIQUE(student_id, exam_schedule_id)
  );

  CREATE TABLE IF NOT EXISTS supervisor_attendance (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    assignment_id INTEGER NOT NULL UNIQUE REFERENCES supervision_assignments(id) ON DELETE CASCADE,
    waktu_hadir TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'hadir'
  );

  CREATE TABLE IF NOT EXISTS warnings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    exam_schedule_id INTEGER NOT NULL REFERENCES exam_schedules(id) ON DELETE CASCADE,
    tingkat INTEGER NOT NULL CHECK (tingkat IN (1, 2, 3)),
    alasan TEXT NOT NULL,
    is_correction INTEGER NOT NULL DEFAULT 0,
    corrects_warning_id INTEGER REFERENCES warnings(id),
    dicatat_oleh INTEGER NOT NULL REFERENCES users(id),
    dicatat_oleh_nama TEXT NOT NULL,
    waktu_server TEXT NOT NULL,
    idempotency_key TEXT UNIQUE
  );

  CREATE TABLE IF NOT EXISTS exit_permissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    exam_schedule_id INTEGER NOT NULL REFERENCES exam_schedules(id) ON DELETE CASCADE,
    alasan TEXT NOT NULL,
    waktu_keluar TEXT NOT NULL,
    waktu_kembali TEXT,
    durasi_detik INTEGER,
    dicatat_oleh INTEGER NOT NULL REFERENCES users(id),
    dicatat_oleh_nama TEXT NOT NULL,
    idempotency_key TEXT UNIQUE
  );

  CREATE TABLE IF NOT EXISTS incident_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    exam_schedule_id INTEGER NOT NULL REFERENCES exam_schedules(id) ON DELETE CASCADE,
    deskripsi TEXT NOT NULL,
    waktu TEXT NOT NULL,
    dicatat_oleh INTEGER NOT NULL REFERENCES users(id),
    dicatat_oleh_nama TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS supervision_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    exam_schedule_id INTEGER NOT NULL REFERENCES exam_schedules(id) ON DELETE CASCADE,
    supervisor_id INTEGER NOT NULL REFERENCES supervisors(id) ON DELETE CASCADE,
    jenis TEXT NOT NULL CHECK (jenis IN ('berita_acara', 'daftar_hadir')),
    data_json TEXT,
    file_path TEXT,
    status TEXT NOT NULL DEFAULT 'belum_dikirim' CHECK (status IN ('belum_dikerjakan', 'belum_dikirim', 'menunggu_verifikasi', 'perlu_perbaikan', 'terverifikasi')),
    dikirim_pada TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    UNIQUE(exam_schedule_id, jenis)
  );

  CREATE TABLE IF NOT EXISTS report_verifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    report_id INTEGER NOT NULL REFERENCES supervision_reports(id) ON DELETE CASCADE,
    admin_id INTEGER NOT NULL REFERENCES users(id),
    status TEXT NOT NULL,
    catatan TEXT,
    waktu TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    judul TEXT NOT NULL,
    isi TEXT NOT NULL,
    kategori TEXT NOT NULL DEFAULT 'info',
    link_target TEXT,
    dibaca INTEGER NOT NULL DEFAULT 0,
    dibuat_pada TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    username TEXT,
    aksi TEXT NOT NULL,
    entitas TEXT NOT NULL,
    entitas_id TEXT,
    nilai_lama TEXT,
    nilai_baru TEXT,
    waktu_server TEXT NOT NULL,
    ip TEXT
  );

  CREATE TABLE IF NOT EXISTS import_batches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    exam_id INTEGER REFERENCES exams(id) ON DELETE SET NULL,
    filename TEXT NOT NULL,
    file_path TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    detected_type TEXT NOT NULL,
    confidence REAL NOT NULL DEFAULT 1.0,
    status TEXT NOT NULL DEFAULT 'preview' CHECK (status IN ('preview', 'confirmed', 'failed')),
    extracted_json TEXT NOT NULL,
    errors_json TEXT NOT NULL DEFAULT '[]',
    duplicates_json TEXT NOT NULL DEFAULT '[]',
    uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    confirmed_at TEXT
  );

  -- BR-17 & AC-MON-03: Enforce append-only audit_logs at database level
  CREATE TRIGGER IF NOT EXISTS prevent_audit_update
  BEFORE UPDATE ON audit_logs
  BEGIN
    SELECT RAISE(ABORT, 'Audit log bersifat append-only dan tidak dapat diubah');
  END;

  CREATE TRIGGER IF NOT EXISTS prevent_audit_delete
  BEFORE DELETE ON audit_logs
  BEGIN
    SELECT RAISE(ABORT, 'Audit log bersifat append-only dan tidak dapat dihapus');
  END;
`);

// Safe schema migration for existing SQLite databases
const userCols = db.prepare(`PRAGMA table_info(users)`).all() as Array<{ name: string }>;
if (!userCols.some((c) => c.name === 'must_change_password')) {
  db.exec(`ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0`);
}

// Seed initial General Admin account (admin / admin123, must change password after login) if no admin exists
const existingAdminRow = db.prepare(`SELECT id FROM users WHERE role = 'admin' LIMIT 1`).get();
if (!existingAdminRow) {
  const initialAdminPassword = process.env.DEFAULT_ADMIN_PASSWORD?.trim() || 'admin123';
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(initialAdminPassword, salt, 64).toString('hex');
  const passwordHash = `${salt}:${derived}`;
  const now = getServerWibNow().isoWib;

  const res = db
    .prepare(
      `INSERT INTO users (username, password_hash, role, status, must_change_password, last_active_at, created_at)
       VALUES ('admin', ?, 'admin', 'active', 1, ?, ?)`
    )
    .run(passwordHash, now, now);

  db.prepare(
    `INSERT INTO audit_logs (user_id, username, aksi, entitas, entitas_id, nilai_baru, waktu_server, ip)
     VALUES (?, 'admin', 'ADMIN_DEFAULT_SEEDED', 'users', ?, ?, ?, 'system')`
  ).run(
    Number(res.lastInsertRowid),
    String(res.lastInsertRowid),
    JSON.stringify({ username: 'admin', role: 'admin', must_change_password: true }),
    now
  );
}

export const ELEVEN_DOCS_CATALOG: Array<{ doc_key: string; title: string }> = [
  { doc_key: 'cover', title: '01. Cover Administrasi Pengawasan' },
  { doc_key: 'denah_lingkungan', title: '02. Denah Lingkungan Ujian' },
  { doc_key: 'denah_peserta', title: '03. Denah Peserta Ujian' },
  { doc_key: 'jadwal_ujian', title: '04. Jadwal Ujian' },
  { doc_key: 'tata_tertib_peserta', title: '05. Tata Tertib Peserta' },
  { doc_key: 'tata_tertib_pengawas', title: '06. Tata Tertib Pengawas' },
  { doc_key: 'daftar_hadir_peserta', title: '07. Daftar Hadir Peserta' },
  { doc_key: 'daftar_hadir_pengawas', title: '08. Daftar Hadir Pengawas' },
  { doc_key: 'berita_acara', title: '09. Berita Acara Pelaksanaan Ujian' },
  { doc_key: 'catatan_kejadian', title: '10. Formulir Catatan Kejadian Khusus' },
  { doc_key: 'serah_terima', title: '11. Dokumen Serah Terima Berkas Ujian' },
];

export function appendAuditLog(params: {
  userId?: number | null;
  username?: string | null;
  aksi: string;
  entitas: string;
  entitasId?: string | number | null;
  nilaiLama?: unknown;
  nilaiBaru?: unknown;
  ip?: string | null;
}): void {
  const now = getServerWibNow().isoWib;
  db.prepare(
    `INSERT INTO audit_logs (user_id, username, aksi, entitas, entitas_id, nilai_lama, nilai_baru, waktu_server, ip)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    params.userId ?? null,
    params.username ?? null,
    params.aksi,
    params.entitas,
    params.entitasId !== undefined && params.entitasId !== null ? String(params.entitasId) : null,
    params.nilaiLama !== undefined ? JSON.stringify(params.nilaiLama) : null,
    params.nilaiBaru !== undefined ? JSON.stringify(params.nilaiBaru) : null,
    now,
    params.ip ?? null
  );
}

export function createNotification(params: {
  userId: number;
  judul: string;
  isi: string;
  kategori?: string;
  linkTarget?: string | null;
}): number {
  const now = getServerWibNow().isoWib;
  const res = db
    .prepare(
      `INSERT INTO notifications (user_id, judul, isi, kategori, link_target, dibaca, dibuat_pada)
       VALUES (?, ?, ?, ?, ?, 0, ?)`
    )
    .run(params.userId, params.judul, params.isi, params.kategori ?? 'info', params.linkTarget ?? null, now);
  return Number(res.lastInsertRowid);
}

export function notifyAllAdmins(params: {
  judul: string;
  isi: string;
  kategori?: string;
  linkTarget?: string | null;
}): number[] {
  const admins = db
    .prepare(`SELECT id FROM users WHERE role = 'admin' AND status = 'active'`)
    .all() as Array<{ id: number }>;
  return admins.map((a) =>
    createNotification({
      userId: a.id,
      judul: params.judul,
      isi: params.isi,
      kategori: params.kategori,
      linkTarget: params.linkTarget,
    })
  );
}

export function markGeneratedDocumentsStale(examId: number): void {
  db.prepare(`UPDATE generated_doc_versions SET needs_regeneration = 1 WHERE exam_id = ?`).run(examId);
}

export function ensureGeneratedDocRows(examId: number, userId: number | null): void {
  const now = getServerWibNow().isoWib;
  const insert = db.prepare(
    `INSERT OR IGNORE INTO generated_doc_versions (exam_id, doc_key, title, version, needs_regeneration, generated_at, generated_by)
     VALUES (?, ?, ?, 1, 0, ?, ?)`
  );
  for (const doc of ELEVEN_DOCS_CATALOG) {
    insert.run(examId, doc.doc_key, doc.title, now, userId);
  }
}
