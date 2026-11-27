import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { parse as parsePgConnectionString } from 'pg-connection-string';
import { getServerWibNow } from './time.ts';

let poolInstance: Pool | null = null;
let initPromise: Promise<void> | null = null;

type DbConfigStatus = 'valid' | 'missing_env' | 'invalid_format';

export type DatabaseHealthStatus =
  | 'connected'
  | 'missing_env'
  | 'invalid_format'
  | 'connection_failed';

interface ResolvedDbConfig {
  status: DbConfigStatus;
  connectionString: string;
  sourceKey: string | null;
  reason: string | null;
}

function stripOuterQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
    (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
  ) {
    return value.slice(1, -1).trim();
  }
  return value;
}

export function normalizeDatabaseConnectionInput(raw: string): string {
  let normalized = raw.trim();
  normalized = stripOuterQuotes(normalized);

  const envPrefixMatch = normalized.match(
    /^(?:DATABASE_URL|POSTGRES_URL|POSTGRES_PRISMA_URL|POSTGRES_URL_NON_POOLING)\s*=\s*(.+)$/
  );
  if (envPrefixMatch) {
    normalized = stripOuterQuotes(envPrefixMatch[1].trim());
  }

  if (/^psql\s+/i.test(normalized)) {
    normalized = stripOuterQuotes(normalized.replace(/^psql\s+/i, '').trim());
  }

  return normalized;
}

export function validatePostgresConnectionString(
  normalized: string
): { valid: boolean; reason: string | null } {
  if (!normalized) {
    return { valid: false, reason: 'String koneksi kosong.' };
  }
  if (
    normalized.includes('postgresql://user:password@host:') ||
    normalized === 'MY_DATABASE_URL'
  ) {
    return { valid: false, reason: 'String koneksi masih berisi nilai template placeholder.' };
  }
  if (!/^postgres(ql)?:\/\//i.test(normalized)) {
    return { valid: false, reason: 'Format harus diawali skema postgres:// atau postgresql://.' };
  }

  try {
    const parsed = parsePgConnectionString(normalized);
    if (!parsed.host || parsed.host === 'base' || parsed.host === 'host') {
      return { valid: false, reason: 'Hostname PostgreSQL tidak valid atau belum diisi.' };
    }
    if (!parsed.database) {
      return { valid: false, reason: 'Nama database tidak ditemukan pada string koneksi.' };
    }
    return { valid: true, reason: null };
  } catch {
    return { valid: false, reason: 'Gagal diurai oleh parser PostgreSQL (pg-connection-string).' };
  }
}

export function resolveDatabaseConfig(): ResolvedDbConfig {
  const orderedKeys = [
    'DATABASE_URL',
    'POSTGRES_URL',
    'POSTGRES_PRISMA_URL',
    'POSTGRES_URL_NON_POOLING',
  ] as const;

  for (const key of orderedKeys) {
    const raw = process.env[key];
    if (typeof raw !== 'string' || raw.trim().length === 0) {
      continue;
    }

    const normalized = normalizeDatabaseConnectionInput(raw);
    const check = validatePostgresConnectionString(normalized);
    if (check.valid) {
      return {
        status: 'valid',
        connectionString: normalized,
        sourceKey: key,
        reason: null,
      };
    }

    console.error(`[SIPENGUJI DB] ${key} terisi tetapi format tidak valid: ${check.reason}`);
    return {
      status: 'invalid_format',
      connectionString: '',
      sourceKey: key,
      reason: check.reason,
    };
  }

  return {
    status: 'missing_env',
    connectionString: '',
    sourceKey: null,
    reason: 'Variabel DATABASE_URL maupun alternatif PostgreSQL tidak ditemukan di process.env.',
  };
}

function getConnectionString(): string {
  const resolved = resolveDatabaseConfig();
  return resolved.status === 'valid' ? resolved.connectionString : '';
}

export function isDatabaseConfigured(): boolean {
  return resolveDatabaseConfig().status === 'valid';
}

export async function checkDatabaseHealth(): Promise<{
  databaseConfigured: boolean;
  databaseConnected: boolean;
  status: DatabaseHealthStatus;
}> {
  const cfg = resolveDatabaseConfig();
  if (cfg.status === 'missing_env') {
    console.warn('[SIPENGUJI Health] Variabel koneksi database tidak ditemukan pada process.env.');
    return {
      databaseConfigured: false,
      databaseConnected: false,
      status: 'missing_env',
    };
  }
  if (cfg.status === 'invalid_format') {
    return {
      databaseConfigured: false,
      databaseConnected: false,
      status: 'invalid_format',
    };
  }

  try {
    await getPool().query('SELECT 1');
    return {
      databaseConfigured: true,
      databaseConnected: true,
      status: 'connected',
    };
  } catch (err) {
    const errObj = err as { code?: string; message?: string };
    console.error('[SIPENGUJI Health] Uji koneksi PostgreSQL gagal:', {
      sourceKey: cfg.sourceKey,
      code: errObj?.code || 'UNKNOWN',
      message: errObj?.message || 'Koneksi ditolak atau timeout',
    });
    return {
      databaseConfigured: true,
      databaseConnected: false,
      status: 'connection_failed',
    };
  }
}

export function getPool(): Pool {
  if (poolInstance) return poolInstance;
  const connectionString = getConnectionString();
  if (!connectionString) {
    throw new Error('DATABASE_URL belum dikonfigurasi pada Environment Variables server.');
  }
  const isLocal =
    connectionString.includes('localhost') ||
    connectionString.includes('127.0.0.1') ||
    process.env.PGSSL === 'disable';

  poolInstance = new Pool({
    connectionString,
    ssl: isLocal ? false : { rejectUnauthorized: false },
    max: 5,
    idleTimeoutMillis: 15_000,
    connectionTimeoutMillis: 10_000,
  });

  return poolInstance;
}

export async function query<T extends QueryResultRow = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
  client?: PoolClient
): Promise<T[]> {
  const executor = client ?? getPool();
  const res = await executor.query<T>(sql, params);
  return res.rows;
}

export async function queryOne<T extends QueryResultRow = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
  client?: PoolClient
): Promise<T | null> {
  const rows = await query<T>(sql, params, client);
  return rows[0] ?? null;
}

export async function execute(
  sql: string,
  params: unknown[] = [],
  client?: PoolClient
): Promise<number> {
  const executor = client ?? getPool();
  const res = await executor.query(sql, params);
  return res.rowCount ?? 0;
}

export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function ensureDbReady(): Promise<void> {
  if (!isDatabaseConfigured()) {
    throw new Error('DATABASE_URL belum dikonfigurasi.');
  }
  if (!initPromise) {
    initPromise = (async () => {
      const pool = getPool();
      await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
          id SERIAL PRIMARY KEY,
          username TEXT NOT NULL UNIQUE,
          password_hash TEXT NOT NULL,
          role TEXT NOT NULL CHECK (role IN ('admin', 'supervisor')),
          status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
          must_change_password INTEGER NOT NULL DEFAULT 0,
          last_active_at TEXT,
          created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS supervisors (
          id SERIAL PRIMARY KEY,
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
          id SERIAL PRIMARY KEY,
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
          id SERIAL PRIMARY KEY,
          exam_id INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
          nama_sesi TEXT NOT NULL,
          tanggal TEXT NOT NULL,
          jam_mulai TEXT NOT NULL,
          jam_selesai TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS subjects (
          id SERIAL PRIMARY KEY,
          kode TEXT NOT NULL UNIQUE,
          nama TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS rooms (
          id SERIAL PRIMARY KEY,
          kode TEXT NOT NULL UNIQUE,
          nama TEXT NOT NULL,
          kapasitas INTEGER NOT NULL CHECK (kapasitas > 0),
          rows_count INTEGER NOT NULL DEFAULT 4,
          cols_count INTEGER NOT NULL DEFAULT 5,
          layout_json TEXT,
          denah_lingkungan_json TEXT
        );

        CREATE TABLE IF NOT EXISTS students (
          id SERIAL PRIMARY KEY,
          exam_id INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
          no_urut TEXT,
          nomor_peserta TEXT NOT NULL,
          nisn TEXT,
          nis TEXT,
          nama TEXT NOT NULL,
          jk TEXT,
          kelas TEXT NOT NULL,
          user_ujian TEXT,
          password_ujian TEXT,
          sesi TEXT,
          ruang TEXT,
          meja TEXT,
          status TEXT NOT NULL DEFAULT 'Aktif',
          updated_at TEXT,
          UNIQUE(exam_id, nomor_peserta)
        );

        ALTER TABLE students ADD COLUMN IF NOT EXISTS no_urut TEXT;
        ALTER TABLE students ADD COLUMN IF NOT EXISTS jk TEXT;
        ALTER TABLE students ADD COLUMN IF NOT EXISTS user_ujian TEXT;
        ALTER TABLE students ADD COLUMN IF NOT EXISTS password_ujian TEXT;
        ALTER TABLE students ADD COLUMN IF NOT EXISTS sesi TEXT;
        ALTER TABLE students ADD COLUMN IF NOT EXISTS ruang TEXT;
        ALTER TABLE students ADD COLUMN IF NOT EXISTS meja TEXT;
        ALTER TABLE students ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'Aktif';
        ALTER TABLE students ADD COLUMN IF NOT EXISTS updated_at TEXT;

        CREATE TABLE IF NOT EXISTS seats (
          id SERIAL PRIMARY KEY,
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
          id SERIAL PRIMARY KEY,
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
          id SERIAL PRIMARY KEY,
          supervisor_id INTEGER NOT NULL REFERENCES supervisors(id) ON DELETE CASCADE,
          room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
          exam_session_id INTEGER NOT NULL REFERENCES exam_sessions(id) ON DELETE CASCADE,
          exam_schedule_id INTEGER REFERENCES exam_schedules(id) ON DELETE CASCADE,
          peran TEXT NOT NULL DEFAULT 'utama' CHECK (peran IN ('utama', 'pendamping')),
          status_jadwal TEXT NOT NULL DEFAULT 'akan_datang',
          UNIQUE(supervisor_id, exam_schedule_id)
        );

        CREATE TABLE IF NOT EXISTS documents (
          id SERIAL PRIMARY KEY,
          exam_id INTEGER REFERENCES exams(id) ON DELETE SET NULL,
          jenis TEXT NOT NULL,
          nama_file TEXT NOT NULL,
          path TEXT NOT NULL,
          mime_type TEXT,
          blob_url TEXT,
          file_bytes BYTEA,
          sha256 TEXT NOT NULL,
          uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
          version INTEGER NOT NULL DEFAULT 1,
          status_verifikasi TEXT NOT NULL DEFAULT 'tersimpan',
          needs_regeneration INTEGER NOT NULL DEFAULT 0,
          meta_json TEXT,
          created_at TEXT NOT NULL
        );

        ALTER TABLE documents ADD COLUMN IF NOT EXISTS mime_type TEXT;
        ALTER TABLE documents ADD COLUMN IF NOT EXISTS blob_url TEXT;
        ALTER TABLE documents ADD COLUMN IF NOT EXISTS file_bytes BYTEA;

        CREATE TABLE IF NOT EXISTS generated_doc_versions (
          id SERIAL PRIMARY KEY,
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
          id SERIAL PRIMARY KEY,
          student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
          exam_schedule_id INTEGER NOT NULL REFERENCES exam_schedules(id) ON DELETE CASCADE,
          status TEXT NOT NULL DEFAULT 'belum' CHECK (status IN ('hadir', 'tidak_hadir', 'belum')),
          dicatat_oleh INTEGER REFERENCES users(id) ON DELETE SET NULL,
          waktu TEXT,
          updated_version INTEGER NOT NULL DEFAULT 1,
          UNIQUE(student_id, exam_schedule_id)
        );

        CREATE TABLE IF NOT EXISTS supervisor_attendance (
          id SERIAL PRIMARY KEY,
          assignment_id INTEGER NOT NULL UNIQUE REFERENCES supervision_assignments(id) ON DELETE CASCADE,
          waktu_hadir TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'hadir'
        );

        CREATE TABLE IF NOT EXISTS warnings (
          id SERIAL PRIMARY KEY,
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
          id SERIAL PRIMARY KEY,
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
          id SERIAL PRIMARY KEY,
          exam_schedule_id INTEGER NOT NULL REFERENCES exam_schedules(id) ON DELETE CASCADE,
          deskripsi TEXT NOT NULL,
          waktu TEXT NOT NULL,
          dicatat_oleh INTEGER NOT NULL REFERENCES users(id),
          dicatat_oleh_nama TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS supervision_reports (
          id SERIAL PRIMARY KEY,
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
          id SERIAL PRIMARY KEY,
          report_id INTEGER NOT NULL REFERENCES supervision_reports(id) ON DELETE CASCADE,
          admin_id INTEGER NOT NULL REFERENCES users(id),
          status TEXT NOT NULL,
          catatan TEXT,
          waktu TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS notifications (
          id SERIAL PRIMARY KEY,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          judul TEXT NOT NULL,
          isi TEXT NOT NULL,
          kategori TEXT NOT NULL DEFAULT 'info',
          link_target TEXT,
          dibaca INTEGER NOT NULL DEFAULT 0,
          dibuat_pada TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS audit_logs (
          id SERIAL PRIMARY KEY,
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
          id SERIAL PRIMARY KEY,
          exam_id INTEGER REFERENCES exams(id) ON DELETE SET NULL,
          filename TEXT NOT NULL,
          file_path TEXT NOT NULL,
          sha256 TEXT NOT NULL,
          target_type TEXT,
          detected_type TEXT NOT NULL,
          confidence DOUBLE PRECISION NOT NULL DEFAULT 1.0,
          status TEXT NOT NULL DEFAULT 'preview' CHECK (status IN ('preview', 'confirmed', 'failed')),
          extracted_json TEXT NOT NULL,
          errors_json TEXT NOT NULL DEFAULT '[]',
          duplicates_json TEXT NOT NULL DEFAULT '[]',
          summary_json TEXT NOT NULL DEFAULT '{}',
          uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
          created_at TEXT NOT NULL,
          confirmed_at TEXT
        );

        ALTER TABLE import_batches ADD COLUMN IF NOT EXISTS target_type TEXT;
        ALTER TABLE import_batches ADD COLUMN IF NOT EXISTS summary_json TEXT NOT NULL DEFAULT '{}';

        CREATE TABLE IF NOT EXISTS sessions (
          id TEXT PRIMARY KEY,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          last_active_ms BIGINT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS app_config (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS room_presence (
          schedule_id INTEGER NOT NULL REFERENCES exam_schedules(id) ON DELETE CASCADE,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          nama TEXT NOT NULL,
          role TEXT NOT NULL,
          last_seen_ms BIGINT NOT NULL,
          PRIMARY KEY (schedule_id, user_id)
        );

        CREATE TABLE IF NOT EXISTS rate_limits (
          rate_key TEXT PRIMARY KEY,
          attempts INTEGER NOT NULL DEFAULT 0,
          locked_until_ms BIGINT NOT NULL DEFAULT 0
        );

        CREATE OR REPLACE FUNCTION sipenguji_prevent_audit_mutation()
        RETURNS TRIGGER AS $$
        BEGIN
          RAISE EXCEPTION 'Audit log bersifat append-only dan tidak dapat diubah atau dihapus';
        END;
        $$ LANGUAGE plpgsql;

        DROP TRIGGER IF EXISTS prevent_audit_update ON audit_logs;
        CREATE TRIGGER prevent_audit_update
          BEFORE UPDATE ON audit_logs
          FOR EACH ROW EXECUTE FUNCTION sipenguji_prevent_audit_mutation();

        DROP TRIGGER IF EXISTS prevent_audit_delete ON audit_logs;
        CREATE TRIGGER prevent_audit_delete
          BEFORE DELETE ON audit_logs
          FOR EACH ROW EXECUTE FUNCTION sipenguji_prevent_audit_mutation();
      `);
    })().catch((err) => {
      initPromise = null;
      throw err;
    });
  }
  await initPromise;
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

export async function appendAuditLog(params: {
  userId?: number | null;
  username?: string | null;
  aksi: string;
  entitas: string;
  entitasId?: string | number | null;
  nilaiLama?: unknown;
  nilaiBaru?: unknown;
  ip?: string | null;
}): Promise<void> {
  const now = getServerWibNow().isoWib;
  await execute(
    `INSERT INTO audit_logs (user_id, username, aksi, entitas, entitas_id, nilai_lama, nilai_baru, waktu_server, ip)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      params.userId ?? null,
      params.username ?? null,
      params.aksi,
      params.entitas,
      params.entitasId !== undefined && params.entitasId !== null ? String(params.entitasId) : null,
      params.nilaiLama !== undefined ? JSON.stringify(params.nilaiLama) : null,
      params.nilaiBaru !== undefined ? JSON.stringify(params.nilaiBaru) : null,
      now,
      params.ip ?? null,
    ]
  );
}

export async function createNotification(params: {
  userId: number;
  judul: string;
  isi: string;
  kategori?: string;
  linkTarget?: string | null;
}): Promise<number> {
  const now = getServerWibNow().isoWib;
  const row = await queryOne<{ id: number }>(
    `INSERT INTO notifications (user_id, judul, isi, kategori, link_target, dibaca, dibuat_pada)
     VALUES ($1, $2, $3, $4, $5, 0, $6)
     RETURNING id`,
    [params.userId, params.judul, params.isi, params.kategori ?? 'info', params.linkTarget ?? null, now]
  );
  return Number(row?.id ?? 0);
}

export async function notifyAllAdmins(params: {
  judul: string;
  isi: string;
  kategori?: string;
  linkTarget?: string | null;
}): Promise<number[]> {
  const admins = await query<{ id: number }>(
    `SELECT id FROM users WHERE role = 'admin' AND status = 'active'`
  );
  const ids: number[] = [];
  for (const a of admins) {
    const id = await createNotification({
      userId: a.id,
      judul: params.judul,
      isi: params.isi,
      kategori: params.kategori,
      linkTarget: params.linkTarget,
    });
    ids.push(id);
  }
  return ids;
}

export async function markGeneratedDocumentsStale(examId: number, client?: PoolClient): Promise<void> {
  await execute(
    `UPDATE generated_doc_versions SET needs_regeneration = 1 WHERE exam_id = $1`,
    [examId],
    client
  );
}

export async function ensureGeneratedDocRows(
  examId: number,
  userId: number | null,
  client?: PoolClient
): Promise<void> {
  const now = getServerWibNow().isoWib;
  for (const doc of ELEVEN_DOCS_CATALOG) {
    await execute(
      `INSERT INTO generated_doc_versions (exam_id, doc_key, title, version, needs_regeneration, generated_at, generated_by)
       VALUES ($1, $2, $3, 1, 0, $4, $5)
       ON CONFLICT (exam_id, doc_key) DO NOTHING`,
      [examId, doc.doc_key, doc.title, now, userId],
      client
    );
  }
}
