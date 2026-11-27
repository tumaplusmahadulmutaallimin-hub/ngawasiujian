import crypto from 'crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import * as XLSX from 'xlsx';
import {
  authenticateToken,
  checkRateLimit,
  clearFailedAttempts,
  createSessionToken,
  hashPassword,
  recordFailedAttempt,
  requireAdmin,
  requireAssignedSchedule,
  requireAuth,
  revokeSessionToken,
  verifyPassword,
  type AuthedRequest,
} from './auth.ts';
import {
  appendAuditLog,
  checkDatabaseHealth,
  createNotification,
  ELEVEN_DOCS_CATALOG,
  ensureDbReady,
  ensureGeneratedDocRows,
  execute,
  isDatabaseConfigured,
  markGeneratedDocumentsStale,
  notifyAllAdmins,
  query,
  queryOne,
  resolveDatabaseConfig,
  withTransaction,
} from './db.ts';
import {
  buildTemplateWorkbook,
  detectDuplicatesAndUnreadable,
  extractDocumentFromBuffer,
} from './extractor.ts';
import { commitImportBatch } from './importCommit.ts';
import {
  getBlobStatus,
  isBlobConfigured,
  loadPersistedDocumentBytes,
  persistDocumentBytes,
} from './storage.ts';
import {
  computeDurationSeconds,
  computeRemainingSeconds,
  computeScheduleStatus,
  getServerWibNow,
} from './time.ts';
import type {
  ChecklistDocStatus,
  DocumentChecklistItem,
  ImportDocType,
  ImportPageLog,
  ImportRowIssue,
  ImportSummaryReport,
  SupervisionScheduleItem,
} from '../src/types.ts';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

function asyncHandler(
  fn: (req: AuthedRequest, res: Response, next: NextFunction) => Promise<void> | void
) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req as AuthedRequest, res, next)).catch(next);
  };
}

function getClientIp(req: Request): string {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string') return fwd.split(',')[0].trim();
  return req.ip || 'unknown';
}

async function buildScheduleItems(
  rows: Array<Record<string, unknown>>,
  supervisorId?: number | null
): Promise<SupervisionScheduleItem[]> {
  if (rows.length === 0) return [];
  const scheduleIds = rows.map((r) => Number(r.id));
  const now = new Date();

  const allCoSups = await query<{
    exam_schedule_id: number;
    assignment_id: number;
    supervisor_id: number;
    peran: 'utama' | 'pendamping';
    nama_lengkap: string;
    nip_nuptk: string | null;
    waktu_hadir: string | null;
    att_status: string | null;
  }>(
    `SELECT sa.exam_schedule_id, sa.id AS assignment_id, sa.supervisor_id, sa.peran,
            s.nama_lengkap, s.nip_nuptk, att.waktu_hadir, att.status AS att_status
     FROM supervision_assignments sa
     JOIN supervisors s ON s.id = sa.supervisor_id
     LEFT JOIN supervisor_attendance att ON att.assignment_id = sa.id
     WHERE sa.exam_schedule_id = ANY($1::int[])`,
    [scheduleIds]
  );

  const allReports = await query<{ exam_schedule_id: number; status: string }>(
    `SELECT exam_schedule_id, status
     FROM supervision_reports
     WHERE exam_schedule_id = ANY($1::int[])`,
    [scheduleIds]
  );

  return rows.map((row) => {
    const id = Number(row.id);
    const tanggal = String(row.tanggal);
    const jamMulai = String(row.jam_mulai);
    const jamSelesai = String(row.jam_selesai);
    const computedStatus = computeScheduleStatus(
      tanggal,
      jamMulai,
      jamSelesai,
      Number(row.status_manual_cancel || 0),
      now
    );
    const remainingSeconds =
      computedStatus === 'aktif' ? computeRemainingSeconds(tanggal, jamSelesai, now) : 0;

    const coSups = allCoSups.filter((c) => Number(c.exam_schedule_id) === id);
    const reports = allReports.filter((r) => Number(r.exam_schedule_id) === id);

    let reportStatus: SupervisionScheduleItem['report_status'] = 'belum_dikerjakan';
    if (reports.some((r) => r.status === 'perlu_perbaikan')) reportStatus = 'perlu_perbaikan';
    else if (reports.length >= 2 && reports.every((r) => r.status === 'terverifikasi'))
      reportStatus = 'terverifikasi';
    else if (reports.some((r) => r.status === 'menunggu_verifikasi'))
      reportStatus = 'menunggu_verifikasi';
    else if (reports.length > 0) reportStatus = 'belum_dikirim';

    const mine = supervisorId ? coSups.find((c) => Number(c.supervisor_id) === supervisorId) : undefined;

    return {
      id,
      exam_id: Number(row.exam_id),
      exam_nama: String(row.exam_nama),
      madrasah_nama: String(row.madrasah_nama),
      tahun_ajaran: String(row.tahun_ajaran),
      warning_minutes_before_end: Number(row.warning_minutes_before_end ?? 15),
      session_id: Number(row.session_id),
      nama_sesi: String(row.nama_sesi),
      subject_id: Number(row.subject_id),
      subject_kode: String(row.subject_kode),
      subject_nama: String(row.subject_nama),
      room_id: Number(row.room_id),
      room_kode: String(row.room_kode),
      room_nama: String(row.room_nama),
      room_kapasitas: Number(row.room_kapasitas),
      tanggal,
      jam_mulai: jamMulai,
      jam_selesai: jamSelesai,
      computed_status: computedStatus,
      remaining_seconds: remainingSeconds,
      assignment_id: mine ? Number(mine.assignment_id) : undefined,
      peran: mine?.peran,
      supervisor_checked_in: Boolean(mine?.att_status === 'hadir'),
      co_supervisors: coSups.map((c) => ({
        supervisor_id: Number(c.supervisor_id),
        nama_lengkap: c.nama_lengkap,
        nip_nuptk: c.nip_nuptk,
        peran: c.peran,
        checked_in: c.att_status === 'hadir',
        waktu_hadir: c.waktu_hadir,
      })),
      report_status: reportStatus,
    };
  });
}

export function createApiRouter(): express.Router {
  const router = express.Router();

  // ========================
  // HEALTH & SERVER WIB TIME
  // ========================
  router.get(
    '/health',
    asyncHandler(async (_req, res) => {
      const blobStatus = getBlobStatus();
      const dbHealth = await checkDatabaseHealth();
      res.json({
        ok: true,
        databaseConfigured: dbHealth.databaseConfigured,
        databaseConnected: dbHealth.databaseConnected,
        databaseStatus: dbHealth.status,
        blobConfigured: blobStatus.blobConfigured,
        blobNotice: blobStatus.message,
        serverTime: getServerWibNow(),
      });
    })
  );

  router.get('/server-time', (_req, res) => {
    res.json(getServerWibNow());
  });

  // Ensure PostgreSQL is configured and initialized before all stateful API routes
  router.use(
    asyncHandler(async (_req, res, next) => {
      const cfg = resolveDatabaseConfig();
      if (cfg.status !== 'valid') {
        res.status(503).json({
          error:
            cfg.status === 'invalid_format'
              ? 'Format connection string PostgreSQL pada server tidak valid. Periksa log server.'
              : 'Database PostgreSQL (DATABASE_URL) belum dikonfigurasi pada Environment Variables Vercel.',
        });
        return;
      }
      await ensureDbReady();
      next();
    })
  );

  // ========================
  // AUTH & REGISTRATION
  // ========================
  router.get(
    '/auth/status',
    asyncHandler(async (_req, res) => {
      const adminRow = await queryOne<{ id: number }>(
        `SELECT id FROM users WHERE role = 'admin' LIMIT 1`
      );
      const envPasscodeConfigured = Boolean(
        process.env.ADMIN_PASSCODE && process.env.ADMIN_PASSCODE.trim() !== ''
      );
      res.json({
        hasAdmin: Boolean(adminRow),
        envPasscodeConfigured,
        needsAdminSetup: !adminRow && !envPasscodeConfigured,
      });
    })
  );

  router.post(
    '/auth/bootstrap-admin',
    asyncHandler(async (req, res) => {
      const existingAdmin = await queryOne<{ id: number }>(
        `SELECT id FROM users WHERE role = 'admin' LIMIT 1`
      );
      const envPasscode = process.env.ADMIN_PASSCODE?.trim();
      if (existingAdmin || envPasscode) {
        res.status(409).json({
          error: 'Akun Admin sudah tersedia atau diatur melalui ADMIN_PASSCODE di server.',
        });
        return;
      }

      const { username, password } = req.body as { username?: string; password?: string };
      const cleanUser = (username || '').trim();
      if (!cleanUser || cleanUser.length < 3) {
        res.status(400).json({ error: 'Username Admin minimal 3 karakter.' });
        return;
      }
      if (!password || password.length < 8) {
        res.status(400).json({ error: 'Password Admin minimal 8 karakter.' });
        return;
      }

      const now = getServerWibNow().isoWib;
      const hash = hashPassword(password);
      try {
        const inserted = await queryOne<{ id: number }>(
          `INSERT INTO users (username, password_hash, role, status, must_change_password, last_active_at, created_at)
           VALUES ($1, $2, 'admin', 'active', 0, $3, $4)
           RETURNING id`,
          [cleanUser, hash, now, now]
        );
        const userId = Number(inserted!.id);
        const token = await createSessionToken(userId);
        const user = await authenticateToken(token);
        await appendAuditLog({
          userId,
          username: cleanUser,
          aksi: 'ADMIN_BOOTSTRAP',
          entitas: 'users',
          entitasId: userId,
          nilaiBaru: { username: cleanUser, role: 'admin' },
          ip: getClientIp(req),
        });
        res.json({ token, user });
      } catch {
        res.status(409).json({ error: 'Username sudah digunakan.' });
      }
    })
  );

  router.post(
    '/auth/login',
    asyncHandler(async (req, res) => {
      const { username, password, expectedRole } = req.body as {
        username?: string;
        password?: string;
        expectedRole?: 'admin' | 'supervisor';
      };
      const cleanUser = (username || '').trim();
      const ip = getClientIp(req);
      const rateKey = `login:${ip}:${cleanUser}`;
      const rate = await checkRateLimit(rateKey);
      if (!rate.allowed) {
        res.status(429).json({
          error: `Terlalu banyak percobaan masuk gagal. Coba lagi dalam ${rate.retryAfterSec} detik atau hubungi Admin.`,
        });
        return;
      }

      if (!cleanUser || !password) {
        res.status(400).json({ error: 'Username dan password wajib diisi.' });
        return;
      }

      // Support server-configured ADMIN_PASSCODE only if no admin account exists yet
      const envPasscode = process.env.ADMIN_PASSCODE?.trim();
      const existingAdminForEnv = await queryOne<{ id: number }>(
        `SELECT id FROM users WHERE role = 'admin' LIMIT 1`
      );
      if (
        !existingAdminForEnv &&
        envPasscode &&
        expectedRole === 'admin' &&
        cleanUser === 'admin' &&
        password === envPasscode
      ) {
        const now = getServerWibNow().isoWib;
        const inserted = await queryOne<{ id: number }>(
          `INSERT INTO users (username, password_hash, role, status, must_change_password, last_active_at, created_at)
           VALUES ('admin', $1, 'admin', 'active', 1, $2, $3)
           RETURNING id`,
          [hashPassword(envPasscode), now, now]
        );
        const adminId = Number(inserted!.id);
        await clearFailedAttempts(rateKey);
        const token = await createSessionToken(adminId);
        const user = await authenticateToken(token);
        await appendAuditLog({
          userId: adminId,
          username: 'admin',
          aksi: 'LOGIN_ADMIN',
          entitas: 'users',
          entitasId: adminId,
          ip,
        });
        res.json({ token, user });
        return;
      }

      const row = await queryOne<{
        id: number;
        username: string;
        password_hash: string;
        role: 'admin' | 'supervisor';
        status: string;
        supervisor_status: string | null;
      }>(
        `SELECT u.id, u.username, u.password_hash, u.role, u.status,
                s.status AS supervisor_status
         FROM users u
         LEFT JOIN supervisors s ON s.user_id = u.id
         WHERE u.username = $1`,
        [cleanUser]
      );

      if (!row || !verifyPassword(password, row.password_hash)) {
        await recordFailedAttempt(rateKey);
        await appendAuditLog({
          username: cleanUser,
          aksi: 'LOGIN_FAILED',
          entitas: 'users',
          nilaiBaru: { reason: 'Kredensial salah' },
          ip,
        });
        res.status(401).json({ error: 'Username atau password tidak sesuai.' });
        return;
      }

      if (expectedRole && row.role !== expectedRole) {
        res.status(403).json({
          error:
            expectedRole === 'admin'
              ? 'Akun ini adalah akun Pengawas. Gunakan tab Masuk Pengawas.'
              : 'Akun ini adalah akun Admin. Gunakan tab Masuk Admin.',
        });
        return;
      }

      if (row.status !== 'active' || (row.role === 'supervisor' && row.supervisor_status === 'inactive')) {
        res.status(403).json({ error: 'Akun Anda dinonaktifkan oleh Admin Panitia.' });
        return;
      }

      await clearFailedAttempts(rateKey);
      const token = await createSessionToken(Number(row.id));
      const user = await authenticateToken(token);
      await appendAuditLog({
        userId: Number(row.id),
        username: row.username,
        aksi: row.role === 'admin' ? 'LOGIN_ADMIN' : 'LOGIN_SUPERVISOR',
        entitas: 'users',
        entitasId: row.id,
        ip,
      });
      res.json({ token, user });
    })
  );

  router.post(
    '/auth/logout',
    requireAuth,
    asyncHandler(async (req, res) => {
      if (req.authToken) await revokeSessionToken(req.authToken);
      await appendAuditLog({
        userId: req.authUser?.id,
        username: req.authUser?.username,
        aksi: 'LOGOUT',
        entitas: 'users',
        entitasId: req.authUser?.id,
        ip: getClientIp(req),
      });
      res.json({ ok: true });
    })
  );

  router.get('/auth/me', requireAuth, (req: AuthedRequest, res) => {
    res.json({ user: req.authUser, serverTime: getServerWibNow() });
  });

  router.post(
    '/auth/change-password',
    requireAuth,
    asyncHandler(async (req, res) => {
      const authUser = req.authUser!;
      const { currentPassword, newPassword } = req.body as {
        currentPassword?: string;
        newPassword?: string;
      };

      if (!currentPassword || !newPassword) {
        res.status(400).json({ error: 'Password saat ini dan password baru wajib diisi.' });
        return;
      }
      if (newPassword.length < 8) {
        res.status(400).json({ error: 'Password baru minimal 8 karakter.' });
        return;
      }
      if (newPassword === currentPassword) {
        res.status(400).json({ error: 'Password baru harus berbeda dari password saat ini.' });
        return;
      }

      const row = await queryOne<{ id: number; username: string; password_hash: string }>(
        `SELECT id, username, password_hash FROM users WHERE id = $1`,
        [authUser.id]
      );

      if (!row || !verifyPassword(currentPassword, row.password_hash)) {
        res.status(401).json({ error: 'Password saat ini tidak sesuai.' });
        return;
      }

      await execute(`UPDATE users SET password_hash = $1, must_change_password = 0 WHERE id = $2`, [
        hashPassword(newPassword),
        authUser.id,
      ]);

      await appendAuditLog({
        userId: authUser.id,
        username: authUser.username,
        aksi: 'CHANGE_PASSWORD',
        entitas: 'users',
        entitasId: authUser.id,
        nilaiBaru: { must_change_password: false },
        ip: getClientIp(req),
      });

      const updatedUser = await authenticateToken(req.authToken!);
      res.json({ ok: true, user: updatedUser });
    })
  );

  router.get(
    '/auth/supervisors-directory',
    asyncHandler(async (_req, res) => {
      const rows = await query<{
        id: number;
        nama_lengkap: string;
        nip_nuptk: string | null;
        user_id: number | null;
        kode_verifikasi: string | null;
        status: string;
      }>(
        `SELECT id, nama_lengkap, nip_nuptk, user_id, kode_verifikasi, status
         FROM supervisors
         WHERE status = 'active'
         ORDER BY nama_lengkap ASC`
      );

      res.json(
        rows.map((r) => ({
          id: Number(r.id),
          nama_lengkap: r.nama_lengkap,
          nip_masked: r.nip_nuptk ? `***${r.nip_nuptk.slice(-4)}` : null,
          requires_verification: Boolean(r.kode_verifikasi || r.nip_nuptk),
          already_registered: Boolean(r.user_id),
        }))
      );
    })
  );

  router.post(
    '/auth/register-supervisor',
    asyncHandler(async (req, res) => {
      const ip = getClientIp(req);
      const {
        supervisorId,
        verificationInput,
        username,
        password,
        nomor_identitas,
        tempat_lahir,
        tgl_lahir,
        alamat,
        whatsapp,
        foto_url,
        ttd_url,
      } = req.body as {
        supervisorId?: number;
        verificationInput?: string;
        username?: string;
        password?: string;
        nomor_identitas?: string;
        tempat_lahir?: string;
        tgl_lahir?: string;
        alamat?: string;
        whatsapp?: string;
        foto_url?: string;
        ttd_url?: string;
      };

      const rateKey = `reg:${ip}:${supervisorId}`;
      const rate = await checkRateLimit(rateKey);
      if (!rate.allowed) {
        res.status(429).json({
          error: `Verifikasi gagal berulang kali. Silakan coba lagi dalam ${rate.retryAfterSec} detik atau hubungi Admin.`,
        });
        return;
      }

      if (!supervisorId || !username || !password) {
        res.status(400).json({ error: 'Identitas pengawas, username, dan password wajib diisi.' });
        return;
      }
      if (password.length < 8) {
        res.status(400).json({ error: 'Password minimal 8 karakter.' });
        return;
      }
      if (!ttd_url) {
        res.status(400).json({
          error: 'Tanda tangan digital wajib dibuat untuk pelaporan berita acara.',
        });
        return;
      }

      const sup = await queryOne<Record<string, unknown>>(
        `SELECT * FROM supervisors WHERE id = $1 AND status = 'active'`,
        [supervisorId]
      );
      if (!sup) {
        res.status(404).json({
          error: 'Nama pengawas tidak ditemukan pada daftar resmi panitia (BR-02).',
        });
        return;
      }
      if (sup.user_id) {
        res.status(409).json({
          error: 'Akun untuk identitas ini sudah ada. Silakan masuk (BR-01).',
        });
        return;
      }

      const expectedKode = sup.kode_verifikasi ? String(sup.kode_verifikasi).trim() : '';
      const expectedNip = sup.nip_nuptk ? String(sup.nip_nuptk).trim() : '';
      const supplied = (verificationInput || '').trim();
      if (expectedKode || expectedNip) {
        const ok =
          (expectedKode && supplied.toLowerCase() === expectedKode.toLowerCase()) ||
          (expectedNip && (supplied === expectedNip || supplied === expectedNip.slice(-4)));
        if (!ok) {
          await recordFailedAttempt(rateKey);
          res.status(403).json({
            error:
              'Verifikasi identitas gagal. Masukkan kode verifikasi dari Admin atau 4 digit terakhir NIP/NUPTK Anda.',
          });
          return;
        }
      }

      const cleanUsername = username.trim();
      const existingUser = await queryOne<{ id: number }>(
        `SELECT id FROM users WHERE username = $1`,
        [cleanUsername]
      );
      if (existingUser) {
        res.status(409).json({
          error: 'Username sudah dipakai pengawas lain. Pilih username berbeda.',
        });
        return;
      }

      await clearFailedAttempts(rateKey);
      const now = getServerWibNow().isoWib;
      const hash = hashPassword(password);

      const newUserId = await withTransaction(async (client) => {
        const userRes = await queryOne<{ id: number }>(
          `INSERT INTO users (username, password_hash, role, status, last_active_at, created_at)
           VALUES ($1, $2, 'supervisor', 'active', $3, $4)
           RETURNING id`,
          [cleanUsername, hash, now, now],
          client
        );
        const userId = Number(userRes!.id);

        await execute(
          `UPDATE supervisors SET
             user_id = $1,
             nomor_identitas = COALESCE($2, nomor_identitas),
             tempat_lahir = COALESCE($3, tempat_lahir),
             tgl_lahir = COALESCE($4, tgl_lahir),
             alamat = COALESCE($5, alamat),
             whatsapp = COALESCE($6, whatsapp),
             foto_url = COALESCE($7, foto_url),
             ttd_url = $8
           WHERE id = $9`,
          [
            userId,
            nomor_identitas || null,
            tempat_lahir || null,
            tgl_lahir || null,
            alamat || null,
            whatsapp || null,
            foto_url || null,
            ttd_url,
            supervisorId,
          ],
          client
        );
        return userId;
      });

      const token = await createSessionToken(newUserId);
      const user = await authenticateToken(token);

      await appendAuditLog({
        userId: newUserId,
        username: cleanUsername,
        aksi: 'REGISTER_SUPERVISOR',
        entitas: 'supervisors',
        entitasId: supervisorId,
        nilaiBaru: { username: cleanUsername, nama_lengkap: sup.nama_lengkap },
        ip,
      });

      res.status(201).json({ token, user });
    })
  );

  router.post(
    '/auth/forgot-password',
    asyncHandler(async (req, res) => {
      const { username, catatan } = req.body as { username?: string; catatan?: string };
      const clean = (username || '').trim();
      if (!clean) {
        res.status(400).json({ error: 'Masukkan username Anda.' });
        return;
      }
      const user = await queryOne<{ id: number; username: string }>(
        `SELECT id, username FROM users WHERE username = $1`,
        [clean]
      );

      await notifyAllAdmins({
        judul: 'Permintaan Reset Password Pengawas',
        isi: `Username "${clean}" mengajukan reset password. Catatan: ${catatan || '-'}.`,
        kategori: 'akun',
        linkTarget: 'admin:supervisors',
      });
      await appendAuditLog({
        userId: user?.id ?? null,
        username: clean,
        aksi: 'FORGOT_PASSWORD_REQUEST',
        entitas: 'users',
        entitasId: user?.id ?? null,
        nilaiBaru: { catatan: catatan || '' },
        ip: getClientIp(req),
      });
      res.json({
        ok: true,
        message:
          'Permintaan reset password telah dikirim ke Panitia (Admin). Hubungi Admin untuk menerima password baru.',
      });
    })
  );

  // ========================
  // PROFILE (FR-PRF-01..03)
  // ========================
  router.get(
    '/profile',
    requireAuth,
    asyncHandler(async (req, res) => {
      const user = req.authUser!;
      if (user.role === 'admin') {
        res.json({ role: 'admin', username: user.username, nama_lengkap: user.namaLengkap });
        return;
      }
      const sup = await queryOne(`SELECT * FROM supervisors WHERE user_id = $1`, [user.id]);
      res.json({ role: 'supervisor', username: user.username, profile: sup });
    })
  );

  router.put(
    '/profile',
    requireAuth,
    asyncHandler(async (req, res) => {
      const user = req.authUser!;
      if (user.role !== 'supervisor' || !user.supervisorId) {
        res.status(403).json({ error: 'Profil pengawas tidak ditemukan.' });
        return;
      }
      const prev = await queryOne<Record<string, unknown>>(
        `SELECT * FROM supervisors WHERE id = $1`,
        [user.supervisorId]
      );
      const { nomor_identitas, tempat_lahir, tgl_lahir, alamat, whatsapp, foto_url, ttd_url } =
        req.body as Record<string, string | undefined>;

      await execute(
        `UPDATE supervisors SET
           nomor_identitas = COALESCE($1, nomor_identitas),
           tempat_lahir = COALESCE($2, tempat_lahir),
           tgl_lahir = COALESCE($3, tgl_lahir),
           alamat = COALESCE($4, alamat),
           whatsapp = COALESCE($5, whatsapp),
           foto_url = COALESCE($6, foto_url),
           ttd_url = COALESCE($7, ttd_url)
         WHERE id = $8`,
        [
          nomor_identitas ?? null,
          tempat_lahir ?? null,
          tgl_lahir ?? null,
          alamat ?? null,
          whatsapp ?? null,
          foto_url ?? null,
          ttd_url ?? null,
          user.supervisorId,
        ]
      );

      if (foto_url && foto_url !== prev?.foto_url) {
        await appendAuditLog({
          userId: user.id,
          username: user.username,
          aksi: 'UPDATE_PROFILE_PHOTO',
          entitas: 'supervisors',
          entitasId: user.supervisorId,
          nilaiLama: { foto_url: '[previous]' },
          nilaiBaru: { foto_url: '[updated]' },
          ip: getClientIp(req),
        });
      }
      if (ttd_url && ttd_url !== prev?.ttd_url) {
        await appendAuditLog({
          userId: user.id,
          username: user.username,
          aksi: 'UPDATE_SIGNATURE',
          entitas: 'supervisors',
          entitasId: user.supervisorId,
          nilaiLama: { ttd_url: '[previous]' },
          nilaiBaru: { ttd_url: '[updated]' },
          ip: getClientIp(req),
        });
      }

      const updated = await queryOne(`SELECT * FROM supervisors WHERE id = $1`, [user.supervisorId]);
      res.json({ profile: updated });
    })
  );

  // ========================
  // NOTIFICATIONS (FR-NOT)
  // ========================
  router.get(
    '/notifications',
    requireAuth,
    asyncHandler(async (req, res) => {
      const rows = await query(
        `SELECT * FROM notifications WHERE user_id = $1 ORDER BY id DESC LIMIT 100`,
        [req.authUser!.id]
      );
      res.json(rows);
    })
  );

  router.post(
    '/notifications/:id/read',
    requireAuth,
    asyncHandler(async (req, res) => {
      const id = Number(req.params.id);
      await execute(`UPDATE notifications SET dibaca = 1 WHERE id = $1 AND user_id = $2`, [
        id,
        req.authUser!.id,
      ]);
      res.json({ ok: true });
    })
  );

  router.post(
    '/notifications/read-all',
    requireAuth,
    asyncHandler(async (req, res) => {
      await execute(`UPDATE notifications SET dibaca = 1 WHERE user_id = $1`, [req.authUser!.id]);
      res.json({ ok: true });
    })
  );

  // ========================
  // ADMIN: EXAMS, ROOMS, SCHEDULES, SUPERVISORS
  // ========================
  router.get(
    '/admin/exams',
    requireAuth,
    requireAdmin,
    asyncHandler(async (_req, res) => {
      const exams = await query(`SELECT * FROM exams ORDER BY id DESC`);
      res.json(exams);
    })
  );

  router.post(
    '/admin/exams',
    requireAuth,
    requireAdmin,
    asyncHandler(async (req, res) => {
      const {
        nama,
        madrasah_nama,
        tahun_ajaran,
        tanggal_mulai,
        tanggal_selesai,
        warning_minutes_before_end,
      } = req.body as Record<string, string | number>;
      if (!nama || !tahun_ajaran || !tanggal_mulai || !tanggal_selesai) {
        res
          .status(400)
          .json({ error: 'Nama kegiatan, tahun ajaran, dan rentang tanggal wajib diisi.' });
        return;
      }
      if (String(tanggal_selesai) < String(tanggal_mulai)) {
        res
          .status(400)
          .json({ error: 'Tanggal selesai tidak boleh lebih awal dari tanggal mulai.' });
        return;
      }
      const now = getServerWibNow().isoWib;
      const inserted = await queryOne<Record<string, unknown>>(
        `INSERT INTO exams (nama, madrasah_nama, tahun_ajaran, tanggal_mulai, tanggal_selesai, status, warning_minutes_before_end, created_at)
         VALUES ($1, $2, $3, $4, $5, 'aktif', $6, $7)
         RETURNING *`,
        [
          String(nama),
          String(madrasah_nama || 'Madrasah Aliyah Negeri'),
          String(tahun_ajaran),
          String(tanggal_mulai),
          String(tanggal_selesai),
          Number(warning_minutes_before_end || 15),
          now,
        ]
      );
      const examId = Number(inserted!.id);
      await ensureGeneratedDocRows(examId, req.authUser!.id);
      await appendAuditLog({
        userId: req.authUser!.id,
        username: req.authUser!.username,
        aksi: 'CREATE_EXAM',
        entitas: 'exams',
        entitasId: examId,
        nilaiBaru: req.body,
        ip: getClientIp(req),
      });
      res.status(201).json(inserted);
    })
  );

  router.get(
    '/admin/rooms',
    requireAuth,
    requireAdmin,
    asyncHandler(async (_req, res) => {
      const rooms = await query<Record<string, unknown>>(`SELECT * FROM rooms ORDER BY kode ASC`);
      const seats = await query<Record<string, unknown>>(
        `SELECT s.*, st.nomor_peserta, st.nisn, st.nama AS student_nama, st.kelas
         FROM seats s
         LEFT JOIN students st ON st.id = s.student_id
         ORDER BY s.baris ASC, s.kolom ASC`
      );

      res.json(
        rooms.map((r) => ({
          ...r,
          seats: seats.filter((s) => Number(s.room_id) === Number(r.id)),
        }))
      );
    })
  );

  router.put(
    '/admin/rooms/:roomId/layout',
    requireAuth,
    requireAdmin,
    asyncHandler(async (req, res) => {
      const roomId = Number(req.params.roomId);
      const { rows_count, cols_count, denah_lingkungan_json, seats } = req.body as {
        rows_count?: number;
        cols_count?: number;
        denah_lingkungan_json?: string;
        seats?: Array<{ kode_kursi: string; baris: number; kolom: number; student_id?: number | null }>;
      };

      await withTransaction(async (client) => {
        if (rows_count && cols_count) {
          await execute(
            `UPDATE rooms SET rows_count = $1, cols_count = $2, denah_lingkungan_json = COALESCE($3, denah_lingkungan_json) WHERE id = $4`,
            [rows_count, cols_count, denah_lingkungan_json ?? null, roomId],
            client
          );
        }
        if (Array.isArray(seats)) {
          for (const s of seats) {
            await execute(
              `INSERT INTO seats (room_id, kode_kursi, baris, kolom, posisi_x, posisi_y, student_id)
               VALUES ($1, $2, $3, $4, $5, $6, $7)
               ON CONFLICT (room_id, kode_kursi) DO UPDATE SET
                 baris = EXCLUDED.baris,
                 kolom = EXCLUDED.kolom,
                 posisi_x = EXCLUDED.posisi_x,
                 posisi_y = EXCLUDED.posisi_y,
                 student_id = EXCLUDED.student_id`,
              [roomId, s.kode_kursi, s.baris, s.kolom, s.kolom, s.baris, s.student_id ?? null],
              client
            );
          }
        }
        const latestExam = await queryOne<{ id: number }>(
          `SELECT id FROM exams ORDER BY id DESC LIMIT 1`,
          [],
          client
        );
        if (latestExam) await markGeneratedDocumentsStale(Number(latestExam.id), client);
      });

      await appendAuditLog({
        userId: req.authUser!.id,
        username: req.authUser!.username,
        aksi: 'UPDATE_ROOM_LAYOUT',
        entitas: 'rooms',
        entitasId: roomId,
        nilaiBaru: { rows_count, cols_count, seatCount: seats?.length ?? 0 },
        ip: getClientIp(req),
      });

      res.json({ ok: true });
    })
  );

  router.get(
    '/admin/students',
    requireAuth,
    requireAdmin,
    asyncHandler(async (req, res) => {
      const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
      const kelas = typeof req.query.kelas === 'string' ? req.query.kelas.trim() : '';
      const sesi = typeof req.query.sesi === 'string' ? req.query.sesi.trim() : '';
      const ruang = typeof req.query.ruang === 'string' ? req.query.ruang.trim() : '';
      const status = typeof req.query.status === 'string' ? req.query.status.trim() : '';
      const exportAll = req.query.all === '1' || req.query.all === 'true';
      const page = Math.max(1, Number(req.query.page) || 1);
      const pageSize = Math.min(200, Math.max(10, Number(req.query.pageSize) || 25));

      const conditions: string[] = [];
      const params: unknown[] = [];

      if (q) {
        params.push(`%${q}%`);
        const idx = params.length;
        conditions.push(
          `(st.nama ILIKE $${idx} OR COALESCE(st.nisn, '') ILIKE $${idx} OR COALESCE(st.nis, '') ILIKE $${idx} OR st.nomor_peserta ILIKE $${idx})`
        );
      }
      if (kelas) {
        params.push(kelas);
        conditions.push(`st.kelas = $${params.length}`);
      }
      if (sesi) {
        params.push(sesi);
        conditions.push(`COALESCE(st.sesi, '') = $${params.length}`);
      }
      if (ruang) {
        params.push(ruang);
        conditions.push(`COALESCE(st.ruang, rm.kode, '') = $${params.length}`);
      }
      if (status) {
        params.push(status);
        conditions.push(`COALESCE(st.status, 'Aktif') = $${params.length}`);
      }

      const whereSql = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const baseFrom = `
        FROM students st
        LEFT JOIN LATERAL (
          SELECT se.room_id, se.kode_kursi
          FROM seats se
          WHERE se.student_id = st.id
          ORDER BY se.id ASC
          LIMIT 1
        ) se ON TRUE
        LEFT JOIN rooms rm ON rm.id = se.room_id
      `;

      const countRow = await queryOne<{ total: number }>(
        `SELECT COUNT(*)::int AS total ${baseFrom} ${whereSql}`,
        params
      );
      const total = Number(countRow?.total ?? 0);

      const selectSql = `
        SELECT st.id, st.exam_id, st.no_urut, st.nomor_peserta, st.nisn, st.nis, st.nama,
               st.jk, st.kelas, st.user_ujian, st.password_ujian, st.sesi,
               COALESCE(st.ruang, rm.kode) AS ruang,
               COALESCE(st.meja, se.kode_kursi) AS meja,
               COALESCE(st.status, 'Aktif') AS status,
               st.updated_at
        ${baseFrom}
        ${whereSql}
        ORDER BY
          CASE WHEN COALESCE(st.no_urut, '') ~ '^[0-9]+$' THEN st.no_urut::int ELSE 999999 END ASC,
          st.nomor_peserta ASC,
          st.id ASC
      `;

      const items = exportAll
        ? await query(selectSql, params)
        : await query(`${selectSql} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, [
            ...params,
            pageSize,
            (page - 1) * pageSize,
          ]);

      const [kelasRows, sesiRows, ruangRows, statusRows] = await Promise.all([
        query<{ val: string }>(`SELECT DISTINCT kelas AS val FROM students WHERE COALESCE(kelas, '') <> '' ORDER BY val ASC`),
        query<{ val: string }>(`SELECT DISTINCT sesi AS val FROM students WHERE COALESCE(sesi, '') <> '' ORDER BY val ASC`),
        query<{ val: string }>(
          `SELECT DISTINCT COALESCE(st.ruang, rm.kode) AS val
           FROM students st
           LEFT JOIN seats se ON se.student_id = st.id
           LEFT JOIN rooms rm ON rm.id = se.room_id
           WHERE COALESCE(st.ruang, rm.kode, '') <> ''
           ORDER BY val ASC`
        ),
        query<{ val: string }>(
          `SELECT DISTINCT COALESCE(status, 'Aktif') AS val FROM students ORDER BY val ASC`
        ),
      ]);

      res.json({
        items,
        total,
        page: exportAll ? 1 : page,
        pageSize: exportAll ? Math.max(1, total) : pageSize,
        totalPages: exportAll ? 1 : Math.max(1, Math.ceil(total / pageSize)),
        filterOptions: {
          kelasList: kelasRows.map((r) => r.val),
          sesiList: sesiRows.map((r) => r.val),
          ruangList: ruangRows.map((r) => r.val),
          statusList: statusRows.length > 0 ? statusRows.map((r) => r.val) : ['Aktif'],
        },
      });
    })
  );

  router.post(
    '/admin/students',
    requireAuth,
    requireAdmin,
    asyncHandler(async (req, res) => {
      const b = req.body as Record<string, unknown>;
      const nomorPeserta = b.nomor_peserta ? String(b.nomor_peserta).trim() : '';
      const nama = b.nama ? String(b.nama).trim() : '';
      const kelas = b.kelas ? String(b.kelas).trim() : '';
      if (!nomorPeserta || !nama || !kelas) {
        res.status(400).json({ error: 'Nomor Peserta, Nama Lengkap, dan Kelas wajib diisi.' });
        return;
      }

      let examId = b.exam_id ? Number(b.exam_id) : 0;
      if (!examId) {
        const latestExam = await queryOne<{ id: number }>(`SELECT id FROM exams ORDER BY id DESC LIMIT 1`);
        if (latestExam) {
          examId = Number(latestExam.id);
        } else {
          const today = getServerWibNow().date;
          const newExam = await queryOne<{ id: number }>(
            `INSERT INTO exams (nama, madrasah_nama, tahun_ajaran, tanggal_mulai, tanggal_selesai, status, warning_minutes_before_end, created_at)
             VALUES ($1, $2, $3, $4, $5, 'aktif', 15, $6) RETURNING id`,
            ['Asesmen Sumatif Akhir Tahun Madrasah', 'MAN 1 Nusantara', '2026/2027', today, today, getServerWibNow().isoWib]
          );
          examId = Number(newExam!.id);
          await ensureGeneratedDocRows(examId, req.authUser!.id);
        }
      }

      const dup = await queryOne<{ id: number }>(
        `SELECT id FROM students WHERE exam_id = $1 AND nomor_peserta = $2`,
        [examId, nomorPeserta]
      );
      if (dup) {
        res.status(409).json({ error: `Nomor Peserta "${nomorPeserta}" sudah terdaftar pada ujian ini.` });
        return;
      }

      const now = getServerWibNow().isoWib;
      const cleanOpt = (v: unknown) => (v !== null && v !== undefined && String(v).trim() !== '' ? String(v).trim() : null);
      const inserted = await queryOne(
        `INSERT INTO students (
           exam_id, no_urut, nomor_peserta, nisn, nis, nama, jk, kelas,
           user_ujian, password_ujian, sesi, ruang, meja, status, updated_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
         RETURNING *`,
        [
          examId,
          cleanOpt(b.no_urut),
          nomorPeserta,
          cleanOpt(b.nisn),
          cleanOpt(b.nis),
          nama,
          cleanOpt(b.jk),
          kelas,
          cleanOpt(b.user_ujian),
          cleanOpt(b.password_ujian),
          cleanOpt(b.sesi),
          cleanOpt(b.ruang),
          cleanOpt(b.meja),
          cleanOpt(b.status) || 'Aktif',
          now,
        ]
      );

      await appendAuditLog({
        userId: req.authUser!.id,
        username: req.authUser!.username,
        aksi: 'CREATE_STUDENT',
        entitas: 'students',
        entitasId: Number((inserted as { id: number }).id),
        nilaiBaru: { nomor_peserta: nomorPeserta, nama, kelas },
        ip: getClientIp(req),
      });

      res.status(201).json({ ok: true, student: inserted });
    })
  );

  router.put(
    '/admin/students/:id',
    requireAuth,
    requireAdmin,
    asyncHandler(async (req, res) => {
      const id = Number(req.params.id);
      const existing = await queryOne<Record<string, unknown>>(`SELECT * FROM students WHERE id = $1`, [id]);
      if (!existing) {
        res.status(404).json({ error: 'Data peserta tidak ditemukan.' });
        return;
      }

      const b = req.body as Record<string, unknown>;
      const nomorPeserta = b.nomor_peserta ? String(b.nomor_peserta).trim() : String(existing.nomor_peserta);
      const nama = b.nama ? String(b.nama).trim() : String(existing.nama);
      const kelas = b.kelas ? String(b.kelas).trim() : String(existing.kelas);
      if (!nomorPeserta || !nama || !kelas) {
        res.status(400).json({ error: 'Nomor Peserta, Nama Lengkap, dan Kelas wajib diisi.' });
        return;
      }

      if (nomorPeserta !== String(existing.nomor_peserta)) {
        const dup = await queryOne<{ id: number }>(
          `SELECT id FROM students WHERE exam_id = $1 AND nomor_peserta = $2 AND id <> $3`,
          [existing.exam_id, nomorPeserta, id]
        );
        if (dup) {
          res.status(409).json({ error: `Nomor Peserta "${nomorPeserta}" sudah digunakan peserta lain.` });
          return;
        }
      }

      const now = getServerWibNow().isoWib;
      const cleanOpt = (v: unknown) => (v !== null && v !== undefined && String(v).trim() !== '' ? String(v).trim() : null);
      const updated = await queryOne(
        `UPDATE students
         SET no_urut = $1, nomor_peserta = $2, nisn = $3, nis = $4, nama = $5,
             jk = $6, kelas = $7, user_ujian = $8, password_ujian = $9,
             sesi = $10, ruang = $11, meja = $12, status = $13, updated_at = $14
         WHERE id = $15
         RETURNING *`,
        [
          cleanOpt(b.no_urut),
          nomorPeserta,
          cleanOpt(b.nisn),
          cleanOpt(b.nis),
          nama,
          cleanOpt(b.jk),
          kelas,
          cleanOpt(b.user_ujian),
          cleanOpt(b.password_ujian),
          cleanOpt(b.sesi),
          cleanOpt(b.ruang),
          cleanOpt(b.meja),
          cleanOpt(b.status) || 'Aktif',
          now,
          id,
        ]
      );

      await appendAuditLog({
        userId: req.authUser!.id,
        username: req.authUser!.username,
        aksi: 'UPDATE_STUDENT',
        entitas: 'students',
        entitasId: id,
        nilaiLama: { nomor_peserta: existing.nomor_peserta, nama: existing.nama, kelas: existing.kelas },
        nilaiBaru: { nomor_peserta: nomorPeserta, nama, kelas },
        ip: getClientIp(req),
      });

      res.json({ ok: true, student: updated });
    })
  );

  router.delete(
    '/admin/students/:id',
    requireAuth,
    requireAdmin,
    asyncHandler(async (req, res) => {
      const id = Number(req.params.id);
      const existing = await queryOne<{ id: number; nomor_peserta: string; nama: string }>(
        `SELECT id, nomor_peserta, nama FROM students WHERE id = $1`,
        [id]
      );
      if (!existing) {
        res.status(404).json({ error: 'Data peserta tidak ditemukan.' });
        return;
      }

      await withTransaction(async (client) => {
        await execute(`UPDATE seats SET student_id = NULL WHERE student_id = $1`, [id], client);
        await execute(`DELETE FROM students WHERE id = $1`, [id], client);
      });

      await appendAuditLog({
        userId: req.authUser!.id,
        username: req.authUser!.username,
        aksi: 'DELETE_STUDENT',
        entitas: 'students',
        entitasId: id,
        nilaiLama: existing,
        ip: getClientIp(req),
      });

      res.json({ ok: true });
    })
  );

  router.get(
    '/admin/students/export/xlsx',
    requireAuth,
    requireAdmin,
    asyncHandler(async (req, res) => {
      const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
      const kelas = typeof req.query.kelas === 'string' ? req.query.kelas.trim() : '';
      const sesi = typeof req.query.sesi === 'string' ? req.query.sesi.trim() : '';
      const ruang = typeof req.query.ruang === 'string' ? req.query.ruang.trim() : '';
      const status = typeof req.query.status === 'string' ? req.query.status.trim() : '';

      const conditions: string[] = [];
      const params: unknown[] = [];
      if (q) {
        params.push(`%${q}%`);
        const idx = params.length;
        conditions.push(
          `(st.nama ILIKE $${idx} OR COALESCE(st.nisn, '') ILIKE $${idx} OR COALESCE(st.nis, '') ILIKE $${idx} OR st.nomor_peserta ILIKE $${idx})`
        );
      }
      if (kelas) {
        params.push(kelas);
        conditions.push(`st.kelas = $${params.length}`);
      }
      if (sesi) {
        params.push(sesi);
        conditions.push(`COALESCE(st.sesi, '') = $${params.length}`);
      }
      if (ruang) {
        params.push(ruang);
        conditions.push(`COALESCE(st.ruang, rm.kode, '') = $${params.length}`);
      }
      if (status) {
        params.push(status);
        conditions.push(`COALESCE(st.status, 'Aktif') = $${params.length}`);
      }

      const whereSql = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const rows = await query<Record<string, unknown>>(
        `SELECT st.no_urut, st.nisn, st.nis, st.nama, st.jk, st.kelas, st.nomor_peserta,
                st.user_ujian, st.password_ujian, st.sesi,
                COALESCE(st.ruang, rm.kode) AS ruang,
                COALESCE(st.meja, se.kode_kursi) AS meja,
                COALESCE(st.status, 'Aktif') AS status
         FROM students st
         LEFT JOIN LATERAL (
           SELECT se.room_id, se.kode_kursi FROM seats se WHERE se.student_id = st.id ORDER BY se.id ASC LIMIT 1
         ) se ON TRUE
         LEFT JOIN rooms rm ON rm.id = se.room_id
         ${whereSql}
         ORDER BY
           CASE WHEN COALESCE(st.no_urut, '') ~ '^[0-9]+$' THEN st.no_urut::int ELSE 999999 END ASC,
           st.nomor_peserta ASC,
           st.id ASC`,
        params
      );

      const headers = [
        'No',
        'NISN',
        'NIS',
        'Nama Lengkap',
        'JK',
        'Kelas',
        'Nomor Peserta',
        'User Ujian',
        'Password Ujian',
        'Sesi',
        'Ruang',
        'Meja',
        'Status',
      ];
      const aoa: string[][] = [
        headers,
        ...rows.map((r, idx) => [
          r.no_urut ? String(r.no_urut) : String(idx + 1),
          r.nisn ? String(r.nisn) : '',
          r.nis ? String(r.nis) : '',
          r.nama ? String(r.nama) : '',
          r.jk ? String(r.jk) : '',
          r.kelas ? String(r.kelas) : '',
          r.nomor_peserta ? String(r.nomor_peserta) : '',
          r.user_ujian ? String(r.user_ujian) : '',
          r.password_ujian ? String(r.password_ujian) : '',
          r.sesi ? String(r.sesi) : '',
          r.ruang ? String(r.ruang) : '',
          r.meja ? String(r.meja) : '',
          r.status ? String(r.status) : 'Aktif',
        ]),
      ];

      const ws = XLSX.utils.aoa_to_sheet(aoa);
      // Force string format on all cells so leading zeros (NISN/NIS/Nomor Peserta) stay intact
      for (const cellAddr of Object.keys(ws)) {
        if (cellAddr.startsWith('!')) continue;
        ws[cellAddr].t = 's';
        ws[cellAddr].z = '@';
      }
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Data Peserta');
      const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );
      res.setHeader('Content-Disposition', 'attachment; filename="Data_Peserta_SIPENGUJI.xlsx"');
      res.send(buf);
    })
  );

  router.get(
    '/admin/supervisors',
    requireAuth,
    requireAdmin,
    asyncHandler(async (_req, res) => {
      const rows = await query(
        `SELECT s.*, u.username, u.status AS user_status
         FROM supervisors s
         LEFT JOIN users u ON u.id = s.user_id
         ORDER BY s.nama_lengkap ASC`
      );
      res.json(rows);
    })
  );

  router.post(
    '/admin/supervisors/:id/toggle-status',
    requireAuth,
    requireAdmin,
    asyncHandler(async (req, res) => {
      const supId = Number(req.params.id);
      const sup = await queryOne<{
        id: number;
        user_id: number | null;
        status: 'active' | 'inactive';
        nama_lengkap: string;
      }>(`SELECT * FROM supervisors WHERE id = $1`, [supId]);
      if (!sup) {
        res.status(404).json({ error: 'Pengawas tidak ditemukan.' });
        return;
      }
      const nextStatus = sup.status === 'active' ? 'inactive' : 'active';
      await execute(`UPDATE supervisors SET status = $1 WHERE id = $2`, [nextStatus, supId]);
      if (sup.user_id) {
        await execute(`UPDATE users SET status = $1 WHERE id = $2`, [nextStatus, sup.user_id]);
      }
      await appendAuditLog({
        userId: req.authUser!.id,
        username: req.authUser!.username,
        aksi: 'TOGGLE_SUPERVISOR_STATUS',
        entitas: 'supervisors',
        entitasId: supId,
        nilaiLama: { status: sup.status },
        nilaiBaru: { status: nextStatus },
        ip: getClientIp(req),
      });
      res.json({ ok: true, status: nextStatus });
    })
  );

  router.post(
    '/admin/supervisors/:id/reset-password',
    requireAuth,
    requireAdmin,
    asyncHandler(async (req, res) => {
      const supId = Number(req.params.id);
      const { newPassword } = req.body as { newPassword?: string };
      if (!newPassword || newPassword.length < 8) {
        res.status(400).json({ error: 'Password baru minimal 8 karakter.' });
        return;
      }
      const sup = await queryOne<{ user_id: number | null; nama_lengkap: string }>(
        `SELECT user_id, nama_lengkap FROM supervisors WHERE id = $1`,
        [supId]
      );
      if (!sup || !sup.user_id) {
        res.status(400).json({ error: 'Pengawas belum memiliki akun terdaftar.' });
        return;
      }
      await execute(`UPDATE users SET password_hash = $1 WHERE id = $2`, [
        hashPassword(newPassword),
        sup.user_id,
      ]);
      await appendAuditLog({
        userId: req.authUser!.id,
        username: req.authUser!.username,
        aksi: 'ADMIN_RESET_PASSWORD',
        entitas: 'users',
        entitasId: sup.user_id,
        nilaiBaru: { supervisor: sup.nama_lengkap },
        ip: getClientIp(req),
      });
      res.json({ ok: true });
    })
  );

  router.get(
    '/admin/schedules',
    requireAuth,
    requireAdmin,
    asyncHandler(async (_req, res) => {
      const rows = await query<Record<string, unknown>>(
        `SELECT sch.*, ses.id AS session_id, ses.exam_id, ses.nama_sesi, ex.nama AS exam_nama, ex.madrasah_nama, ex.tahun_ajaran, ex.warning_minutes_before_end,
                sub.kode AS subject_kode, sub.nama AS subject_nama,
                rm.kode AS room_kode, rm.nama AS room_nama, rm.kapasitas AS room_kapasitas
         FROM exam_schedules sch
         JOIN exam_sessions ses ON ses.id = sch.exam_session_id
         JOIN exams ex ON ex.id = ses.exam_id
         JOIN subjects sub ON sub.id = sch.subject_id
         JOIN rooms rm ON rm.id = sch.room_id
         ORDER BY sch.tanggal DESC, sch.jam_mulai ASC`
      );
      res.json(await buildScheduleItems(rows));
    })
  );

  router.post(
    '/admin/schedules/:scheduleId/assign',
    requireAuth,
    requireAdmin,
    asyncHandler(async (req, res) => {
      const scheduleId = Number(req.params.scheduleId);
      const { supervisorId, peran } = req.body as {
        supervisorId?: number;
        peran?: 'utama' | 'pendamping';
      };
      if (!supervisorId || !peran) {
        res.status(400).json({ error: 'Pengawas dan peran wajib dipilih.' });
        return;
      }
      const sched = await queryOne<Record<string, unknown>>(
        `SELECT sch.*, ses.exam_id, rm.kode AS room_kode, sub.nama AS subject_nama
         FROM exam_schedules sch
         JOIN exam_sessions ses ON ses.id = sch.exam_session_id
         JOIN rooms rm ON rm.id = sch.room_id
         JOIN subjects sub ON sub.id = sch.subject_id
         WHERE sch.id = $1`,
        [scheduleId]
      );
      if (!sched) {
        res.status(404).json({ error: 'Jadwal tidak ditemukan.' });
        return;
      }

      const conflict = await queryOne<{ id: number }>(
        `SELECT sa.id FROM supervision_assignments sa
         JOIN exam_schedules es ON es.id = sa.exam_schedule_id
         WHERE sa.supervisor_id = $1 AND es.id != $2 AND es.tanggal = $3
           AND NOT (es.jam_selesai <= $4 OR es.jam_mulai >= $5)`,
        [supervisorId, scheduleId, sched.tanggal, sched.jam_mulai, sched.jam_selesai]
      );
      if (conflict) {
        res
          .status(409)
          .json({ error: 'Pengawas sudah memiliki tugas di ruang lain pada jam yang sama.' });
        return;
      }

      await execute(
        `INSERT INTO supervision_assignments (supervisor_id, room_id, exam_session_id, exam_schedule_id, peran, status_jadwal)
         VALUES ($1, $2, $3, $4, $5, 'akan_datang')
         ON CONFLICT (supervisor_id, exam_schedule_id) DO UPDATE SET peran = EXCLUDED.peran`,
        [supervisorId, sched.room_id, sched.exam_session_id, scheduleId, peran]
      );

      const sup = await queryOne<{ user_id: number | null; nama_lengkap: string }>(
        `SELECT user_id, nama_lengkap FROM supervisors WHERE id = $1`,
        [supervisorId]
      );

      if (sup?.user_id) {
        await createNotification({
          userId: Number(sup.user_id),
          judul: 'Penugasan Pengawasan Baru / Diperbarui',
          isi: `Anda ditugaskan sebagai pengawas ${peran} di Ruang ${sched.room_kode} (${sched.subject_nama}, ${sched.tanggal} ${sched.jam_mulai}-${sched.jam_selesai} WIB).`,
          kategori: 'jadwal',
          linkTarget: 'supervisor:schedules',
        });
      }

      await markGeneratedDocumentsStale(Number(sched.exam_id));
      await appendAuditLog({
        userId: req.authUser!.id,
        username: req.authUser!.username,
        aksi: 'ASSIGN_SUPERVISOR',
        entitas: 'supervision_assignments',
        entitasId: scheduleId,
        nilaiBaru: { supervisorId, peran },
        ip: getClientIp(req),
      });

      res.json({ ok: true });
    })
  );

  router.post(
    '/admin/schedules/:scheduleId/cancel',
    requireAuth,
    requireAdmin,
    asyncHandler(async (req, res) => {
      const scheduleId = Number(req.params.scheduleId);
      const { cancelled } = req.body as { cancelled: boolean };
      await execute(`UPDATE exam_schedules SET status_manual_cancel = $1 WHERE id = $2`, [
        cancelled ? 1 : 0,
        scheduleId,
      ]);

      const assignedUsers = await query<{ user_id: number }>(
        `SELECT s.user_id FROM supervision_assignments sa
         JOIN supervisors s ON s.id = sa.supervisor_id
         WHERE sa.exam_schedule_id = $1 AND s.user_id IS NOT NULL`,
        [scheduleId]
      );

      for (const u of assignedUsers) {
        await createNotification({
          userId: Number(u.user_id),
          judul: cancelled ? 'Jadwal Pengawasan Dibatalkan' : 'Jadwal Pengawasan Diaktifkan Kembali',
          isi: `Status jadwal pengawasan #${scheduleId} telah diperbarui oleh Panitia.`,
          kategori: 'jadwal',
          linkTarget: 'supervisor:schedules',
        });
      }

      await appendAuditLog({
        userId: req.authUser!.id,
        username: req.authUser!.username,
        aksi: cancelled ? 'CANCEL_SCHEDULE' : 'RESTORE_SCHEDULE',
        entitas: 'exam_schedules',
        entitasId: scheduleId,
        ip: getClientIp(req),
      });
      res.json({ ok: true });
    })
  );

  // ========================
  // ADMIN: IMPORT DOKUMEN SAUM (FR-IMP)
  // ========================
  router.get('/admin/import/template/:type', requireAuth, requireAdmin, (req, res) => {
    const type = String(req.params.type || 'jadwal_pengawasan');
    const buf = buildTemplateWorkbook(type);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="Template_SAUM_${type}.xlsx"`);
    res.send(buf);
  });

  router.get(
    '/admin/import/checklist',
    requireAuth,
    requireAdmin,
    asyncHandler(async (_req, res) => {
      const stages: Array<{
        stageKey: ImportDocType;
        label: string;
        required: boolean;
        aliases: ImportDocType[];
      }> = [
        {
          stageKey: 'data_peserta',
          label: '1. Data Peserta / DNPU',
          required: true,
          aliases: ['data_peserta', 'daftar_hadir_peserta'],
        },
        {
          stageKey: 'data_pengawas',
          label: '2. Data Pengawas',
          required: true,
          aliases: ['data_pengawas'],
        },
        {
          stageKey: 'denah_peserta',
          label: '3. Denah Peserta',
          required: true,
          aliases: ['denah_peserta', 'pembagian_ruang', 'denah_lingkungan'],
        },
        {
          stageKey: 'jadwal_pengawasan',
          label: '4. Jadwal Pengawasan',
          required: true,
          aliases: ['jadwal_pengawasan', 'jadwal_ujian'],
        },
        {
          stageKey: 'dokumen_pendukung',
          label: '5. Dokumen Pendukung Lainnya',
          required: false,
          aliases: ['dokumen_pendukung'],
        },
      ];

      const allBatches = await query<Record<string, unknown>>(
        `SELECT id, filename, target_type, detected_type, status, summary_json, errors_json, duplicates_json, extracted_json, created_at, confirmed_at
         FROM import_batches
         ORDER BY id DESC
         LIMIT 200`
      );

      const checklist: DocumentChecklistItem[] = stages.map((st) => {
        const latest = allBatches.find((b) => {
          const tt = b.target_type ? String(b.target_type) : '';
          const dt = b.detected_type ? String(b.detected_type) : '';
          if (tt) return tt === st.stageKey || st.aliases.includes(tt as ImportDocType);
          return dt === st.stageKey || st.aliases.includes(dt as ImportDocType);
        });

        if (!latest) {
          return {
            stageKey: st.stageKey,
            label: st.label,
            required: st.required,
            status: 'Belum Diunggah',
            latestBatchId: null,
            filename: null,
            uploadedAt: null,
            confirmedAt: null,
            totalRows: 0,
            readCount: 0,
            failedCount: 0,
            skippedCount: 0,
            insertedCount: 0,
            updatedCount: 0,
            unchangedCount: 0,
            duplicatesCount: 0,
            skipReasons: [],
            missingNote: st.required
              ? 'Dokumen wajib ini belum diunggah.'
              : 'Opsional — unggah bila ada surat keputusan atau dokumen pendukung.',
          };
        }

        let summaryObj: (Partial<ImportSummaryReport> & { pageLogs?: ImportPageLog[]; rowIssues?: ImportRowIssue[] }) | null = null;
        try {
          if (latest.summary_json) summaryObj = JSON.parse(String(latest.summary_json));
        } catch {
          summaryObj = null;
        }
        let errorsArr: Array<{ rowIndex?: number; field?: string; reason?: string }> = [];
        try {
          errorsArr = JSON.parse(String(latest.errors_json || '[]'));
        } catch {
          errorsArr = [];
        }
        let dupsArr: Array<{ rowIndex?: number; field?: string; value?: string; source?: string }> = [];
        try {
          dupsArr = JSON.parse(String(latest.duplicates_json || '[]'));
        } catch {
          dupsArr = [];
        }
        let extractedArr: unknown[] = [];
        try {
          extractedArr = JSON.parse(String(latest.extracted_json || '[]'));
        } catch {
          extractedArr = [];
        }

        const totalRows = Number(summaryObj?.totalRows ?? extractedArr.length ?? 0);
        const insertedCount = Number(summaryObj?.inserted ?? 0);
        const updatedCount = Number(summaryObj?.updated ?? 0);
        const unchangedCount = Number(summaryObj?.unchanged ?? 0);
        const duplicatesCount = Number(summaryObj?.duplicatesCount ?? dupsArr.length ?? 0);
        const failedCount = Number(summaryObj?.failedCount ?? errorsArr.filter((e) => (e.rowIndex ?? 0) >= 0).length ?? 0);
        const skippedCount = Number(summaryObj?.skippedCount ?? duplicatesCount + failedCount);
        const readCount =
          latest.status === 'confirmed'
            ? Number(summaryObj?.parsedCount ?? insertedCount + updatedCount + unchangedCount)
            : Math.max(0, totalRows - failedCount);

        const skipReasonsSet = new Set<string>();
        for (const fr of summaryObj?.failureReasons || []) {
          if (fr?.reason) skipReasonsSet.add(fr.reason);
        }
        for (const errItem of errorsArr) {
          if (errItem?.reason) skipReasonsSet.add(errItem.reason);
        }
        if (summaryObj?.archiveOnlyNote) skipReasonsSet.add(summaryObj.archiveOnlyNote);

        let status: ChecklistDocStatus = 'Belum Diunggah';
        let missingNote: string | null = null;
        const batchStatus = String(latest.status);

        if (batchStatus === 'failed') {
          status = 'Gagal Diproses';
          missingNote = errorsArr[0]?.reason || 'Proses ekstraksi gagal. Periksa berkas dan unggah ulang.';
        } else if (batchStatus === 'preview') {
          if (st.stageKey === 'dokumen_pendukung') {
            status = 'Berhasil Diunggah';
            missingNote = 'Menunggu konfirmasi simpan arsip oleh Admin.';
          } else {
            status = 'Perlu Pemeriksaan';
            missingNote =
              failedCount > 0 || duplicatesCount > 0
                ? `${failedCount} baris gagal validasi dan ${duplicatesCount} duplikat menunggu pemeriksaan sebelum KONFIRMASI SIMPAN.`
                : 'Data berhasil diekstrak ke pratinjau; klik KONFIRMASI SIMPAN untuk menyimpan permanen.';
          }
        } else if (batchStatus === 'confirmed') {
          if (st.stageKey === 'dokumen_pendukung') {
            status = 'Berhasil Diproses';
            missingNote = null;
          } else if (readCount === 0 || failedCount > 0) {
            status = 'Perlu Pemeriksaan';
            missingNote =
              readCount === 0
                ? 'Tidak ada baris valid yang tersimpan pada konfirmasi terakhir.'
                : `${failedCount} baris gagal / ${skippedCount} baris dilewati pada impor terakhir.`;
          } else {
            status = 'Berhasil Diproses';
            missingNote = null;
          }
        }

        return {
          stageKey: st.stageKey,
          label: st.label,
          required: st.required,
          status,
          latestBatchId: Number(latest.id),
          filename: latest.filename ? String(latest.filename) : null,
          uploadedAt: latest.created_at ? String(latest.created_at) : null,
          confirmedAt: latest.confirmed_at ? String(latest.confirmed_at) : null,
          totalRows,
          readCount,
          failedCount,
          skippedCount,
          insertedCount,
          updatedCount,
          unchangedCount,
          duplicatesCount,
          skipReasons: Array.from(skipReasonsSet).slice(0, 6),
          missingNote,
        };
      });

      const overallReady = checklist
        .filter((c) => c.required)
        .every((c) => c.status === 'Berhasil Diproses');

      res.json({ checklist, overallReady });
    })
  );

  router.get(
    '/admin/import/batches',
    requireAuth,
    requireAdmin,
    asyncHandler(async (_req, res) => {
      const rows = await query<Record<string, unknown>>(
        `SELECT id, exam_id, filename, sha256, target_type, detected_type, confidence, status, summary_json, created_at, confirmed_at
         FROM import_batches ORDER BY id DESC LIMIT 50`
      );
      res.json(
        rows.map((r) => {
          let summary: ImportSummaryReport | null = null;
          try {
            if (r.summary_json) summary = JSON.parse(String(r.summary_json));
          } catch {
            summary = null;
          }
          return {
            id: Number(r.id),
            exam_id: r.exam_id ? Number(r.exam_id) : null,
            filename: r.filename,
            sha256: r.sha256,
            target_type: r.target_type || null,
            detected_type: r.detected_type,
            confidence: Number(r.confidence),
            status: r.status,
            summary,
            created_at: r.created_at,
            confirmed_at: r.confirmed_at,
          };
        })
      );
    })
  );

  router.post(
    '/admin/import/upload',
    requireAuth,
    requireAdmin,
    upload.single('file'),
    asyncHandler(async (req, res) => {
      if (!req.file) {
        res.status(400).json({ error: 'Berkas dokumen wajib dipilih.' });
        return;
      }

      const validTargetTypes: ImportDocType[] = [
        'data_peserta',
        'data_pengawas',
        'jadwal_ujian',
        'jadwal_pengawasan',
        'pembagian_ruang',
        'denah_peserta',
        'daftar_hadir_peserta',
        'denah_lingkungan',
        'dokumen_pendukung',
      ];
      const targetTypeRaw = typeof req.body.targetType === 'string' ? req.body.targetType.trim() : '';
      const targetType = validTargetTypes.includes(targetTypeRaw as ImportDocType)
        ? (targetTypeRaw as ImportDocType)
        : null;

      const stored = await persistDocumentBytes({
        buffer: req.file.buffer,
        originalName: req.file.originalname,
        mimeType: req.file.mimetype,
        folder: 'saum-imports',
      });
      const examIdRaw = req.body.examId ? Number(req.body.examId) : null;
      const now = getServerWibNow().isoWib;

      // Informational check only: never block or skip processing on duplicate file hash
      const previousSameFile = await queryOne<{ id: number; filename: string; created_at: string }>(
        `SELECT id, filename, created_at FROM import_batches WHERE sha256 = $1 ORDER BY id DESC LIMIT 1`,
        [stored.sha256]
      );
      const fileDuplicateWarning = previousSameFile
        ? `File identik ("${previousSameFile.filename}") pernah diunggah pada ${previousSameFile.created_at}. Isi file tetap diperiksa ulang penuh tanpa memblokir.`
        : null;

      try {
        const extracted = await extractDocumentFromBuffer(
          req.file.buffer,
          req.file.originalname,
          req.file.mimetype,
          examIdRaw,
          targetType,
          fileDuplicateWarning
        );

        await execute(
          `INSERT INTO documents (exam_id, jenis, nama_file, path, mime_type, blob_url, file_bytes, sha256, uploaded_by, version, status_verifikasi, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 1, 'arsip_sumber', $10)`,
          [
            examIdRaw,
            `sumber_${extracted.detected_type}`,
            stored.safeFilename,
            stored.storagePath,
            stored.mimeType,
            stored.blobUrl,
            stored.fileBytes,
            stored.sha256,
            req.authUser!.id,
            now,
          ]
        );

        const summaryPayload = {
          ...extracted.summary,
          pageLogs: extracted.page_logs,
          rowIssues: extracted.row_issues,
          fileDuplicateWarning,
        };

        const batchInserted = await queryOne<{ id: number }>(
          `INSERT INTO import_batches (exam_id, filename, file_path, sha256, target_type, detected_type, confidence, status, extracted_json, errors_json, duplicates_json, summary_json, uploaded_by, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'preview', $8, $9, $10, $11, $12, $13)
           RETURNING id`,
          [
            examIdRaw,
            stored.safeFilename,
            stored.storagePath,
            stored.sha256,
            targetType || extracted.detected_type,
            extracted.detected_type,
            extracted.confidence,
            JSON.stringify(extracted.rows),
            JSON.stringify(extracted.unreadable_fields),
            JSON.stringify(extracted.duplicates),
            JSON.stringify(summaryPayload),
            req.authUser!.id,
            now,
          ]
        );

        const batchId = Number(batchInserted!.id);
        await appendAuditLog({
          userId: req.authUser!.id,
          username: req.authUser!.username,
          aksi: 'UPLOAD_IMPORT_DOCUMENT',
          entitas: 'import_batches',
          entitasId: batchId,
          nilaiBaru: {
            filename: stored.safeFilename,
            sha256: stored.sha256,
            target_type: targetType || extracted.detected_type,
            detected_type: extracted.detected_type,
            rowCount: extracted.rows.length,
          },
          ip: getClientIp(req),
        });

        res.json({
          id: batchId,
          exam_id: examIdRaw,
          filename: stored.safeFilename,
          sha256: stored.sha256,
          target_type: targetType || extracted.detected_type,
          detected_type: extracted.detected_type,
          confidence: extracted.confidence,
          status: 'preview',
          extracted_rows: extracted.rows,
          unreadable_fields: extracted.unreadable_fields,
          duplicates: extracted.duplicates,
          file_duplicate_warning: fileDuplicateWarning,
          page_logs: extracted.page_logs,
          row_issues: extracted.row_issues,
          summary: extracted.summary,
          created_at: now,
          confirmed_at: null,
          storage_provider: stored.storageProvider,
          blob_configured: isBlobConfigured(),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Gagal mengekstrak dokumen.';
        const pageLogs = ((err as { pageLogs?: ImportPageLog[] })?.pageLogs || []) as ImportPageLog[];
        const errSummary = {
          totalRows: 0,
          parsedCount: 0,
          inserted: 0,
          updated: 0,
          unchanged: 0,
          duplicatesCount: 0,
          failedCount: Math.max(1, pageLogs.filter((p) => p.status === 'failed').length),
          skippedCount: 0,
          failureReasons: [{ rowIndex: -1, field: 'file', reason: msg }],
          pageLogs,
          fileDuplicateWarning,
        };
        const batchFailed = await queryOne<{ id: number }>(
          `INSERT INTO import_batches (exam_id, filename, file_path, sha256, target_type, detected_type, confidence, status, extracted_json, errors_json, summary_json, uploaded_by, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, 0, 'failed', '[]', $7, $8, $9, $10)
           RETURNING id`,
          [
            examIdRaw,
            stored.safeFilename,
            stored.storagePath,
            stored.sha256,
            targetType || 'dokumen_pendukung',
            targetType || 'dokumen_pendukung',
            JSON.stringify([{ rowIndex: -1, field: 'file', reason: msg }]),
            JSON.stringify(errSummary),
            req.authUser!.id,
            now,
          ]
        );
        res.status(422).json({
          error: msg,
          batchId: Number(batchFailed!.id),
          page_logs: pageLogs,
          target_type: targetType || 'dokumen_pendukung',
        });
      }
    })
  );

  router.post(
    '/admin/import/sample-package',
    requireAuth,
    requireAdmin,
    asyncHandler(async (req, res) => {
      const nowWib = getServerWibNow();
      const today = nowWib.date;
      const nowDate = new Date();
      const startDt = new Date(nowDate.getTime() - 15 * 60 * 1000);
      const endDt = new Date(nowDate.getTime() + 75 * 60 * 1000);
      const fmtTime = (d: Date) => getServerWibNow(d).time.slice(0, 5);
      const startHHMM = fmtTime(startDt);
      const endHHMM = fmtTime(endDt);
      const nextStartDt = new Date(nowDate.getTime() + 90 * 60 * 1000);
      const nextEndDt = new Date(nowDate.getTime() + 180 * 60 * 1000);

      const supRows = [
        { nama_lengkap: 'Siti Aminah, S.Pd.', nip_nuptk: '198604122010012014', whatsapp: '081234567801', kode_verifikasi: 'PGW-01' },
        { nama_lengkap: 'Andi Pratama, M.Pd.', nip_nuptk: '198907182014031003', whatsapp: '081234567802', kode_verifikasi: 'PGW-02' },
        { nama_lengkap: 'Nur Hidayah, S.Ag.', nip_nuptk: '199103252019032009', whatsapp: '081234567803', kode_verifikasi: 'PGW-03' },
        { nama_lengkap: 'Ahmad Muzakki, S.Pd.I', nip_nuptk: '198711042015031002', whatsapp: '081234567804', kode_verifikasi: 'PGW-04' },
      ];

      const studentRows = [
        { nomor_peserta: 'UM-26-0101', nisn: '0084112201', nis: '24001', nama: 'Ahmad Fauzan', kelas: 'XII IPA 1', kode_ruang: 'R-01' },
        { nomor_peserta: 'UM-26-0102', nisn: '0084112202', nis: '24002', nama: 'Aisyah Zahra', kelas: 'XII IPA 1', kode_ruang: 'R-01' },
        { nomor_peserta: 'UM-26-0103', nisn: '0084112203', nis: '24003', nama: 'Muhammad Ridwan', kelas: 'XII IPA 1', kode_ruang: 'R-01' },
        { nomor_peserta: 'UM-26-0104', nisn: '0084112204', nis: '24004', nama: 'Nadia Safitri', kelas: 'XII IPA 1', kode_ruang: 'R-01' },
        { nomor_peserta: 'UM-26-0105', nisn: '0084112205', nis: '24005', nama: 'Fajar Ramadhan', kelas: 'XII IPA 1', kode_ruang: 'R-01' },
        { nomor_peserta: 'UM-26-0106', nisn: '0084112206', nis: '24006', nama: 'Salsabila Putri', kelas: 'XII IPA 1', kode_ruang: 'R-01' },
        { nomor_peserta: 'UM-26-0107', nisn: '0084112207', nis: '24007', nama: 'Ilham Akbar', kelas: 'XII IPA 1', kode_ruang: 'R-01' },
        { nomor_peserta: 'UM-26-0108', nisn: '0084112208', nis: '24008', nama: 'Rahmawati Dewi', kelas: 'XII IPA 1', kode_ruang: 'R-01' },
        { nomor_peserta: 'UM-26-0109', nisn: '0084112209', nis: '24009', nama: 'Bagus Prakoso', kelas: 'XII IPA 1', kode_ruang: 'R-01' },
        { nomor_peserta: 'UM-26-0110', nisn: '0084112210', nis: '24010', nama: 'Khairunnisa Azzahra', kelas: 'XII IPA 1', kode_ruang: 'R-01' },
        { nomor_peserta: 'UM-26-0111', nisn: '0084112211', nis: '24011', nama: 'Zaki Mubarak', kelas: 'XII IPA 1', kode_ruang: 'R-01' },
        { nomor_peserta: 'UM-26-0112', nisn: '0084112212', nis: '24012', nama: 'Mutia Hasanah', kelas: 'XII IPA 1', kode_ruang: 'R-01' },
        { nomor_peserta: 'UM-26-0201', nisn: '0084112301', nis: '24101', nama: 'Rizky Maulana', kelas: 'XII IPS 1', kode_ruang: 'R-02' },
        { nomor_peserta: 'UM-26-0202', nisn: '0084112302', nis: '24102', nama: 'Fatimah Az-Zahra', kelas: 'XII IPS 1', kode_ruang: 'R-02' },
        { nomor_peserta: 'UM-26-0203', nisn: '0084112303', nis: '24103', nama: 'Hendra Wijaya', kelas: 'XII IPS 1', kode_ruang: 'R-02' },
        { nomor_peserta: 'UM-26-0204', nisn: '0084112304', nis: '24104', nama: 'Laila Sari', kelas: 'XII IPS 1', kode_ruang: 'R-02' },
      ];

      const denahRows = studentRows.map((s, idx) => {
        const localIdx = s.kode_ruang === 'R-01' ? idx : idx - 12;
        const cols = s.kode_ruang === 'R-01' ? 4 : 2;
        const baris = Math.floor(localIdx / cols) + 1;
        const kolom = (localIdx % cols) + 1;
        return {
          kode_ruang: s.kode_ruang,
          nama_ruang: s.kode_ruang === 'R-01' ? 'Ruang 01 — Al-Khawarizmi' : 'Ruang 02 — Ibnu Sina',
          kapasitas: s.kode_ruang === 'R-01' ? 12 : 8,
          kode_kursi: `${String.fromCharCode(64 + baris)}${kolom}`,
          baris,
          kolom,
          nomor_peserta: s.nomor_peserta,
          nama: s.nama,
        };
      });

      const jadwalRows = [
        {
          nama_sesi: 'Sesi 1 (Berlangsung)',
          tanggal: today,
          jam_mulai: startHHMM,
          jam_selesai: endHHMM,
          kode_mapel: 'PAI-FIQ',
          mata_pelajaran: 'Fikih',
          kode_ruang: 'R-01',
          nama_ruang: 'Ruang 01 — Al-Khawarizmi',
          pengawas_utama: 'Siti Aminah, S.Pd.',
          pengawas_pendamping: 'Andi Pratama, M.Pd.',
        },
        {
          nama_sesi: 'Sesi 1 (Berlangsung)',
          tanggal: today,
          jam_mulai: startHHMM,
          jam_selesai: endHHMM,
          kode_mapel: 'PAI-FIQ',
          mata_pelajaran: 'Fikih',
          kode_ruang: 'R-02',
          nama_ruang: 'Ruang 02 — Ibnu Sina',
          pengawas_utama: 'Nur Hidayah, S.Ag.',
          pengawas_pendamping: 'Ahmad Muzakki, S.Pd.I',
        },
        {
          nama_sesi: 'Sesi 2 (Berikutnya)',
          tanggal: today,
          jam_mulai: fmtTime(nextStartDt),
          jam_selesai: fmtTime(nextEndDt),
          kode_mapel: 'ARB-01',
          mata_pelajaran: 'Bahasa Arab',
          kode_ruang: 'R-01',
          nama_ruang: 'Ruang 01 — Al-Khawarizmi',
          pengawas_utama: 'Siti Aminah, S.Pd.',
          pengawas_pendamping: 'Nur Hidayah, S.Ag.',
        },
      ];

      const batchesToRun: Array<{ filename: string; type: ImportDocType; rows: Array<Record<string, unknown>> }> = [
        { filename: 'SAUM_Data_Pengawas.xlsx', type: 'data_pengawas', rows: supRows },
        { filename: 'SAUM_Data_Peserta.xlsx', type: 'data_peserta', rows: studentRows },
        { filename: 'SAUM_Denah_Peserta.xlsx', type: 'denah_peserta', rows: denahRows },
        { filename: 'SAUM_Jadwal_Pengawasan.xlsx', type: 'jadwal_pengawasan', rows: jadwalRows },
      ];

      let createdCount = 0;
      for (const item of batchesToRun) {
        const ws = XLSX.utils.json_to_sheet(item.rows);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, 'Ekspor_SAUM');
        const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
        const sha256 = crypto.createHash('sha256').update(buf).digest('hex');

        const info = await queryOne<{ id: number }>(
          `INSERT INTO import_batches (filename, file_path, sha256, detected_type, confidence, status, extracted_json, errors_json, duplicates_json, uploaded_by, created_at)
           VALUES ($1, $2, $3, $4, 1.0, 'preview', $5, '[]', '[]', $6, $7)
           RETURNING id`,
          [
            item.filename,
            `sample://${item.filename}`,
            sha256,
            item.type,
            JSON.stringify(item.rows),
            req.authUser!.id,
            nowWib.isoWib,
          ]
        );

        const batchId = Number(info!.id);
        await commitImportBatch({
          batchId,
          docType: item.type,
          rows: item.rows,
          userId: req.authUser!.id,
        });
        createdCount++;
      }

      await appendAuditLog({
        userId: req.authUser!.id,
        username: req.authUser!.username,
        aksi: 'IMPORT_SAMPLE_SAUM_PACKAGE',
        entitas: 'import_batches',
        nilaiBaru: { batches: createdCount },
        ip: getClientIp(req),
      });

      res.json({ ok: true, batchesImported: createdCount });
    })
  );

  router.get(
    '/admin/import/:batchId',
    requireAuth,
    requireAdmin,
    asyncHandler(async (req, res) => {
      const batchId = Number(req.params.batchId);
      const row = await queryOne<Record<string, unknown>>(
        `SELECT * FROM import_batches WHERE id = $1`,
        [batchId]
      );
      if (!row) {
        res.status(404).json({ error: 'Batch impor tidak ditemukan.' });
        return;
      }
      let summaryObj: (ImportSummaryReport & { pageLogs?: ImportPageLog[]; rowIssues?: ImportRowIssue[]; fileDuplicateWarning?: string | null }) | null = null;
      try {
        if (row.summary_json) summaryObj = JSON.parse(String(row.summary_json));
      } catch {
        summaryObj = null;
      }

      res.json({
        id: Number(row.id),
        exam_id: row.exam_id ? Number(row.exam_id) : null,
        filename: row.filename,
        sha256: row.sha256,
        target_type: row.target_type || null,
        detected_type: row.detected_type,
        confidence: Number(row.confidence),
        status: row.status,
        extracted_rows: JSON.parse(String(row.extracted_json || '[]')),
        unreadable_fields: JSON.parse(String(row.errors_json || '[]')),
        duplicates: JSON.parse(String(row.duplicates_json || '[]')),
        file_duplicate_warning: summaryObj?.fileDuplicateWarning || null,
        page_logs: summaryObj?.pageLogs || [],
        row_issues: summaryObj?.rowIssues || [],
        summary: summaryObj,
        created_at: row.created_at,
        confirmed_at: row.confirmed_at,
      });
    })
  );

  router.put(
    '/admin/import/:batchId',
    requireAuth,
    requireAdmin,
    asyncHandler(async (req, res) => {
      const batchId = Number(req.params.batchId);
      const batch = await queryOne<Record<string, unknown>>(
        `SELECT * FROM import_batches WHERE id = $1`,
        [batchId]
      );
      if (!batch) {
        res.status(404).json({ error: 'Batch impor tidak ditemukan.' });
        return;
      }
      if (batch.status === 'confirmed') {
        res.status(400).json({ error: 'Batch yang sudah dikonfirmasi tidak dapat diubah.' });
        return;
      }

      const { detected_type, extracted_rows, exam_id } = req.body as {
        detected_type?: ImportDocType;
        extracted_rows?: Array<Record<string, unknown>>;
        exam_id?: number | null;
      };

      let existingSummary: { pageLogs?: ImportPageLog[]; fileDuplicateWarning?: string | null } = {};
      try {
        if (batch.summary_json) existingSummary = JSON.parse(String(batch.summary_json));
      } catch {
        existingSummary = {};
      }

      const nextType = (detected_type || batch.detected_type) as ImportDocType;
      const nextRows = extracted_rows || JSON.parse(String(batch.extracted_json || '[]'));
      const analysis = await detectDuplicatesAndUnreadable(
        nextType,
        nextRows,
        exam_id ?? (batch.exam_id as number | null),
        existingSummary.pageLogs || [],
        existingSummary.fileDuplicateWarning || null
      );

      const summaryPayload = {
        ...analysis.summary,
        pageLogs: existingSummary.pageLogs || [],
        rowIssues: analysis.row_issues,
        fileDuplicateWarning: existingSummary.fileDuplicateWarning || null,
      };

      await execute(
        `UPDATE import_batches
         SET detected_type = $1, extracted_json = $2, errors_json = $3, duplicates_json = $4, summary_json = $5, exam_id = $6
         WHERE id = $7`,
        [
          nextType,
          JSON.stringify(nextRows),
          JSON.stringify(analysis.unreadable_fields),
          JSON.stringify(analysis.duplicates),
          JSON.stringify(summaryPayload),
          exam_id ?? batch.exam_id ?? null,
          batchId,
        ]
      );

      await appendAuditLog({
        userId: req.authUser!.id,
        username: req.authUser!.username,
        aksi: 'CORRECT_IMPORT_PREVIEW',
        entitas: 'import_batches',
        entitasId: batchId,
        nilaiBaru: { detected_type: nextType, rowCount: nextRows.length },
        ip: getClientIp(req),
      });

      res.json({
        detected_type: nextType,
        extracted_rows: nextRows,
        unreadable_fields: analysis.unreadable_fields,
        duplicates: analysis.duplicates,
        row_issues: analysis.row_issues,
        summary: analysis.summary,
      });
    })
  );

  router.post(
    '/admin/import/:batchId/confirm',
    requireAuth,
    requireAdmin,
    asyncHandler(async (req, res) => {
      const batchId = Number(req.params.batchId);
      const batch = await queryOne<Record<string, unknown>>(
        `SELECT * FROM import_batches WHERE id = $1`,
        [batchId]
      );
      if (!batch) {
        res.status(404).json({ error: 'Batch impor tidak ditemukan.' });
        return;
      }
      if (batch.status === 'confirmed') {
        res.status(400).json({ error: 'Batch impor ini sudah dikonfirmasi sebelumnya.' });
        return;
      }

      const body = req.body as {
        detected_type?: ImportDocType;
        extracted_rows?: Array<Record<string, unknown>>;
        exam_id?: number | null;
      };

      let prevSummary: { pageLogs?: ImportPageLog[]; fileDuplicateWarning?: string | null } = {};
      try {
        if (batch.summary_json) prevSummary = JSON.parse(String(batch.summary_json));
      } catch {
        prevSummary = {};
      }

      const docType = (body.detected_type || batch.detected_type) as ImportDocType;
      const rows = body.extracted_rows || JSON.parse(String(batch.extracted_json || '[]'));

      const commitSummary = await commitImportBatch({
        batchId,
        docType,
        rows,
        examId: body.exam_id ?? (batch.exam_id as number | null),
        userId: req.authUser!.id,
      });

      const mergedSummary: ImportSummaryReport & { examId: number } = {
        ...commitSummary,
        pageLogs: prevSummary.pageLogs || [],
        fileDuplicateWarning: prevSummary.fileDuplicateWarning || null,
      };

      await execute(`UPDATE import_batches SET summary_json = $1 WHERE id = $2`, [
        JSON.stringify(mergedSummary),
        batchId,
      ]);

      await appendAuditLog({
        userId: req.authUser!.id,
        username: req.authUser!.username,
        aksi: 'CONFIRM_IMPORT_BATCH',
        entitas: 'import_batches',
        entitasId: batchId,
        nilaiBaru: {
          docType,
          totalRows: mergedSummary.totalRows,
          inserted: mergedSummary.inserted,
          updated: mergedSummary.updated,
          unchanged: mergedSummary.unchanged,
          duplicatesCount: mergedSummary.duplicatesCount,
          failedCount: mergedSummary.failedCount,
        },
        ip: getClientIp(req),
      });

      res.json({ ok: true, ...mergedSummary });
    })
  );

  // ========================
  // ADMIN: 11 GENERATED DOCUMENTS (FR-GEN)
  // ========================
  router.get(
    '/admin/documents/generated',
    requireAuth,
    asyncHandler(async (_req, res) => {
      const exam = await queryOne<Record<string, unknown>>(`SELECT * FROM exams ORDER BY id DESC LIMIT 1`);
      if (!exam) {
        res.json({ exam: null, catalog: ELEVEN_DOCS_CATALOG, versions: [] });
        return;
      }
      await ensureGeneratedDocRows(Number(exam.id), null);
      const versions = await query(
        `SELECT * FROM generated_doc_versions WHERE exam_id = $1 ORDER BY id ASC`,
        [exam.id]
      );
      res.json({ exam, catalog: ELEVEN_DOCS_CATALOG, versions });
    })
  );

  router.post(
    '/admin/documents/generated/regenerate',
    requireAuth,
    requireAdmin,
    asyncHandler(async (req, res) => {
      const { examId, docKey } = req.body as { examId?: number; docKey?: string };
      const exam = examId
        ? await queryOne<{ id: number }>(`SELECT id FROM exams WHERE id = $1`, [examId])
        : await queryOne<{ id: number }>(`SELECT id FROM exams ORDER BY id DESC LIMIT 1`);
      if (!exam) {
        res.status(404).json({ error: 'Kegiatan ujian belum ada.' });
        return;
      }
      const eid = Number(exam.id);
      await ensureGeneratedDocRows(eid, req.authUser!.id);
      const now = getServerWibNow().isoWib;

      if (docKey) {
        await execute(
          `UPDATE generated_doc_versions
           SET version = version + 1, needs_regeneration = 0, generated_at = $1, generated_by = $2
           WHERE exam_id = $3 AND doc_key = $4`,
          [now, req.authUser!.id, eid, docKey]
        );
      } else {
        await execute(
          `UPDATE generated_doc_versions
           SET version = version + 1, needs_regeneration = 0, generated_at = $1, generated_by = $2
           WHERE exam_id = $3`,
          [now, req.authUser!.id, eid]
        );
      }

      await appendAuditLog({
        userId: req.authUser!.id,
        username: req.authUser!.username,
        aksi: 'GENERATE_ADMINISTRATION_DOCS',
        entitas: 'generated_doc_versions',
        entitasId: eid,
        nilaiBaru: { docKey: docKey || 'ALL_11_DOCS' },
        ip: getClientIp(req),
      });

      const versions = await query(
        `SELECT * FROM generated_doc_versions WHERE exam_id = $1 ORDER BY id ASC`,
        [eid]
      );
      res.json({ ok: true, versions });
    })
  );

  // ========================
  // ADMIN: MONITORING, REPORTS VERIFICATION, AUDIT LOGS, EXPORT
  // ========================
  router.get(
    '/admin/monitoring',
    requireAuth,
    requireAdmin,
    asyncHandler(async (_req, res) => {
      const now = new Date();
      const schedulesRaw = await query<Record<string, unknown>>(
        `SELECT sch.*, ses.id AS session_id, ses.exam_id, ses.nama_sesi, ex.nama AS exam_nama, ex.madrasah_nama, ex.tahun_ajaran, ex.warning_minutes_before_end,
                sub.kode AS subject_kode, sub.nama AS subject_nama,
                rm.kode AS room_kode, rm.nama AS room_nama, rm.kapasitas AS room_kapasitas
         FROM exam_schedules sch
         JOIN exam_sessions ses ON ses.id = sch.exam_session_id
         JOIN exams ex ON ex.id = ses.exam_id
         JOIN subjects sub ON sub.id = sch.subject_id
         JOIN rooms rm ON rm.id = sch.room_id
         ORDER BY sch.tanggal DESC, sch.jam_mulai ASC`
      );

      const schedules = await buildScheduleItems(schedulesRaw);

      const countsRow = await queryOne<{
        total_supervisors: number;
        total_rooms: number;
        total_sessions: number;
        checked_in_supervisors: number;
        student_hadir: number;
        student_tidak_hadir: number;
        active_exits: number;
        total_exits: number;
        total_warnings: number;
        submitted_reports: number;
        unverified_reports: number;
      }>(`
        SELECT
          (SELECT COUNT(*)::int FROM supervisors WHERE status = 'active') AS total_supervisors,
          (SELECT COUNT(*)::int FROM rooms) AS total_rooms,
          (SELECT COUNT(*)::int FROM exam_sessions) AS total_sessions,
          (SELECT COUNT(DISTINCT sa.supervisor_id)::int FROM supervisor_attendance att JOIN supervision_assignments sa ON sa.id = att.assignment_id WHERE att.status = 'hadir') AS checked_in_supervisors,
          (SELECT COUNT(*)::int FROM attendance WHERE status = 'hadir') AS student_hadir,
          (SELECT COUNT(*)::int FROM attendance WHERE status = 'tidak_hadir') AS student_tidak_hadir,
          (SELECT COUNT(*)::int FROM exit_permissions WHERE waktu_kembali IS NULL) AS active_exits,
          (SELECT COUNT(*)::int FROM exit_permissions) AS total_exits,
          (SELECT COUNT(*)::int FROM warnings WHERE is_correction = 0) AS total_warnings,
          (SELECT COUNT(*)::int FROM supervision_reports WHERE status IN ('menunggu_verifikasi', 'perlu_perbaikan', 'terverifikasi')) AS submitted_reports,
          (SELECT COUNT(*)::int FROM supervision_reports WHERE status = 'menunggu_verifikasi') AS unverified_reports
      `);

      const level3Alerts = await query(
        `SELECT w.*, st.nama AS student_nama, st.nomor_peserta, st.kelas,
                rm.kode AS room_kode, rm.nama AS room_nama, sub.nama AS subject_nama
         FROM warnings w
         JOIN students st ON st.id = w.student_id
         JOIN exam_schedules es ON es.id = w.exam_schedule_id
         JOIN rooms rm ON rm.id = es.room_id
         JOIN subjects sub ON sub.id = es.subject_id
         WHERE w.tingkat = 3
         ORDER BY w.id DESC LIMIT 30`
      );

      const activeRooms = schedules.filter((s) => s.computed_status === 'aktif');
      const totalSupervisors = Number(countsRow?.total_supervisors || 0);
      const checkedInSupervisors = Number(countsRow?.checked_in_supervisors || 0);

      res.json({
        serverTime: getServerWibNow(now),
        summary: {
          totalSupervisors,
          checkedInSupervisors,
          absentSupervisors: Math.max(0, totalSupervisors - checkedInSupervisors),
          totalRooms: Number(countsRow?.total_rooms || 0),
          totalSessions: Number(countsRow?.total_sessions || 0),
          activeRoomsCount: activeRooms.length,
          studentHadir: Number(countsRow?.student_hadir || 0),
          studentTidakHadir: Number(countsRow?.student_tidak_hadir || 0),
          activeExits: Number(countsRow?.active_exits || 0),
          totalExits: Number(countsRow?.total_exits || 0),
          totalWarnings: Number(countsRow?.total_warnings || 0),
          level3Count: level3Alerts.length,
          submittedReports: Number(countsRow?.submitted_reports || 0),
          unverifiedReports: Number(countsRow?.unverified_reports || 0),
        },
        schedules,
        level3Alerts,
      });
    })
  );

  router.get(
    '/admin/reports',
    requireAuth,
    requireAdmin,
    asyncHandler(async (_req, res) => {
      const rows = await query<Record<string, unknown>>(
        `SELECT sr.*, s.nama_lengkap AS supervisor_nama, s.nip_nuptk,
                es.tanggal, es.jam_mulai, es.jam_selesai,
                rm.kode AS room_kode, rm.nama AS room_nama,
                sub.nama AS subject_nama
         FROM supervision_reports sr
         JOIN supervisors s ON s.id = sr.supervisor_id
         JOIN exam_schedules es ON es.id = sr.exam_schedule_id
         JOIN rooms rm ON rm.id = es.room_id
         JOIN subjects sub ON sub.id = es.subject_id
         ORDER BY sr.id DESC`
      );

      const verifs = await query<Record<string, unknown>>(
        `SELECT rv.*, u.username AS admin_nama
         FROM report_verifications rv
         JOIN users u ON u.id = rv.admin_id
         ORDER BY rv.id DESC`
      );

      res.json(
        rows.map((r) => ({
          ...r,
          verifications: verifs.filter((v) => Number(v.report_id) === Number(r.id)),
        }))
      );
    })
  );

  router.post(
    '/admin/reports/:reportId/verify',
    requireAuth,
    requireAdmin,
    asyncHandler(async (req, res) => {
      const reportId = Number(req.params.reportId);
      const { status, catatan } = req.body as {
        status?: 'terverifikasi' | 'perlu_perbaikan';
        catatan?: string;
      };
      if (status !== 'terverifikasi' && status !== 'perlu_perbaikan') {
        res.status(400).json({ error: 'Status verifikasi tidak valid.' });
        return;
      }
      if (status === 'perlu_perbaikan' && (!catatan || catatan.trim() === '')) {
        res
          .status(400)
          .json({ error: 'Catatan wajib diisi ketika meminta perbaikan laporan.' });
        return;
      }

      const report = await queryOne<{
        id: number;
        status: string;
        supervisor_user_id: number | null;
        jenis: string;
        exam_schedule_id: number;
      }>(
        `SELECT sr.*, s.user_id AS supervisor_user_id
         FROM supervision_reports sr
         JOIN supervisors s ON s.id = sr.supervisor_id
         WHERE sr.id = $1`,
        [reportId]
      );

      if (!report) {
        res.status(404).json({ error: 'Laporan tidak ditemukan.' });
        return;
      }

      const now = getServerWibNow().isoWib;
      await withTransaction(async (client) => {
        await execute(
          `UPDATE supervision_reports SET status = $1 WHERE id = $2`,
          [status, reportId],
          client
        );
        await execute(
          `INSERT INTO report_verifications (report_id, admin_id, status, catatan, waktu) VALUES ($1, $2, $3, $4, $5)`,
          [reportId, req.authUser!.id, status, catatan || null, now],
          client
        );
      });

      if (report.supervisor_user_id) {
        await createNotification({
          userId: Number(report.supervisor_user_id),
          judul:
            status === 'terverifikasi'
              ? 'Laporan Pengawasan Terverifikasi'
              : 'Laporan Pengawasan Perlu Perbaikan',
          isi:
            status === 'terverifikasi'
              ? `Dokumen ${report.jenis === 'berita_acara' ? 'Berita Acara' : 'Daftar Hadir'} Anda telah diverifikasi Admin.`
              : `Admin meminta perbaikan pada ${report.jenis === 'berita_acara' ? 'Berita Acara' : 'Daftar Hadir'}: ${catatan}`,
          kategori: 'laporan',
          linkTarget: `supervisor:reports:${report.exam_schedule_id}`,
        });
      }

      await appendAuditLog({
        userId: req.authUser!.id,
        username: req.authUser!.username,
        aksi: 'VERIFY_REPORT',
        entitas: 'supervision_reports',
        entitasId: reportId,
        nilaiLama: { status: report.status },
        nilaiBaru: { status, catatan },
        ip: getClientIp(req),
      });

      res.json({ ok: true });
    })
  );

  router.get(
    '/admin/audit-logs',
    requireAuth,
    requireAdmin,
    asyncHandler(async (req, res) => {
      const limit = Math.min(300, Math.max(20, Number(req.query.limit) || 150));
      const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
      if (q) {
        const like = `%${q}%`;
        const rows = await query(
          `SELECT * FROM audit_logs
           WHERE aksi ILIKE $1 OR entitas ILIKE $2 OR COALESCE(username, '') ILIKE $3
           ORDER BY id DESC LIMIT $4`,
          [like, like, like, limit]
        );
        res.json(rows);
        return;
      }
      const rows = await query(`SELECT * FROM audit_logs ORDER BY id DESC LIMIT $1`, [limit]);
      res.json(rows);
    })
  );

  router.get(
    '/admin/recap/export',
    requireAuth,
    requireAdmin,
    asyncHandler(async (req, res) => {
      const format = req.query.format === 'csv' ? 'csv' : 'xlsx';
      const schedulesRaw = await query<Record<string, unknown>>(
        `SELECT sch.id, ses.nama_sesi, ex.nama AS kegiatan, sch.tanggal, sch.jam_mulai, sch.jam_selesai,
                rm.kode AS kode_ruang, rm.nama AS nama_ruang, sub.nama AS mata_pelajaran,
                (SELECT COUNT(*)::int FROM attendance WHERE exam_schedule_id = sch.id AND status = 'hadir') AS hadir,
                (SELECT COUNT(*)::int FROM attendance WHERE exam_schedule_id = sch.id AND status = 'tidak_hadir') AS tidak_hadir,
                (SELECT COUNT(*)::int FROM warnings WHERE exam_schedule_id = sch.id AND tingkat = 1 AND is_correction = 0) AS p1,
                (SELECT COUNT(*)::int FROM warnings WHERE exam_schedule_id = sch.id AND tingkat = 2 AND is_correction = 0) AS p2,
                (SELECT COUNT(*)::int FROM warnings WHERE exam_schedule_id = sch.id AND tingkat = 3 AND is_correction = 0) AS p3,
                (SELECT COUNT(*)::int FROM exit_permissions WHERE exam_schedule_id = sch.id) AS izin_keluar,
                (SELECT COUNT(*)::int FROM incident_reports WHERE exam_schedule_id = sch.id) AS kejadian
         FROM exam_schedules sch
         JOIN exam_sessions ses ON ses.id = sch.exam_session_id
         JOIN exams ex ON ex.id = ses.exam_id
         JOIN rooms rm ON rm.id = sch.room_id
         JOIN subjects sub ON sub.id = sch.subject_id
         ORDER BY sch.tanggal ASC, sch.jam_mulai ASC`
      );

      const recapRows = schedulesRaw.map((s) => ({
        Kegiatan: s.kegiatan,
        Sesi: s.nama_sesi,
        Tanggal: s.tanggal,
        Waktu_WIB: `${s.jam_mulai}-${s.jam_selesai}`,
        Ruang: `${s.kode_ruang} - ${s.nama_ruang}`,
        Mata_Pelajaran: s.mata_pelajaran,
        Peserta_Hadir: Number(s.hadir || 0),
        Peserta_Tidak_Hadir: Number(s.tidak_hadir || 0),
        Peringatan_1: Number(s.p1 || 0),
        Peringatan_2: Number(s.p2 || 0),
        Peringatan_3: Number(s.p3 || 0),
        Izin_Keluar: Number(s.izin_keluar || 0),
        Catatan_Kejadian: Number(s.kejadian || 0),
      }));

      const ws = XLSX.utils.json_to_sheet(recapRows);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Rekap_Pengawasan');
      if (format === 'csv') {
        const csv = XLSX.utils.sheet_to_csv(ws);
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="Rekap_SIPENGUJI.csv"');
        res.send(csv);
        return;
      }
      const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );
      res.setHeader('Content-Disposition', 'attachment; filename="Rekap_SIPENGUJI.xlsx"');
      res.send(buf);
    })
  );

  // ========================
  // SUPERVISOR: DASHBOARD & SCHEDULES
  // ========================
  router.get(
    '/supervisor/schedules',
    requireAuth,
    asyncHandler(async (req, res) => {
      const user = req.authUser!;
      if (user.role === 'admin') {
        const all = await query<Record<string, unknown>>(
          `SELECT sch.*, ses.id AS session_id, ses.exam_id, ses.nama_sesi, ex.nama AS exam_nama, ex.madrasah_nama, ex.tahun_ajaran, ex.warning_minutes_before_end,
                  sub.kode AS subject_kode, sub.nama AS subject_nama,
                  rm.kode AS room_kode, rm.nama AS room_nama, rm.kapasitas AS room_kapasitas
           FROM exam_schedules sch
           JOIN exam_sessions ses ON ses.id = sch.exam_session_id
           JOIN exams ex ON ex.id = ses.exam_id
           JOIN subjects sub ON sub.id = sch.subject_id
           JOIN rooms rm ON rm.id = sch.room_id
           ORDER BY sch.tanggal ASC, sch.jam_mulai ASC`
        );
        res.json({ serverTime: getServerWibNow(), schedules: await buildScheduleItems(all) });
        return;
      }

      if (!user.supervisorId) {
        res.json({ serverTime: getServerWibNow(), schedules: [] });
        return;
      }

      const rows = await query<Record<string, unknown>>(
        `SELECT sch.*, ses.id AS session_id, ses.exam_id, ses.nama_sesi, ex.nama AS exam_nama, ex.madrasah_nama, ex.tahun_ajaran, ex.warning_minutes_before_end,
                sub.kode AS subject_kode, sub.nama AS subject_nama,
                rm.kode AS room_kode, rm.nama AS room_nama, rm.kapasitas AS room_kapasitas
         FROM supervision_assignments sa
         JOIN exam_schedules sch ON sch.id = sa.exam_schedule_id
         JOIN exam_sessions ses ON ses.id = sch.exam_session_id
         JOIN exams ex ON ex.id = ses.exam_id
         JOIN subjects sub ON sub.id = sch.subject_id
         JOIN rooms rm ON rm.id = sch.room_id
         WHERE sa.supervisor_id = $1
         ORDER BY sch.tanggal ASC, sch.jam_mulai ASC`,
        [user.supervisorId]
      );

      res.json({
        serverTime: getServerWibNow(),
        schedules: await buildScheduleItems(rows, user.supervisorId),
      });
    })
  );

  // ========================
  // MENGAWASI UJIAN (FR-MGU, protected by requireAssignedSchedule)
  // ========================
  router.get(
    '/supervision/:scheduleId',
    requireAuth,
    requireAssignedSchedule,
    asyncHandler(async (req, res) => {
      const scheduleId = Number(req.params.scheduleId);
      const user = req.authUser!;

      const row = await queryOne<Record<string, unknown>>(
        `SELECT sch.*, ses.id AS session_id, ses.exam_id, ses.nama_sesi, ex.nama AS exam_nama, ex.madrasah_nama, ex.tahun_ajaran, ex.warning_minutes_before_end,
                sub.kode AS subject_kode, sub.nama AS subject_nama,
                rm.kode AS room_kode, rm.nama AS room_nama, rm.kapasitas AS room_kapasitas,
                rm.rows_count, rm.cols_count, rm.layout_json, rm.denah_lingkungan_json
         FROM exam_schedules sch
         JOIN exam_sessions ses ON ses.id = sch.exam_session_id
         JOIN exams ex ON ex.id = ses.exam_id
         JOIN subjects sub ON sub.id = sch.subject_id
         JOIN rooms rm ON rm.id = sch.room_id
         WHERE sch.id = $1`,
        [scheduleId]
      );

      if (!row) {
        res.status(404).json({ error: 'Jadwal pengawasan tidak ditemukan.' });
        return;
      }

      // Serverless collaborative room presence tracking via PostgreSQL
      const nowMs = Date.now();
      await execute(
        `INSERT INTO room_presence (schedule_id, user_id, nama, role, last_seen_ms)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (schedule_id, user_id) DO UPDATE SET
           nama = EXCLUDED.nama,
           role = EXCLUDED.role,
           last_seen_ms = EXCLUDED.last_seen_ms`,
        [scheduleId, user.id, user.namaLengkap, user.role, nowMs]
      );
      const activePeers = await query<{ userId: number; nama: string; role: string }>(
        `SELECT user_id AS "userId", nama, role
         FROM room_presence
         WHERE schedule_id = $1 AND last_seen_ms >= $2
         ORDER BY nama ASC`,
        [scheduleId, nowMs - 20_000]
      );

      const [scheduleItem] = await buildScheduleItems([row], user.supervisorId);

      const seatsRaw = await query<Record<string, unknown>>(
        `SELECT s.*, st.exam_id AS st_exam_id, st.nomor_peserta, st.nisn, st.nis, st.nama AS st_nama, st.kelas AS st_kelas
         FROM seats s
         LEFT JOIN students st ON st.id = s.student_id
         WHERE s.room_id = $1
         ORDER BY s.baris ASC, s.kolom ASC`,
        [row.room_id]
      );

      const attendanceRows = await query<Record<string, unknown>>(
        `SELECT * FROM attendance WHERE exam_schedule_id = $1`,
        [scheduleId]
      );
      const warningsRows = await query<Record<string, unknown>>(
        `SELECT * FROM warnings WHERE exam_schedule_id = $1 ORDER BY id ASC`,
        [scheduleId]
      );
      const exitsRows = await query<Record<string, unknown>>(
        `SELECT * FROM exit_permissions WHERE exam_schedule_id = $1 ORDER BY id ASC`,
        [scheduleId]
      );
      const incidents = await query(
        `SELECT * FROM incident_reports WHERE exam_schedule_id = $1 ORDER BY id DESC`,
        [scheduleId]
      );

      const reportsRaw = await query<Record<string, unknown>>(
        `SELECT sr.*, sup.nama_lengkap AS supervisor_nama
         FROM supervision_reports sr
         JOIN supervisors sup ON sup.id = sr.supervisor_id
         WHERE sr.exam_schedule_id = $1`,
        [scheduleId]
      );

      const verifs = await query<Record<string, unknown>>(
        `SELECT rv.*, u.username AS admin_nama
         FROM report_verifications rv
         JOIN users u ON u.id = rv.admin_id
         WHERE rv.report_id IN (SELECT id FROM supervision_reports WHERE exam_schedule_id = $1)
         ORDER BY rv.id DESC`,
        [scheduleId]
      );

      const seats = seatsRaw.map((s) => {
        const studentId = s.student_id ? Number(s.student_id) : null;
        const att = studentId
          ? attendanceRows.find((a) => Number(a.student_id) === studentId)
          : undefined;
        const wList = studentId
          ? warningsRows.filter((w) => Number(w.student_id) === studentId)
          : [];
        const eList = studentId
          ? exitsRows.filter((e) => Number(e.student_id) === studentId)
          : [];
        const activeExit = eList.find((e) => e.waktu_kembali === null) ?? null;

        let highestWarningLevel: 0 | 1 | 2 | 3 = 0;
        for (const w of wList) {
          const lvl = Number(w.tingkat) as 1 | 2 | 3;
          if (lvl > highestWarningLevel) highestWarningLevel = lvl;
        }

        return {
          id: Number(s.id),
          room_id: Number(s.room_id),
          kode_kursi: String(s.kode_kursi),
          baris: Number(s.baris),
          kolom: Number(s.kolom),
          posisi_x: Number(s.posisi_x),
          posisi_y: Number(s.posisi_y),
          student_id: studentId,
          student: studentId
            ? {
                id: studentId,
                exam_id: Number(s.st_exam_id),
                nomor_peserta: String(s.nomor_peserta),
                nisn: s.nisn ? String(s.nisn) : null,
                nis: s.nis ? String(s.nis) : null,
                nama: String(s.st_nama),
                kelas: String(s.st_kelas),
              }
            : null,
          attendance: {
            status: (att?.status as 'hadir' | 'tidak_hadir' | 'belum') || 'belum',
            dicatat_oleh: att?.dicatat_oleh ? Number(att.dicatat_oleh) : null,
            waktu: att?.waktu ? String(att.waktu) : null,
            updated_version: att?.updated_version ? Number(att.updated_version) : 0,
          },
          warnings: wList,
          highestWarningLevel,
          activeExit,
          exitHistory: eList,
        };
      });

      res.json({
        serverTime: getServerWibNow(),
        schedule: scheduleItem,
        room: {
          id: Number(row.room_id),
          kode: String(row.room_kode),
          nama: String(row.room_nama),
          kapasitas: Number(row.room_kapasitas),
          rows_count: Number(row.rows_count),
          cols_count: Number(row.cols_count),
          layout_json: row.layout_json,
          denah_lingkungan_json: row.denah_lingkungan_json,
        },
        seats,
        incidents,
        activePeers: activePeers.map((p) => ({
          userId: Number(p.userId),
          nama: p.nama,
          role: p.role,
        })),
        reports: reportsRaw.map((r) => ({
          ...r,
          verifications: verifs.filter((v) => Number(v.report_id) === Number(r.id)),
        })),
      });
    })
  );

  router.post(
    '/supervision/:scheduleId/check-in',
    requireAuth,
    requireAssignedSchedule,
    asyncHandler(async (req, res) => {
      const scheduleId = Number(req.params.scheduleId);
      const user = req.authUser!;
      if (!user.supervisorId) {
        res
          .status(403)
          .json({ error: 'Hanya pengawas bertugas yang dapat mencatat hadir pengawas.' });
        return;
      }

      const sched = await queryOne<Record<string, unknown>>(
        `SELECT * FROM exam_schedules WHERE id = $1`,
        [scheduleId]
      );
      if (!sched) {
        res.status(404).json({ error: 'Jadwal tidak ditemukan.' });
        return;
      }
      const status = computeScheduleStatus(
        String(sched.tanggal),
        String(sched.jam_mulai),
        String(sched.jam_selesai),
        Number(sched.status_manual_cancel)
      );
      if (status !== 'aktif') {
        res.status(403).json({
          error: 'Check-in pengawas hanya dapat dilakukan saat jadwal berstatus Aktif (WIB).',
        });
        return;
      }

      const assign = await queryOne<{ id: number }>(
        `SELECT id FROM supervision_assignments WHERE exam_schedule_id = $1 AND supervisor_id = $2`,
        [scheduleId, user.supervisorId]
      );
      if (!assign) {
        res.status(403).json({ error: 'Penugasan pengawas tidak ditemukan.' });
        return;
      }

      const now = getServerWibNow().isoWib;
      await execute(
        `INSERT INTO supervisor_attendance (assignment_id, waktu_hadir, status) VALUES ($1, $2, 'hadir')
         ON CONFLICT (assignment_id) DO UPDATE SET waktu_hadir = EXCLUDED.waktu_hadir, status = 'hadir'`,
        [assign.id, now]
      );

      await execute(
        `UPDATE exam_schedules SET actual_started_at = COALESCE(actual_started_at, $1) WHERE id = $2`,
        [now, scheduleId]
      );

      res.json({ ok: true, waktu_hadir: now });
    })
  );

  router.post(
    '/supervision/:scheduleId/attendance',
    requireAuth,
    requireAssignedSchedule,
    asyncHandler(async (req, res) => {
      const user = req.authUser!;
      if (user.role !== 'supervisor') {
        res
          .status(403)
          .json({ error: 'Hanya pengawas bertugas yang dapat mengubah kehadiran peserta.' });
        return;
      }
      const scheduleId = Number(req.params.scheduleId);
      const { studentId, status, expectedVersion } = req.body as {
        studentId?: number;
        status?: 'hadir' | 'tidak_hadir' | 'belum';
        expectedVersion?: number;
      };

      if (!studentId || !status || !['hadir', 'tidak_hadir', 'belum'].includes(status)) {
        res.status(400).json({ error: 'Data kehadiran tidak valid.' });
        return;
      }

      const sched = await queryOne<Record<string, unknown>>(
        `SELECT * FROM exam_schedules WHERE id = $1`,
        [scheduleId]
      );
      if (!sched) {
        res.status(404).json({ error: 'Jadwal tidak ditemukan.' });
        return;
      }
      const schStatus = computeScheduleStatus(
        String(sched.tanggal),
        String(sched.jam_mulai),
        String(sched.jam_selesai),
        Number(sched.status_manual_cancel)
      );
      if (schStatus !== 'aktif') {
        res.status(403).json({ error: 'Kehadiran hanya dapat diubah saat ujian berlangsung (Aktif).' });
        return;
      }

      const current = await queryOne<{ id: number; updated_version: number; status: string }>(
        `SELECT id, updated_version, status FROM attendance WHERE student_id = $1 AND exam_schedule_id = $2`,
        [studentId, scheduleId]
      );

      const currentVer = current ? Number(current.updated_version) : 0;
      if (typeof expectedVersion === 'number' && expectedVersion !== currentVer) {
        res.status(409).json({
          error:
            'Konflik sinkronisasi (BR-10): Status kursi ini baru saja diperbarui oleh rekan pengawas. Tinjau pembaruan terbaru.',
          currentVersion: currentVer,
          currentStatus: current?.status ?? 'belum',
        });
        return;
      }

      const now = getServerWibNow().isoWib;
      const nextVer = currentVer + 1;
      if (current) {
        await execute(
          `UPDATE attendance SET status = $1, dicatat_oleh = $2, waktu = $3, updated_version = $4 WHERE id = $5`,
          [status, user.id, now, nextVer, current.id]
        );
      } else {
        await execute(
          `INSERT INTO attendance (student_id, exam_schedule_id, status, dicatat_oleh, waktu, updated_version)
           VALUES ($1, $2, $3, $4, $5, 1)`,
          [studentId, scheduleId, status, user.id, now]
        );
      }

      await appendAuditLog({
        userId: user.id,
        username: user.username,
        aksi: 'RECORD_ATTENDANCE',
        entitas: 'attendance',
        entitasId: `${scheduleId}:${studentId}`,
        nilaiLama: current ? { status: current.status } : null,
        nilaiBaru: { status },
        ip: getClientIp(req),
      });

      res.json({ ok: true, updated_version: nextVer, waktu: now });
    })
  );

  router.post(
    '/supervision/:scheduleId/warnings',
    requireAuth,
    requireAssignedSchedule,
    asyncHandler(async (req, res) => {
      const user = req.authUser!;
      if (user.role !== 'supervisor') {
        res
          .status(403)
          .json({ error: 'Hanya pengawas bertugas yang dapat mencatat peringatan.' });
        return;
      }
      const scheduleId = Number(req.params.scheduleId);
      const { studentId, tingkat, alasan, isCorrection, correctsWarningId, idempotencyKey } =
        req.body as {
          studentId?: number;
          tingkat?: 1 | 2 | 3;
          alasan?: string;
          isCorrection?: boolean;
          correctsWarningId?: number;
          idempotencyKey?: string;
        };

      if (!studentId || !tingkat || ![1, 2, 3].includes(tingkat)) {
        res.status(400).json({ error: 'Peserta dan tingkat peringatan (1-3) wajib valid.' });
        return;
      }
      if (!alasan || alasan.trim() === '') {
        res.status(400).json({ error: 'Alasan peringatan wajib diisi (BR-05).' });
        return;
      }

      if (idempotencyKey) {
        const existing = await queryOne(
          `SELECT * FROM warnings WHERE idempotency_key = $1`,
          [idempotencyKey]
        );
        if (existing) {
          res.json({ ok: true, warning: existing, deduplicated: true });
          return;
        }
      }

      const sched = await queryOne<Record<string, unknown>>(
        `SELECT es.*, rm.kode AS room_kode, sub.nama AS subject_nama
         FROM exam_schedules es
         JOIN rooms rm ON rm.id = es.room_id
         JOIN subjects sub ON sub.id = es.subject_id
         WHERE es.id = $1`,
        [scheduleId]
      );
      if (!sched) {
        res.status(404).json({ error: 'Jadwal tidak ditemukan.' });
        return;
      }

      const schStatus = computeScheduleStatus(
        String(sched.tanggal),
        String(sched.jam_mulai),
        String(sched.jam_selesai),
        Number(sched.status_manual_cancel)
      );
      if (schStatus !== 'aktif') {
        res.status(403).json({ error: 'Peringatan hanya dapat dicatat saat jadwal berstatus Aktif.' });
        return;
      }

      const student = await queryOne<{ nama: string; nomor_peserta: string }>(
        `SELECT nama, nomor_peserta FROM students WHERE id = $1`,
        [studentId]
      );

      const now = getServerWibNow().isoWib;
      const created = await queryOne<Record<string, unknown>>(
        `INSERT INTO warnings (student_id, exam_schedule_id, tingkat, alasan, is_correction, corrects_warning_id, dicatat_oleh, dicatat_oleh_nama, waktu_server, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING *`,
        [
          studentId,
          scheduleId,
          tingkat,
          alasan.trim(),
          isCorrection ? 1 : 0,
          correctsWarningId ?? null,
          user.id,
          user.namaLengkap,
          now,
          idempotencyKey ?? null,
        ]
      );
      const warningId = Number(created!.id);

      await appendAuditLog({
        userId: user.id,
        username: user.username,
        aksi: isCorrection ? 'CORRECTION_WARNING' : `ISSUE_WARNING_LEVEL_${tingkat}`,
        entitas: 'warnings',
        entitasId: warningId,
        nilaiBaru: { studentId, tingkat, alasan: alasan.trim(), correctsWarningId },
        ip: getClientIp(req),
      });

      if (tingkat === 3 && !isCorrection) {
        await notifyAllAdmins({
          judul: `Laporan Peringatan 3 — Ruang ${sched.room_kode}`,
          isi: `Peserta ${student?.nama || studentId} (${student?.nomor_peserta || '-'}) menerima Peringatan Tingkat 3 pada ${sched.subject_nama}. Alasan: "${alasan.trim()}". Tindak lanjut berada di tangan Panitia.`,
          kategori: 'peringatan_3',
          linkTarget: `admin:monitoring:${scheduleId}`,
        });
      }

      res.status(201).json({ ok: true, warning: created });
    })
  );

  router.post(
    '/supervision/:scheduleId/exits',
    requireAuth,
    requireAssignedSchedule,
    asyncHandler(async (req, res) => {
      const user = req.authUser!;
      if (user.role !== 'supervisor') {
        res
          .status(403)
          .json({ error: 'Hanya pengawas bertugas yang dapat mencatat izin keluar.' });
        return;
      }
      const scheduleId = Number(req.params.scheduleId);
      const { action, studentId, alasan, exitId, idempotencyKey } = req.body as {
        action?: 'keluar' | 'kembali';
        studentId?: number;
        alasan?: string;
        exitId?: number;
        idempotencyKey?: string;
      };

      const sched = await queryOne<Record<string, unknown>>(
        `SELECT * FROM exam_schedules WHERE id = $1`,
        [scheduleId]
      );
      if (!sched) {
        res.status(404).json({ error: 'Jadwal tidak ditemukan.' });
        return;
      }
      const schStatus = computeScheduleStatus(
        String(sched.tanggal),
        String(sched.jam_mulai),
        String(sched.jam_selesai),
        Number(sched.status_manual_cancel)
      );
      if (schStatus !== 'aktif') {
        res
          .status(403)
          .json({ error: 'Izin keluar hanya dapat dicatat saat ujian berlangsung.' });
        return;
      }

      const now = getServerWibNow().isoWib;

      if (action === 'keluar') {
        if (!studentId || !alasan || alasan.trim() === '') {
          res.status(400).json({ error: 'Peserta dan alasan izin keluar wajib diisi.' });
          return;
        }
        if (idempotencyKey) {
          const existing = await queryOne(
            `SELECT * FROM exit_permissions WHERE idempotency_key = $1`,
            [idempotencyKey]
          );
          if (existing) {
            res.json({ ok: true, exit: existing, deduplicated: true });
            return;
          }
        }
        const active = await queryOne<{ id: number }>(
          `SELECT id FROM exit_permissions WHERE student_id = $1 AND exam_schedule_id = $2 AND waktu_kembali IS NULL`,
          [studentId, scheduleId]
        );
        if (active) {
          res.status(409).json({
            error:
              'Peserta ini sudah memiliki izin keluar aktif (BR-14). Catat KEMBALI terlebih dahulu.',
          });
          return;
        }

        const created = await queryOne<Record<string, unknown>>(
          `INSERT INTO exit_permissions (student_id, exam_schedule_id, alasan, waktu_keluar, dicatat_oleh, dicatat_oleh_nama, idempotency_key)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING *`,
          [studentId, scheduleId, alasan.trim(), now, user.id, user.namaLengkap, idempotencyKey ?? null]
        );

        await appendAuditLog({
          userId: user.id,
          username: user.username,
          aksi: 'EXIT_PERMISSION_START',
          entitas: 'exit_permissions',
          entitasId: Number(created!.id),
          nilaiBaru: { studentId, alasan: alasan.trim(), waktu_keluar: now },
          ip: getClientIp(req),
        });

        res.status(201).json({ ok: true, exit: created });
        return;
      }

      if (action === 'kembali') {
        const target = exitId
          ? await queryOne<{
              id: number;
              student_id: number;
              waktu_keluar: string;
              waktu_kembali: string | null;
            }>(
              `SELECT * FROM exit_permissions WHERE id = $1 AND exam_schedule_id = $2`,
              [exitId, scheduleId]
            )
          : await queryOne<{
              id: number;
              student_id: number;
              waktu_keluar: string;
              waktu_kembali: string | null;
            }>(
              `SELECT * FROM exit_permissions WHERE student_id = $1 AND exam_schedule_id = $2 AND waktu_kembali IS NULL ORDER BY id DESC LIMIT 1`,
              [studentId, scheduleId]
            );

        if (!target) {
          res.status(404).json({ error: 'Izin keluar aktif tidak ditemukan.' });
          return;
        }
        if (target.waktu_kembali) {
          res.status(409).json({ error: 'Peserta sudah tercatat kembali sebelumnya.' });
          return;
        }

        const durasiDetik = computeDurationSeconds(target.waktu_keluar, now);
        const updated = await queryOne<Record<string, unknown>>(
          `UPDATE exit_permissions SET waktu_kembali = $1, durasi_detik = $2 WHERE id = $3 RETURNING *`,
          [now, durasiDetik, target.id]
        );

        await appendAuditLog({
          userId: user.id,
          username: user.username,
          aksi: 'EXIT_PERMISSION_RETURN',
          entitas: 'exit_permissions',
          entitasId: target.id,
          nilaiBaru: { waktu_kembali: now, durasi_detik: durasiDetik },
          ip: getClientIp(req),
        });

        res.json({ ok: true, exit: updated });
        return;
      }

      res.status(400).json({ error: 'Aksi izin keluar harus "keluar" atau "kembali".' });
    })
  );

  router.post(
    '/supervision/:scheduleId/incidents',
    requireAuth,
    requireAssignedSchedule,
    asyncHandler(async (req, res) => {
      const user = req.authUser!;
      if (user.role !== 'supervisor') {
        res
          .status(403)
          .json({ error: 'Hanya pengawas bertugas yang dapat mencatat kejadian.' });
        return;
      }
      const scheduleId = Number(req.params.scheduleId);
      const { deskripsi } = req.body as { deskripsi?: string };
      if (!deskripsi || deskripsi.trim() === '') {
        res.status(400).json({ error: 'Deskripsi kejadian wajib diisi.' });
        return;
      }
      const now = getServerWibNow().isoWib;
      const created = await queryOne<Record<string, unknown>>(
        `INSERT INTO incident_reports (exam_schedule_id, deskripsi, waktu, dicatat_oleh, dicatat_oleh_nama)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [scheduleId, deskripsi.trim(), now, user.id, user.namaLengkap]
      );

      await appendAuditLog({
        userId: user.id,
        username: user.username,
        aksi: 'CREATE_INCIDENT_REPORT',
        entitas: 'incident_reports',
        entitasId: Number(created!.id),
        nilaiBaru: { scheduleId, deskripsi: deskripsi.trim() },
        ip: getClientIp(req),
      });

      res.status(201).json({ ok: true, incident: created });
    })
  );

  // ========================
  // UPLOAD BERKAS & PENYELESAIAN (FR-UPL & FR-SLS)
  // ========================
  router.post(
    '/supervision/:scheduleId/reports/berita-acara',
    requireAuth,
    requireAssignedSchedule,
    asyncHandler(async (req, res) => {
      const user = req.authUser!;
      if (user.role !== 'supervisor' || !user.supervisorId) {
        res
          .status(403)
          .json({ error: 'Hanya pengawas bertugas yang dapat mengirim berita acara.' });
        return;
      }
      const scheduleId = Number(req.params.scheduleId);
      const { kondisi_pelaksanaan, catatan_tambahan, ttd_url } = req.body as {
        kondisi_pelaksanaan?: string;
        catatan_tambahan?: string;
        ttd_url?: string;
      };

      const existing = await queryOne<{ id: number; status: string; version: number }>(
        `SELECT * FROM supervision_reports WHERE exam_schedule_id = $1 AND jenis = 'berita_acara'`,
        [scheduleId]
      );

      if (existing && existing.status === 'terverifikasi') {
        res.status(403).json({
          error: 'Berita acara sudah Terverifikasi dan tidak dapat diubah pengawas (BR-16).',
        });
        return;
      }

      const sup = await queryOne<{ ttd_url: string | null; nama_lengkap: string }>(
        `SELECT ttd_url, nama_lengkap FROM supervisors WHERE id = $1`,
        [user.supervisorId]
      );
      const effectiveTtd = ttd_url || sup?.ttd_url;
      if (!effectiveTtd) {
        res
          .status(400)
          .json({ error: 'Tanda tangan digital kosong. Lengkapi tanda tangan sebelum mengirim.' });
        return;
      }

      const sched = await queryOne<{ room_id: number }>(
        `SELECT room_id FROM exam_schedules WHERE id = $1`,
        [scheduleId]
      );
      const seatedStudents = await query<{ student_id: number }>(
        `SELECT student_id FROM seats WHERE room_id = $1 AND student_id IS NOT NULL`,
        [sched!.room_id]
      );
      const attendance = await query<{ student_id: number; status: string }>(
        `SELECT student_id, status FROM attendance WHERE exam_schedule_id = $1`,
        [scheduleId]
      );

      const unmarkedCount = seatedStudents.filter((st) => {
        const a = attendance.find((x) => Number(x.student_id) === Number(st.student_id));
        return !a || a.status === 'belum';
      }).length;

      if (unmarkedCount > 0) {
        res.status(400).json({
          error: `Berita acara belum dapat dikirim (BR-15): masih ada ${unmarkedCount} peserta yang belum dicatat kehadirannya (Hadir / Tidak Hadir).`,
        });
        return;
      }

      const jumlahTerdaftar = seatedStudents.length;
      const jumlahHadir = attendance.filter((a) => a.status === 'hadir').length;
      const jumlahTidakHadir = attendance.filter((a) => a.status === 'tidak_hadir').length;
      const incidents = await query(
        `SELECT deskripsi, waktu, dicatat_oleh_nama FROM incident_reports WHERE exam_schedule_id = $1`,
        [scheduleId]
      );

      const dataJson = JSON.stringify({
        jumlah_terdaftar: jumlahTerdaftar,
        jumlah_hadir: jumlahHadir,
        jumlah_tidak_hadir: jumlahTidakHadir,
        kondisi_pelaksanaan: kondisi_pelaksanaan || 'Lancar dan Tertib',
        catatan_tambahan: catatan_tambahan || '',
        kejadian: incidents,
        nama_pengawas: sup!.nama_lengkap,
        ttd_url: effectiveTtd,
      });

      const now = getServerWibNow().isoWib;
      if (existing) {
        await execute(
          `UPDATE supervision_reports SET supervisor_id = $1, data_json = $2, status = 'menunggu_verifikasi', dikirim_pada = $3, version = version + 1 WHERE id = $4`,
          [user.supervisorId, dataJson, now, existing.id]
        );
      } else {
        await execute(
          `INSERT INTO supervision_reports (exam_schedule_id, supervisor_id, jenis, data_json, status, dikirim_pada, version)
           VALUES ($1, $2, 'berita_acara', $3, 'menunggu_verifikasi', $4, 1)`,
          [scheduleId, user.supervisorId, dataJson, now]
        );
      }

      await notifyAllAdmins({
        judul: 'Berita Acara Masuk Menunggu Verifikasi',
        isi: `${sup!.nama_lengkap} mengirim Berita Acara untuk Jadwal #${scheduleId} (${jumlahHadir}/${jumlahTerdaftar} hadir).`,
        kategori: 'laporan',
        linkTarget: 'admin:reports',
      });

      await appendAuditLog({
        userId: user.id,
        username: user.username,
        aksi: 'SUBMIT_BERITA_ACARA',
        entitas: 'supervision_reports',
        entitasId: scheduleId,
        nilaiBaru: { jumlahTerdaftar, jumlahHadir, jumlahTidakHadir },
        ip: getClientIp(req),
      });

      res.json({ ok: true });
    })
  );

  router.post(
    '/supervision/:scheduleId/reports/daftar-hadir',
    requireAuth,
    requireAssignedSchedule,
    upload.single('file'),
    asyncHandler(async (req, res) => {
      const user = req.authUser!;
      if (user.role !== 'supervisor' || !user.supervisorId) {
        res
          .status(403)
          .json({ error: 'Hanya pengawas bertugas yang dapat mengunggah daftar hadir.' });
        return;
      }
      if (!req.file) {
        res.status(400).json({ error: 'Berkas foto/scan daftar hadir wajib dipilih.' });
        return;
      }
      const scheduleId = Number(req.params.scheduleId);
      const existing = await queryOne<{ id: number; status: string }>(
        `SELECT * FROM supervision_reports WHERE exam_schedule_id = $1 AND jenis = 'daftar_hadir'`,
        [scheduleId]
      );

      if (existing && existing.status === 'terverifikasi') {
        res.status(403).json({
          error: 'Daftar hadir sudah Terverifikasi dan tidak dapat diubah pengawas (BR-16).',
        });
        return;
      }

      const now = getServerWibNow().isoWib;
      const stored = await persistDocumentBytes({
        buffer: req.file.buffer,
        originalName: req.file.originalname,
        mimeType: req.file.mimetype,
        folder: 'daftar-hadir',
      });

      const docInserted = await queryOne<{ id: number }>(
        `INSERT INTO documents (jenis, nama_file, path, mime_type, blob_url, file_bytes, sha256, uploaded_by, version, status_verifikasi, created_at)
         VALUES ('daftar_hadir_scan', $1, $2, $3, $4, $5, $6, $7, 1, 'menunggu_verifikasi', $8)
         RETURNING id`,
        [
          stored.safeFilename,
          stored.storagePath,
          stored.mimeType,
          stored.blobUrl,
          stored.fileBytes,
          stored.sha256,
          user.id,
          now,
        ]
      );
      const docId = Number(docInserted!.id);
      const fileRef = `/api/files/${docId}`;

      const dataJson = JSON.stringify({
        nama_file: stored.safeFilename,
        sha256: stored.sha256,
        catatan: req.body.catatan || '',
      });

      if (existing) {
        await execute(
          `UPDATE supervision_reports SET supervisor_id = $1, file_path = $2, data_json = $3, status = 'menunggu_verifikasi', dikirim_pada = $4, version = version + 1 WHERE id = $5`,
          [user.supervisorId, fileRef, dataJson, now, existing.id]
        );
      } else {
        await execute(
          `INSERT INTO supervision_reports (exam_schedule_id, supervisor_id, jenis, data_json, file_path, status, dikirim_pada, version)
           VALUES ($1, $2, 'daftar_hadir', $3, $4, 'menunggu_verifikasi', $5, 1)`,
          [scheduleId, user.supervisorId, dataJson, fileRef, now]
        );
      }

      await notifyAllAdmins({
        judul: 'Daftar Hadir Diunggah Menunggu Verifikasi',
        isi: `${user.namaLengkap} mengunggah berkas Daftar Hadir (${stored.safeFilename}) untuk Jadwal #${scheduleId}.`,
        kategori: 'laporan',
        linkTarget: 'admin:reports',
      });

      await appendAuditLog({
        userId: user.id,
        username: user.username,
        aksi: 'UPLOAD_DAFTAR_HADIR',
        entitas: 'supervision_reports',
        entitasId: scheduleId,
        nilaiBaru: { filename: stored.safeFilename, sha256: stored.sha256 },
        ip: getClientIp(req),
      });

      res.json({
        ok: true,
        file_path: fileRef,
        storage_provider: stored.storageProvider,
        blob_configured: isBlobConfigured(),
      });
    })
  );

  // Authenticated private file download from permanent storage (PostgreSQL BYTEA or Vercel Blob)
  router.get(
    '/files/:docId',
    requireAuth,
    asyncHandler(async (req, res) => {
      const docId = Number(req.params.docId);
      const doc = await queryOne<{
        id: number;
        nama_file: string;
        blob_url: string | null;
        file_bytes: Buffer | null;
        mime_type: string | null;
        uploaded_by: number | null;
      }>(`SELECT id, nama_file, blob_url, file_bytes, mime_type, uploaded_by FROM documents WHERE id = $1`, [
        docId,
      ]);

      if (!doc) {
        res.status(404).json({ error: 'Berkas tidak ditemukan.' });
        return;
      }
      const user = req.authUser!;
      if (user.role !== 'admin' && Number(doc.uploaded_by) !== user.id) {
        res.status(403).json({ error: 'Anda tidak memiliki izin mengakses berkas ini.' });
        return;
      }

      const loaded = await loadPersistedDocumentBytes(doc);
      if (!loaded) {
        res.status(404).json({ error: 'Berkas fisik tidak ditemukan di penyimpanan permanen.' });
        return;
      }

      const disposition = req.query.download === '1' ? 'attachment' : 'inline';
      res.setHeader('Content-Type', loaded.mimeType);
      res.setHeader('Content-Disposition', `${disposition}; filename="${loaded.filename}"`);
      res.send(loaded.buffer);
    })
  );

  router.get(
    '/admin/documents/dataset',
    requireAuth,
    requireAdmin,
    asyncHandler(async (_req, res) => {
      const exam = await queryOne<Record<string, unknown>>(`SELECT * FROM exams ORDER BY id DESC LIMIT 1`);
      const rooms = await query<Record<string, unknown>>(`SELECT * FROM rooms ORDER BY kode ASC`);
      const seats = await query<Record<string, unknown>>(
        `SELECT s.*, st.nomor_peserta, st.nisn, st.nis, st.nama AS student_nama, st.kelas
         FROM seats s LEFT JOIN students st ON st.id = s.student_id
         ORDER BY s.baris ASC, s.kolom ASC`
      );
      const supervisors = await query(`SELECT * FROM supervisors ORDER BY nama_lengkap ASC`);
      const schedulesRaw = await query<Record<string, unknown>>(
        `SELECT sch.*, ses.id AS session_id, ses.exam_id, ses.nama_sesi, ex.nama AS exam_nama, ex.madrasah_nama, ex.tahun_ajaran, ex.warning_minutes_before_end,
                sub.kode AS subject_kode, sub.nama AS subject_nama,
                rm.kode AS room_kode, rm.nama AS room_nama, rm.kapasitas AS room_kapasitas
         FROM exam_schedules sch
         JOIN exam_sessions ses ON ses.id = sch.exam_session_id
         JOIN exams ex ON ex.id = ses.exam_id
         JOIN subjects sub ON sub.id = sch.subject_id
         JOIN rooms rm ON rm.id = sch.room_id
         ORDER BY sch.tanggal ASC, sch.jam_mulai ASC`
      );
      const incidents = await query(`SELECT * FROM incident_reports ORDER BY id DESC`);
      const warnings = await query(
        `SELECT w.*, st.nama AS student_nama, st.nomor_peserta
         FROM warnings w JOIN students st ON st.id = w.student_id ORDER BY w.id DESC`
      );

      res.json({
        serverTime: getServerWibNow(),
        exam: exam || null,
        rooms: rooms.map((r) => ({
          ...r,
          seats: seats.filter((s) => Number(s.room_id) === Number(r.id)),
        })),
        supervisors,
        schedules: await buildScheduleItems(schedulesRaw),
        incidents,
        warnings,
      });
    })
  );

  router.use((_req, res) => {
    res.status(404).json({ error: 'Endpoint API tidak ditemukan (404).' });
  });

  // Global JSON error handler for serverless async routes
  router.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error('[SIPENGUJI API Error]', err);
    const msg =
      err instanceof Error
        ? err.message
        : 'Terjadi kesalahan internal server saat memproses permintaan.';
    const isDbMissing = msg.includes('DATABASE_URL') || msg.includes('ECONNREFUSED');
    res.status(isDbMissing ? 503 : 500).json({ error: msg });
  });

  return router;
}
