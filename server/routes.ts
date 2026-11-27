import crypto from 'crypto';
import express from 'express';
import fs from 'fs';
import multer from 'multer';
import path from 'path';
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
  createNotification,
  db,
  ELEVEN_DOCS_CATALOG,
  ensureGeneratedDocRows,
  markGeneratedDocumentsStale,
  notifyAllAdmins,
  UPLOADS_DIR,
} from './db.ts';
import {
  buildTemplateWorkbook,
  detectDuplicatesAndUnreadable,
  extractDocumentFromFile,
} from './extractor.ts';
import { commitImportBatch } from './importCommit.ts';
import {
  computeDurationSeconds,
  computeRemainingSeconds,
  computeScheduleStatus,
  getServerWibNow,
} from './time.ts';
import { broadcastToAdmins, broadcastToSchedule, broadcastToUser } from './ws.ts';
import type { ImportDocType, SupervisionScheduleItem } from '../src/types.ts';

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename: (_req, file, cb) => {
    const safeBase = path.basename(file.originalname).replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `${Date.now()}_${crypto.randomBytes(4).toString('hex')}_${safeBase}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB limit (OD-04)
});

function getClientIp(req: express.Request): string {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string') return fwd.split(',')[0].trim();
  return req.ip || 'unknown';
}

function buildScheduleItem(row: Record<string, unknown>, supervisorId?: number | null): SupervisionScheduleItem {
  const now = new Date();
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

  const coSups = db
    .prepare(
      `SELECT sa.id AS assignment_id, sa.supervisor_id, sa.peran, s.nama_lengkap, s.nip_nuptk,
              att.waktu_hadir, att.status AS att_status
       FROM supervision_assignments sa
       JOIN supervisors s ON s.id = sa.supervisor_id
       LEFT JOIN supervisor_attendance att ON att.assignment_id = sa.id
       WHERE sa.exam_schedule_id = ?`
    )
    .all(row.id) as Array<{
    assignment_id: number;
    supervisor_id: number;
    peran: 'utama' | 'pendamping';
    nama_lengkap: string;
    nip_nuptk: string | null;
    waktu_hadir: string | null;
    att_status: string | null;
  }>;

  const reports = db
    .prepare(`SELECT status FROM supervision_reports WHERE exam_schedule_id = ?`)
    .all(row.id) as Array<{ status: string }>;

  let reportStatus: SupervisionScheduleItem['report_status'] = 'belum_dikerjakan';
  if (reports.some((r) => r.status === 'perlu_perbaikan')) reportStatus = 'perlu_perbaikan';
  else if (reports.length >= 2 && reports.every((r) => r.status === 'terverifikasi')) reportStatus = 'terverifikasi';
  else if (reports.some((r) => r.status === 'menunggu_verifikasi')) reportStatus = 'menunggu_verifikasi';
  else if (reports.length > 0) reportStatus = 'belum_dikirim';

  const mine = supervisorId ? coSups.find((c) => c.supervisor_id === supervisorId) : undefined;

  return {
    id: Number(row.id),
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
    assignment_id: mine?.assignment_id,
    peran: mine?.peran,
    supervisor_checked_in: Boolean(mine?.att_status === 'hadir'),
    co_supervisors: coSups.map((c) => ({
      supervisor_id: c.supervisor_id,
      nama_lengkap: c.nama_lengkap,
      nip_nuptk: c.nip_nuptk,
      peran: c.peran,
      checked_in: c.att_status === 'hadir',
      waktu_hadir: c.waktu_hadir,
    })),
    report_status: reportStatus,
  };
}

export function createApiRouter(): express.Router {
  const router = express.Router();

  // ========================
  // HEALTH & SERVER WIB TIME
  // ========================
  router.get('/health', (_req, res) => {
    res.json({ ok: true, serverTime: getServerWibNow() });
  });

  router.get('/server-time', (_req, res) => {
    res.json(getServerWibNow());
  });

  // ========================
  // AUTH & REGISTRATION
  // ========================
  router.get('/auth/status', (_req, res) => {
    const adminRow = db.prepare(`SELECT id FROM users WHERE role = 'admin' LIMIT 1`).get();
    const envPasscodeConfigured = Boolean(process.env.ADMIN_PASSCODE && process.env.ADMIN_PASSCODE.trim() !== '');
    res.json({
      hasAdmin: Boolean(adminRow),
      envPasscodeConfigured,
      needsAdminSetup: !adminRow && !envPasscodeConfigured,
    });
  });

  router.post('/auth/bootstrap-admin', (req, res) => {
    const existingAdmin = db.prepare(`SELECT id FROM users WHERE role = 'admin' LIMIT 1`).get();
    const envPasscode = process.env.ADMIN_PASSCODE?.trim();
    if (existingAdmin || envPasscode) {
      res.status(409).json({ error: 'Akun Admin sudah tersedia atau diatur oleh konfigurasi server.' });
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
      const info = db
        .prepare(
          `INSERT INTO users (username, password_hash, role, status, last_active_at, created_at)
           VALUES (?, ?, 'admin', 'active', ?, ?)`
        )
        .run(cleanUser, hash, now, now);
      const userId = Number(info.lastInsertRowid);
      const token = createSessionToken(userId);
      const user = authenticateToken(token);
      appendAuditLog({
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
  });

  router.post('/auth/login', (req, res) => {
    const { username, password, expectedRole } = req.body as {
      username?: string;
      password?: string;
      expectedRole?: 'admin' | 'supervisor';
    };
    const cleanUser = (username || '').trim();
    const ip = getClientIp(req);
    const rateKey = `login:${ip}:${cleanUser}`;
    const rate = checkRateLimit(rateKey);
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

    // Support server-configured ADMIN_PASSCODE only if no admin user exists yet
    const envPasscode = process.env.ADMIN_PASSCODE?.trim();
    const existingAdminForEnv = db
      .prepare(`SELECT id FROM users WHERE username = 'admin' AND role = 'admin'`)
      .get();
    if (!existingAdminForEnv && envPasscode && expectedRole === 'admin' && cleanUser === 'admin' && password === envPasscode) {
      const now = getServerWibNow().isoWib;
      const info = db
        .prepare(
          `INSERT INTO users (username, password_hash, role, status, must_change_password, last_active_at, created_at)
           VALUES ('admin', ?, 'admin', 'active', 1, ?, ?)`
        )
        .run(hashPassword(envPasscode), now, now);
      const adminId = Number(info.lastInsertRowid);
      clearFailedAttempts(rateKey);
      const token = createSessionToken(adminId);
      const user = authenticateToken(token);
      appendAuditLog({
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

    const row = db
      .prepare(
        `SELECT u.id, u.username, u.password_hash, u.role, u.status,
                s.status AS supervisor_status
         FROM users u
         LEFT JOIN supervisors s ON s.user_id = u.id
         WHERE u.username = ?`
      )
      .get(cleanUser) as
      | {
          id: number;
          username: string;
          password_hash: string;
          role: 'admin' | 'supervisor';
          status: string;
          supervisor_status: string | null;
        }
      | undefined;

    if (!row || !verifyPassword(password, row.password_hash)) {
      recordFailedAttempt(rateKey);
      appendAuditLog({
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

    clearFailedAttempts(rateKey);
    const token = createSessionToken(row.id);
    const user = authenticateToken(token);
    appendAuditLog({
      userId: row.id,
      username: row.username,
      aksi: row.role === 'admin' ? 'LOGIN_ADMIN' : 'LOGIN_SUPERVISOR',
      entitas: 'users',
      entitasId: row.id,
      ip,
    });
    res.json({ token, user });
  });

  router.post('/auth/logout', requireAuth, (req: AuthedRequest, res) => {
    if (req.authToken) revokeSessionToken(req.authToken);
    appendAuditLog({
      userId: req.authUser?.id,
      username: req.authUser?.username,
      aksi: 'LOGOUT',
      entitas: 'users',
      entitasId: req.authUser?.id,
      ip: getClientIp(req),
    });
    res.json({ ok: true });
  });

  router.get('/auth/me', requireAuth, (req: AuthedRequest, res) => {
    res.json({ user: req.authUser, serverTime: getServerWibNow() });
  });

  router.post('/auth/change-password', requireAuth, (req: AuthedRequest, res) => {
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
    if (newPassword === currentPassword || newPassword.toLowerCase() === 'admin123') {
      res.status(400).json({
        error: 'Password baru harus berbeda dari password saat ini dan tidak boleh menggunakan password bawaan.',
      });
      return;
    }

    const row = db
      .prepare(`SELECT id, username, password_hash FROM users WHERE id = ?`)
      .get(authUser.id) as { id: number; username: string; password_hash: string } | undefined;

    if (!row || !verifyPassword(currentPassword, row.password_hash)) {
      res.status(401).json({ error: 'Password saat ini tidak sesuai.' });
      return;
    }

    db.prepare(`UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?`).run(
      hashPassword(newPassword),
      authUser.id
    );

    appendAuditLog({
      userId: authUser.id,
      username: authUser.username,
      aksi: 'CHANGE_PASSWORD',
      entitas: 'users',
      entitasId: authUser.id,
      nilaiBaru: { must_change_password: false },
      ip: getClientIp(req),
    });

    const updatedUser = authenticateToken(req.authToken!);
    res.json({ ok: true, user: updatedUser });
  });

  // Public directory of Admin-imported supervisors for FR-AUT-02 registration
  router.get('/auth/supervisors-directory', (_req, res) => {
    const rows = db
      .prepare(
        `SELECT id, nama_lengkap, nip_nuptk, user_id, kode_verifikasi, status
         FROM supervisors
         WHERE status = 'active'
         ORDER BY nama_lengkap ASC`
      )
      .all() as Array<{
      id: number;
      nama_lengkap: string;
      nip_nuptk: string | null;
      user_id: number | null;
      kode_verifikasi: string | null;
      status: string;
    }>;

    res.json(
      rows.map((r) => ({
        id: r.id,
        nama_lengkap: r.nama_lengkap,
        nip_masked: r.nip_nuptk ? `***${r.nip_nuptk.slice(-4)}` : null,
        requires_verification: Boolean(r.kode_verifikasi || r.nip_nuptk),
        already_registered: Boolean(r.user_id),
      }))
    );
  });

  // FR-AUT-02..06: Pengawas self-registration linked to imported supervisor list
  router.post('/auth/register-supervisor', (req, res) => {
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
    const rate = checkRateLimit(rateKey);
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
      res.status(400).json({ error: 'Tanda tangan digital wajib dibuat untuk pelaporan berita acara.' });
      return;
    }

    const sup = db
      .prepare(`SELECT * FROM supervisors WHERE id = ? AND status = 'active'`)
      .get(supervisorId) as Record<string, unknown> | undefined;
    if (!sup) {
      res.status(404).json({ error: 'Nama pengawas tidak ditemukan pada daftar resmi panitia (BR-02).' });
      return;
    }
    if (sup.user_id) {
      res.status(409).json({ error: 'Akun untuk identitas ini sudah ada. Silakan masuk (BR-01).' });
      return;
    }

    // Identity verification (OD-02): match kode_verifikasi OR full NIP/NUPTK OR last 4 digits of NIP
    const expectedKode = sup.kode_verifikasi ? String(sup.kode_verifikasi).trim() : '';
    const expectedNip = sup.nip_nuptk ? String(sup.nip_nuptk).trim() : '';
    const supplied = (verificationInput || '').trim();
    if (expectedKode || expectedNip) {
      const ok =
        (expectedKode && supplied.toLowerCase() === expectedKode.toLowerCase()) ||
        (expectedNip && (supplied === expectedNip || supplied === expectedNip.slice(-4)));
      if (!ok) {
        recordFailedAttempt(rateKey);
        res.status(403).json({
          error: 'Verifikasi identitas gagal. Masukkan kode verifikasi dari Admin atau 4 digit terakhir NIP/NUPTK Anda.',
        });
        return;
      }
    }

    const cleanUsername = username.trim();
    const existingUser = db.prepare(`SELECT id FROM users WHERE username = ?`).get(cleanUsername);
    if (existingUser) {
      res.status(409).json({ error: 'Username sudah dipakai pengawas lain. Pilih username berbeda.' });
      return;
    }

    clearFailedAttempts(rateKey);
    const now = getServerWibNow().isoWib;
    const hash = hashPassword(password);

    const tx = db.transaction(() => {
      const userRes = db
        .prepare(
          `INSERT INTO users (username, password_hash, role, status, last_active_at, created_at)
           VALUES (?, ?, 'supervisor', 'active', ?, ?)`
        )
        .run(cleanUsername, hash, now, now);
      const userId = Number(userRes.lastInsertRowid);

      db.prepare(
        `UPDATE supervisors SET
           user_id = ?,
           nomor_identitas = COALESCE(?, nomor_identitas),
           tempat_lahir = COALESCE(?, tempat_lahir),
           tgl_lahir = COALESCE(?, tgl_lahir),
           alamat = COALESCE(?, alamat),
           whatsapp = COALESCE(?, whatsapp),
           foto_url = COALESCE(?, foto_url),
           ttd_url = ?
         WHERE id = ?`
      ).run(
        userId,
        nomor_identitas || null,
        tempat_lahir || null,
        tgl_lahir || null,
        alamat || null,
        whatsapp || null,
        foto_url || null,
        ttd_url,
        supervisorId
      );

      return userId;
    });

    const newUserId = tx();
    const token = createSessionToken(newUserId);
    const user = authenticateToken(token);

    appendAuditLog({
      userId: newUserId,
      username: cleanUsername,
      aksi: 'REGISTER_SUPERVISOR',
      entitas: 'supervisors',
      entitasId: supervisorId,
      nilaiBaru: { username: cleanUsername, nama_lengkap: sup.nama_lengkap },
      ip,
    });

    res.status(201).json({ token, user });
  });

  // FR-AUT-08: Forgot password request forwarded to Admin
  router.post('/auth/forgot-password', (req, res) => {
    const { username, catatan } = req.body as { username?: string; catatan?: string };
    const clean = (username || '').trim();
    if (!clean) {
      res.status(400).json({ error: 'Masukkan username Anda.' });
      return;
    }
    const user = db.prepare(`SELECT id, username FROM users WHERE username = ?`).get(clean) as
      | { id: number; username: string }
      | undefined;

    notifyAllAdmins({
      judul: 'Permintaan Reset Password Pengawas',
      isi: `Username "${clean}" mengajukan reset password. Catatan: ${catatan || '-'}.`,
      kategori: 'akun',
      linkTarget: 'admin:supervisors',
    });
    appendAuditLog({
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
      message: 'Permintaan reset password telah dikirim ke Panitia (Admin). Hubungi Admin untuk menerima password baru.',
    });
  });

  // ========================
  // PROFILE (FR-PRF-01..03)
  // ========================
  router.get('/profile', requireAuth, (req: AuthedRequest, res) => {
    const user = req.authUser!;
    if (user.role === 'admin') {
      res.json({ role: 'admin', username: user.username, nama_lengkap: user.namaLengkap });
      return;
    }
    const sup = db.prepare(`SELECT * FROM supervisors WHERE user_id = ?`).get(user.id);
    res.json({ role: 'supervisor', username: user.username, profile: sup });
  });

  router.put('/profile', requireAuth, (req: AuthedRequest, res) => {
    const user = req.authUser!;
    if (user.role !== 'supervisor' || !user.supervisorId) {
      res.status(403).json({ error: 'Profil pengawas tidak ditemukan.' });
      return;
    }
    const prev = db.prepare(`SELECT * FROM supervisors WHERE id = ?`).get(user.supervisorId) as Record<string, unknown>;
    const { nomor_identitas, tempat_lahir, tgl_lahir, alamat, whatsapp, foto_url, ttd_url } = req.body as Record<
      string,
      string | undefined
    >;

    // FR-PRF-02: nama_lengkap and nip_nuptk imported by Admin CANNOT be modified by supervisor
    db.prepare(
      `UPDATE supervisors SET
         nomor_identitas = COALESCE(?, nomor_identitas),
         tempat_lahir = COALESCE(?, tempat_lahir),
         tgl_lahir = COALESCE(?, tgl_lahir),
         alamat = COALESCE(?, alamat),
         whatsapp = COALESCE(?, whatsapp),
         foto_url = COALESCE(?, foto_url),
         ttd_url = COALESCE(?, ttd_url)
       WHERE id = ?`
    ).run(
      nomor_identitas ?? null,
      tempat_lahir ?? null,
      tgl_lahir ?? null,
      alamat ?? null,
      whatsapp ?? null,
      foto_url ?? null,
      ttd_url ?? null,
      user.supervisorId
    );

    if (foto_url && foto_url !== prev.foto_url) {
      appendAuditLog({
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
    if (ttd_url && ttd_url !== prev.ttd_url) {
      appendAuditLog({
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

    const updated = db.prepare(`SELECT * FROM supervisors WHERE id = ?`).get(user.supervisorId);
    res.json({ profile: updated });
  });

  // ========================
  // NOTIFICATIONS (FR-NOT)
  // ========================
  router.get('/notifications', requireAuth, (req: AuthedRequest, res) => {
    const rows = db
      .prepare(`SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 100`)
      .all(req.authUser!.id);
    res.json(rows);
  });

  router.post('/notifications/:id/read', requireAuth, (req: AuthedRequest, res) => {
    const id = Number(req.params.id);
    db.prepare(`UPDATE notifications SET dibaca = 1 WHERE id = ? AND user_id = ?`).run(id, req.authUser!.id);
    res.json({ ok: true });
  });

  router.post('/notifications/read-all', requireAuth, (req: AuthedRequest, res) => {
    db.prepare(`UPDATE notifications SET dibaca = 1 WHERE user_id = ?`).run(req.authUser!.id);
    res.json({ ok: true });
  });

  // ========================
  // ADMIN: EXAMS, ROOMS, SCHEDULES, SUPERVISORS
  // ========================
  router.get('/admin/exams', requireAuth, requireAdmin, (_req, res) => {
    const exams = db.prepare(`SELECT * FROM exams ORDER BY id DESC`).all();
    res.json(exams);
  });

  router.post('/admin/exams', requireAuth, requireAdmin, (req: AuthedRequest, res) => {
    const { nama, madrasah_nama, tahun_ajaran, tanggal_mulai, tanggal_selesai, warning_minutes_before_end } =
      req.body as Record<string, string | number>;
    if (!nama || !tahun_ajaran || !tanggal_mulai || !tanggal_selesai) {
      res.status(400).json({ error: 'Nama kegiatan, tahun ajaran, dan rentang tanggal wajib diisi.' });
      return;
    }
    if (String(tanggal_selesai) < String(tanggal_mulai)) {
      res.status(400).json({ error: 'Tanggal selesai tidak boleh lebih awal dari tanggal mulai.' });
      return;
    }
    const now = getServerWibNow().isoWib;
    const info = db
      .prepare(
        `INSERT INTO exams (nama, madrasah_nama, tahun_ajaran, tanggal_mulai, tanggal_selesai, status, warning_minutes_before_end, created_at)
         VALUES (?, ?, ?, ?, ?, 'aktif', ?, ?)`
      )
      .run(
        String(nama),
        String(madrasah_nama || 'Madrasah Aliyah Negeri'),
        String(tahun_ajaran),
        String(tanggal_mulai),
        String(tanggal_selesai),
        Number(warning_minutes_before_end || 15),
        now
      );
    const examId = Number(info.lastInsertRowid);
    ensureGeneratedDocRows(examId, req.authUser!.id);
    appendAuditLog({
      userId: req.authUser!.id,
      username: req.authUser!.username,
      aksi: 'CREATE_EXAM',
      entitas: 'exams',
      entitasId: examId,
      nilaiBaru: req.body,
      ip: getClientIp(req),
    });
    res.status(201).json(db.prepare(`SELECT * FROM exams WHERE id = ?`).get(examId));
  });

  router.get('/admin/rooms', requireAuth, requireAdmin, (_req, res) => {
    const rooms = db.prepare(`SELECT * FROM rooms ORDER BY kode ASC`).all() as Array<Record<string, unknown>>;
    const seats = db
      .prepare(
        `SELECT s.*, st.nomor_peserta, st.nisn, st.nama AS student_nama, st.kelas
         FROM seats s
         LEFT JOIN students st ON st.id = s.student_id
         ORDER BY s.baris ASC, s.kolom ASC`
      )
      .all() as Array<Record<string, unknown>>;

    res.json(
      rooms.map((r) => ({
        ...r,
        seats: seats.filter((s) => s.room_id === r.id),
      }))
    );
  });

  router.put('/admin/rooms/:roomId/layout', requireAuth, requireAdmin, (req: AuthedRequest, res) => {
    const roomId = Number(req.params.roomId);
    const { rows_count, cols_count, denah_lingkungan_json, seats } = req.body as {
      rows_count?: number;
      cols_count?: number;
      denah_lingkungan_json?: string;
      seats?: Array<{ kode_kursi: string; baris: number; kolom: number; student_id?: number | null }>;
    };

    const tx = db.transaction(() => {
      if (rows_count && cols_count) {
        db.prepare(`UPDATE rooms SET rows_count = ?, cols_count = ?, denah_lingkungan_json = COALESCE(?, denah_lingkungan_json) WHERE id = ?`).run(
          rows_count,
          cols_count,
          denah_lingkungan_json ?? null,
          roomId
        );
      }
      if (Array.isArray(seats)) {
        const upsert = db.prepare(
          `INSERT INTO seats (room_id, kode_kursi, baris, kolom, posisi_x, posisi_y, student_id)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(room_id, kode_kursi) DO UPDATE SET
             baris = excluded.baris,
             kolom = excluded.kolom,
             posisi_x = excluded.posisi_x,
             posisi_y = excluded.posisi_y,
             student_id = excluded.student_id`
        );
        for (const s of seats) {
          upsert.run(roomId, s.kode_kursi, s.baris, s.kolom, s.kolom, s.baris, s.student_id ?? null);
        }
      }
      const latestExam = db.prepare(`SELECT id FROM exams ORDER BY id DESC LIMIT 1`).get() as { id: number } | undefined;
      if (latestExam) markGeneratedDocumentsStale(latestExam.id);
    });
    tx();

    appendAuditLog({
      userId: req.authUser!.id,
      username: req.authUser!.username,
      aksi: 'UPDATE_ROOM_LAYOUT',
      entitas: 'rooms',
      entitasId: roomId,
      nilaiBaru: { rows_count, cols_count, seatCount: seats?.length ?? 0 },
      ip: getClientIp(req),
    });

    res.json({ ok: true });
  });

  router.get('/admin/students', requireAuth, requireAdmin, (_req, res) => {
    const rows = db.prepare(`SELECT * FROM students ORDER BY nomor_peserta ASC`).all();
    res.json(rows);
  });

  router.get('/admin/supervisors', requireAuth, requireAdmin, (_req, res) => {
    const rows = db
      .prepare(
        `SELECT s.*, u.username, u.status AS user_status
         FROM supervisors s
         LEFT JOIN users u ON u.id = s.user_id
         ORDER BY s.nama_lengkap ASC`
      )
      .all();
    res.json(rows);
  });

  router.post('/admin/supervisors/:id/toggle-status', requireAuth, requireAdmin, (req: AuthedRequest, res) => {
    const supId = Number(req.params.id);
    const sup = db.prepare(`SELECT * FROM supervisors WHERE id = ?`).get(supId) as
      | { id: number; user_id: number | null; status: 'active' | 'inactive'; nama_lengkap: string }
      | undefined;
    if (!sup) {
      res.status(404).json({ error: 'Pengawas tidak ditemukan.' });
      return;
    }
    const nextStatus = sup.status === 'active' ? 'inactive' : 'active';
    db.prepare(`UPDATE supervisors SET status = ? WHERE id = ?`).run(nextStatus, supId);
    if (sup.user_id) {
      db.prepare(`UPDATE users SET status = ? WHERE id = ?`).run(nextStatus, sup.user_id);
    }
    appendAuditLog({
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
  });

  router.post('/admin/supervisors/:id/reset-password', requireAuth, requireAdmin, (req: AuthedRequest, res) => {
    const supId = Number(req.params.id);
    const { newPassword } = req.body as { newPassword?: string };
    if (!newPassword || newPassword.length < 8) {
      res.status(400).json({ error: 'Password baru minimal 8 karakter.' });
      return;
    }
    const sup = db.prepare(`SELECT user_id, nama_lengkap FROM supervisors WHERE id = ?`).get(supId) as
      | { user_id: number | null; nama_lengkap: string }
      | undefined;
    if (!sup || !sup.user_id) {
      res.status(400).json({ error: 'Pengawas belum memiliki akun terdaftar.' });
      return;
    }
    db.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).run(hashPassword(newPassword), sup.user_id);
    appendAuditLog({
      userId: req.authUser!.id,
      username: req.authUser!.username,
      aksi: 'ADMIN_RESET_PASSWORD',
      entitas: 'users',
      entitasId: sup.user_id,
      nilaiBaru: { supervisor: sup.nama_lengkap },
      ip: getClientIp(req),
    });
    res.json({ ok: true });
  });

  // Schedules & assignment management (FR-JDW-06 notifications)
  router.get('/admin/schedules', requireAuth, requireAdmin, (_req, res) => {
    const rows = db
      .prepare(
        `SELECT sch.*, ses.exam_id, ses.nama_sesi, ex.nama AS exam_nama, ex.madrasah_nama, ex.tahun_ajaran, ex.warning_minutes_before_end,
                sub.kode AS subject_kode, sub.nama AS subject_nama,
                rm.kode AS room_kode, rm.nama AS room_nama, rm.kapasitas AS room_kapasitas
         FROM exam_schedules sch
         JOIN exam_sessions ses ON ses.id = sch.exam_session_id
         JOIN exams ex ON ex.id = ses.exam_id
         JOIN subjects sub ON sub.id = sch.subject_id
         JOIN rooms rm ON rm.id = sch.room_id
         ORDER BY sch.tanggal DESC, sch.jam_mulai ASC`
      )
      .all() as Array<Record<string, unknown>>;

    res.json(rows.map((r) => buildScheduleItem(r)));
  });

  router.post('/admin/schedules/:scheduleId/assign', requireAuth, requireAdmin, (req: AuthedRequest, res) => {
    const scheduleId = Number(req.params.scheduleId);
    const { supervisorId, peran } = req.body as { supervisorId?: number; peran?: 'utama' | 'pendamping' };
    if (!supervisorId || !peran) {
      res.status(400).json({ error: 'Pengawas dan peran wajib dipilih.' });
      return;
    }
    const sched = db
      .prepare(
        `SELECT sch.*, ses.exam_id, rm.kode AS room_kode, sub.nama AS subject_nama
         FROM exam_schedules sch
         JOIN exam_sessions ses ON ses.id = sch.exam_session_id
         JOIN rooms rm ON rm.id = sch.room_id
         JOIN subjects sub ON sub.id = sch.subject_id
         WHERE sch.id = ?`
      )
      .get(scheduleId) as Record<string, unknown> | undefined;
    if (!sched) {
      res.status(404).json({ error: 'Jadwal tidak ditemukan.' });
      return;
    }

    // Check double booking on overlapping time
    const conflict = db
      .prepare(
        `SELECT sa.id FROM supervision_assignments sa
         JOIN exam_schedules es ON es.id = sa.exam_schedule_id
         WHERE sa.supervisor_id = ? AND es.id != ? AND es.tanggal = ?
           AND NOT (es.jam_selesai <= ? OR es.jam_mulai >= ?)`
      )
      .get(supervisorId, scheduleId, sched.tanggal, sched.jam_mulai, sched.jam_selesai);
    if (conflict) {
      res.status(409).json({ error: 'Pengawas sudah memiliki tugas di ruang lain pada jam yang sama.' });
      return;
    }

    db.prepare(
      `INSERT INTO supervision_assignments (supervisor_id, room_id, exam_session_id, exam_schedule_id, peran, status_jadwal)
       VALUES (?, ?, ?, ?, ?, 'akan_datang')
       ON CONFLICT(supervisor_id, exam_schedule_id) DO UPDATE SET peran = excluded.peran`
    ).run(supervisorId, sched.room_id, sched.exam_session_id, scheduleId, peran);

    const sup = db.prepare(`SELECT user_id, nama_lengkap FROM supervisors WHERE id = ?`).get(supervisorId) as
      | { user_id: number | null; nama_lengkap: string }
      | undefined;

    if (sup?.user_id) {
      const nid = createNotification({
        userId: sup.user_id,
        judul: 'Penugasan Pengawasan Baru / Diperbarui',
        isi: `Anda ditugaskan sebagai pengawas ${peran} di Ruang ${sched.room_kode} (${sched.subject_nama}, ${sched.tanggal} ${sched.jam_mulai}-${sched.jam_selesai} WIB).`,
        kategori: 'jadwal',
        linkTarget: 'supervisor:schedules',
      });
      broadcastToUser(sup.user_id, { type: 'notification:new', notificationId: nid });
    }

    markGeneratedDocumentsStale(Number(sched.exam_id));
    appendAuditLog({
      userId: req.authUser!.id,
      username: req.authUser!.username,
      aksi: 'ASSIGN_SUPERVISOR',
      entitas: 'supervision_assignments',
      entitasId: scheduleId,
      nilaiBaru: { supervisorId, peran },
      ip: getClientIp(req),
    });

    res.json({ ok: true });
  });

  router.post('/admin/schedules/:scheduleId/cancel', requireAuth, requireAdmin, (req: AuthedRequest, res) => {
    const scheduleId = Number(req.params.scheduleId);
    const { cancelled } = req.body as { cancelled: boolean };
    db.prepare(`UPDATE exam_schedules SET status_manual_cancel = ? WHERE id = ?`).run(cancelled ? 1 : 0, scheduleId);

    const assignedUsers = db
      .prepare(
        `SELECT s.user_id FROM supervision_assignments sa
         JOIN supervisors s ON s.id = sa.supervisor_id
         WHERE sa.exam_schedule_id = ? AND s.user_id IS NOT NULL`
      )
      .all(scheduleId) as Array<{ user_id: number }>;

    for (const u of assignedUsers) {
      const nid = createNotification({
        userId: u.user_id,
        judul: cancelled ? 'Jadwal Pengawasan Dibatalkan' : 'Jadwal Pengawasan Diaktifkan Kembali',
        isi: `Status jadwal pengawasan #${scheduleId} telah diperbarui oleh Panitia.`,
        kategori: 'jadwal',
        linkTarget: 'supervisor:schedules',
      });
      broadcastToUser(u.user_id, { type: 'notification:new', notificationId: nid });
    }

    appendAuditLog({
      userId: req.authUser!.id,
      username: req.authUser!.username,
      aksi: cancelled ? 'CANCEL_SCHEDULE' : 'RESTORE_SCHEDULE',
      entitas: 'exam_schedules',
      entitasId: scheduleId,
      ip: getClientIp(req),
    });
    res.json({ ok: true });
  });

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

  router.get('/admin/import/batches', requireAuth, requireAdmin, (_req, res) => {
    const rows = db
      .prepare(
        `SELECT id, exam_id, filename, sha256, detected_type, confidence, status, created_at, confirmed_at
         FROM import_batches ORDER BY id DESC LIMIT 50`
      )
      .all();
    res.json(rows);
  });

  router.post('/admin/import/upload', requireAuth, requireAdmin, upload.single('file'), async (req: AuthedRequest, res) => {
    if (!req.file) {
      res.status(400).json({ error: 'Berkas dokumen wajib dipilih.' });
      return;
    }

    const filePath = req.file.path;
    const sha256 = crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
    const examIdRaw = req.body.examId ? Number(req.body.examId) : null;
    const now = getServerWibNow().isoWib;

    try {
      const extracted = await extractDocumentFromFile(
        filePath,
        req.file.originalname,
        req.file.mimetype,
        examIdRaw
      );

      // Immutable source archive in documents table (BR-09)
      db.prepare(
        `INSERT INTO documents (exam_id, jenis, nama_file, path, sha256, uploaded_by, version, status_verifikasi, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, 'arsip_sumber', ?)`
      ).run(examIdRaw, `sumber_${extracted.detected_type}`, req.file.originalname, filePath, sha256, req.authUser!.id, now);

      const batchInfo = db
        .prepare(
          `INSERT INTO import_batches (exam_id, filename, file_path, sha256, detected_type, confidence, status, extracted_json, errors_json, duplicates_json, uploaded_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'preview', ?, ?, ?, ?, ?)`
        )
        .run(
          examIdRaw,
          req.file.originalname,
          filePath,
          sha256,
          extracted.detected_type,
          extracted.confidence,
          JSON.stringify(extracted.rows),
          JSON.stringify(extracted.unreadable_fields),
          JSON.stringify(extracted.duplicates),
          req.authUser!.id,
          now
        );

      const batchId = Number(batchInfo.lastInsertRowid);
      appendAuditLog({
        userId: req.authUser!.id,
        username: req.authUser!.username,
        aksi: 'UPLOAD_IMPORT_DOCUMENT',
        entitas: 'import_batches',
        entitasId: batchId,
        nilaiBaru: {
          filename: req.file.originalname,
          sha256,
          detected_type: extracted.detected_type,
          rowCount: extracted.rows.length,
        },
        ip: getClientIp(req),
      });

      res.json({
        id: batchId,
        exam_id: examIdRaw,
        filename: req.file.originalname,
        sha256,
        detected_type: extracted.detected_type,
        confidence: extracted.confidence,
        status: 'preview',
        extracted_rows: extracted.rows,
        unreadable_fields: extracted.unreadable_fields,
        duplicates: extracted.duplicates,
        created_at: now,
        confirmed_at: null,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Gagal mengekstrak dokumen.';
      const batchInfo = db
        .prepare(
          `INSERT INTO import_batches (exam_id, filename, file_path, sha256, detected_type, confidence, status, extracted_json, errors_json, uploaded_by, created_at)
           VALUES (?, ?, ?, ?, 'dokumen_pendukung', 0, 'failed', '[]', ?, ?, ?)`
        )
        .run(
          examIdRaw,
          req.file.originalname,
          filePath,
          sha256,
          JSON.stringify([{ rowIndex: -1, field: 'file', reason: msg }]),
          req.authUser!.id,
          now
        );
      res.status(422).json({ error: msg, batchId: Number(batchInfo.lastInsertRowid) });
    }
  });

  // One-click realistic SAUM sample package import (creates real preview batches through the full pipeline)
  router.post('/admin/import/sample-package', requireAuth, requireAdmin, (req: AuthedRequest, res) => {
    const nowWib = getServerWibNow();
    const today = nowWib.date;
    // Create an active window right now around server WIB time so evaluators can test active supervision immediately
    const nowDate = new Date();
    const startDt = new Date(nowDate.getTime() - 15 * 60 * 1000);
    const endDt = new Date(nowDate.getTime() + 75 * 60 * 1000);
    const fmtTime = (d: Date) => {
      const w = getServerWibNow(d);
      return w.time.slice(0, 5);
    };
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
      const sampleFilePath = path.join(UPLOADS_DIR, `${Date.now()}_${item.filename}`);
      const ws = XLSX.utils.json_to_sheet(item.rows);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Ekspor_SAUM');
      const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
      fs.writeFileSync(sampleFilePath, buf);
      const sha256 = crypto.createHash('sha256').update(buf).digest('hex');

      const info = db
        .prepare(
          `INSERT INTO import_batches (filename, file_path, sha256, detected_type, confidence, status, extracted_json, errors_json, duplicates_json, uploaded_by, created_at)
           VALUES (?, ?, ?, ?, 1.0, 'preview', ?, '[]', '[]', ?, ?)`
        )
        .run(item.filename, sampleFilePath, sha256, item.type, JSON.stringify(item.rows), req.authUser!.id, nowWib.isoWib);

      const batchId = Number(info.lastInsertRowid);
      commitImportBatch({
        batchId,
        docType: item.type,
        rows: item.rows,
        userId: req.authUser!.id,
      });
      createdCount++;
    }

    appendAuditLog({
      userId: req.authUser!.id,
      username: req.authUser!.username,
      aksi: 'IMPORT_SAMPLE_SAUM_PACKAGE',
      entitas: 'import_batches',
      nilaiBaru: { batches: createdCount },
      ip: getClientIp(req),
    });

    res.json({ ok: true, batchesImported: createdCount });
  });

  router.get('/admin/import/:batchId', requireAuth, requireAdmin, (req, res) => {
    const batchId = Number(req.params.batchId);
    const row = db.prepare(`SELECT * FROM import_batches WHERE id = ?`).get(batchId) as Record<string, unknown> | undefined;
    if (!row) {
      res.status(404).json({ error: 'Batch impor tidak ditemukan.' });
      return;
    }
    res.json({
      id: row.id,
      exam_id: row.exam_id,
      filename: row.filename,
      sha256: row.sha256,
      detected_type: row.detected_type,
      confidence: row.confidence,
      status: row.status,
      extracted_rows: JSON.parse(String(row.extracted_json || '[]')),
      unreadable_fields: JSON.parse(String(row.errors_json || '[]')),
      duplicates: JSON.parse(String(row.duplicates_json || '[]')),
      created_at: row.created_at,
      confirmed_at: row.confirmed_at,
    });
  });

  // Admin edits preview rows or reclassifies document type before KONFIRMASI SIMPAN
  router.put('/admin/import/:batchId', requireAuth, requireAdmin, (req: AuthedRequest, res) => {
    const batchId = Number(req.params.batchId);
    const batch = db.prepare(`SELECT * FROM import_batches WHERE id = ?`).get(batchId) as Record<string, unknown> | undefined;
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

    const nextType = (detected_type || batch.detected_type) as ImportDocType;
    const nextRows = extracted_rows || JSON.parse(String(batch.extracted_json || '[]'));
    const { unreadable_fields, duplicates } = detectDuplicatesAndUnreadable(
      nextType,
      nextRows,
      exam_id ?? (batch.exam_id as number | null)
    );

    db.prepare(
      `UPDATE import_batches SET detected_type = ?, extracted_json = ?, errors_json = ?, duplicates_json = ?, exam_id = ? WHERE id = ?`
    ).run(
      nextType,
      JSON.stringify(nextRows),
      JSON.stringify(unreadable_fields),
      JSON.stringify(duplicates),
      exam_id ?? batch.exam_id ?? null,
      batchId
    );

    appendAuditLog({
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
      unreadable_fields,
      duplicates,
    });
  });

  // FR-IMP-08: KONFIRMASI SIMPAN
  router.post('/admin/import/:batchId/confirm', requireAuth, requireAdmin, (req: AuthedRequest, res) => {
    const batchId = Number(req.params.batchId);
    const batch = db.prepare(`SELECT * FROM import_batches WHERE id = ?`).get(batchId) as Record<string, unknown> | undefined;
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

    const docType = (body.detected_type || batch.detected_type) as ImportDocType;
    const rows = body.extracted_rows || JSON.parse(String(batch.extracted_json || '[]'));

    const summary = commitImportBatch({
      batchId,
      docType,
      rows,
      examId: body.exam_id ?? (batch.exam_id as number | null),
      userId: req.authUser!.id,
    });

    appendAuditLog({
      userId: req.authUser!.id,
      username: req.authUser!.username,
      aksi: 'CONFIRM_IMPORT_BATCH',
      entitas: 'import_batches',
      entitasId: batchId,
      nilaiBaru: { docType, ...summary },
      ip: getClientIp(req),
    });

    res.json({ ok: true, ...summary });
  });

  // ========================
  // ADMIN: 11 GENERATED DOCUMENTS (FR-GEN)
  // ========================
  router.get('/admin/documents/generated', requireAuth, (_req, res) => {
    const exam = db.prepare(`SELECT * FROM exams ORDER BY id DESC LIMIT 1`).get() as Record<string, unknown> | undefined;
    if (!exam) {
      res.json({ exam: null, catalog: ELEVEN_DOCS_CATALOG, versions: [] });
      return;
    }
    ensureGeneratedDocRows(Number(exam.id), null);
    const versions = db
      .prepare(`SELECT * FROM generated_doc_versions WHERE exam_id = ? ORDER BY id ASC`)
      .all(exam.id);
    res.json({ exam, catalog: ELEVEN_DOCS_CATALOG, versions });
  });

  router.post('/admin/documents/generated/regenerate', requireAuth, requireAdmin, (req: AuthedRequest, res) => {
    const { examId, docKey } = req.body as { examId?: number; docKey?: string };
    const exam = examId
      ? db.prepare(`SELECT id FROM exams WHERE id = ?`).get(examId)
      : db.prepare(`SELECT id FROM exams ORDER BY id DESC LIMIT 1`).get();
    if (!exam) {
      res.status(404).json({ error: 'Kegiatan ujian belum ada.' });
      return;
    }
    const eid = (exam as { id: number }).id;
    ensureGeneratedDocRows(eid, req.authUser!.id);
    const now = getServerWibNow().isoWib;

    if (docKey) {
      db.prepare(
        `UPDATE generated_doc_versions SET version = version + 1, needs_regeneration = 0, generated_at = ?, generated_by = ?
         WHERE exam_id = ? AND doc_key = ?`
      ).run(now, req.authUser!.id, eid, docKey);
    } else {
      db.prepare(
        `UPDATE generated_doc_versions SET version = version + 1, needs_regeneration = 0, generated_at = ?, generated_by = ?
         WHERE exam_id = ?`
      ).run(now, req.authUser!.id, eid);
    }

    appendAuditLog({
      userId: req.authUser!.id,
      username: req.authUser!.username,
      aksi: 'GENERATE_ADMINISTRATION_DOCS',
      entitas: 'generated_doc_versions',
      entitasId: eid,
      nilaiBaru: { docKey: docKey || 'ALL_11_DOCS' },
      ip: getClientIp(req),
    });

    const versions = db.prepare(`SELECT * FROM generated_doc_versions WHERE exam_id = ? ORDER BY id ASC`).all(eid);
    res.json({ ok: true, versions });
  });

  // ========================
  // ADMIN: MONITORING, REPORTS VERIFICATION, AUDIT LOGS, EXPORT
  // ========================
  router.get('/admin/monitoring', requireAuth, requireAdmin, (_req, res) => {
    const now = new Date();
    const schedulesRaw = db
      .prepare(
        `SELECT sch.*, ses.exam_id, ses.nama_sesi, ex.nama AS exam_nama, ex.madrasah_nama, ex.tahun_ajaran, ex.warning_minutes_before_end,
                sub.kode AS subject_kode, sub.nama AS subject_nama,
                rm.kode AS room_kode, rm.nama AS room_nama, rm.kapasitas AS room_kapasitas
         FROM exam_schedules sch
         JOIN exam_sessions ses ON ses.id = sch.exam_session_id
         JOIN exams ex ON ex.id = ses.exam_id
         JOIN subjects sub ON sub.id = sch.subject_id
         JOIN rooms rm ON rm.id = sch.room_id
         ORDER BY sch.tanggal DESC, sch.jam_mulai ASC`
      )
      .all() as Array<Record<string, unknown>>;

    const schedules = schedulesRaw.map((r) => buildScheduleItem(r));

    const totalSupervisors = (db.prepare(`SELECT COUNT(*) AS c FROM supervisors WHERE status = 'active'`).get() as { c: number }).c;
    const totalRooms = (db.prepare(`SELECT COUNT(*) AS c FROM rooms`).get() as { c: number }).c;
    const totalSessions = (db.prepare(`SELECT COUNT(*) AS c FROM exam_sessions`).get() as { c: number }).c;

    const checkedInSupervisors = (
      db.prepare(`SELECT COUNT(DISTINCT sa.supervisor_id) AS c FROM supervisor_attendance att JOIN supervision_assignments sa ON sa.id = att.assignment_id WHERE att.status = 'hadir'`).get() as { c: number }
    ).c;

    const activeRooms = schedules.filter((s) => s.computed_status === 'aktif');
    const studentHad = (db.prepare(`SELECT COUNT(*) AS c FROM attendance WHERE status = 'hadir'`).get() as { c: number }).c;
    const studentTidakHad = (db.prepare(`SELECT COUNT(*) AS c FROM attendance WHERE status = 'tidak_hadir'`).get() as { c: number }).c;
    const activeExits = (db.prepare(`SELECT COUNT(*) AS c FROM exit_permissions WHERE waktu_kembali IS NULL`).get() as { c: number }).c;
    const totalExits = (db.prepare(`SELECT COUNT(*) AS c FROM exit_permissions`).get() as { c: number }).c;
    const totalWarnings = (db.prepare(`SELECT COUNT(*) AS c FROM warnings WHERE is_correction = 0`).get() as { c: number }).c;

    const level3Alerts = db
      .prepare(
        `SELECT w.*, st.nama AS student_nama, st.nomor_peserta, st.kelas,
                rm.kode AS room_kode, rm.nama AS room_nama, sub.nama AS subject_nama
         FROM warnings w
         JOIN students st ON st.id = w.student_id
         JOIN exam_schedules es ON es.id = w.exam_schedule_id
         JOIN rooms rm ON rm.id = es.room_id
         JOIN subjects sub ON sub.id = es.subject_id
         WHERE w.tingkat = 3
         ORDER BY w.id DESC LIMIT 30`
      )
      .all();

    const submittedReports = (
      db.prepare(`SELECT COUNT(*) AS c FROM supervision_reports WHERE status IN ('menunggu_verifikasi', 'perlu_perbaikan', 'terverifikasi')`).get() as { c: number }
    ).c;
    const unverifiedReports = (
      db.prepare(`SELECT COUNT(*) AS c FROM supervision_reports WHERE status = 'menunggu_verifikasi'`).get() as { c: number }
    ).c;

    res.json({
      serverTime: getServerWibNow(now),
      summary: {
        totalSupervisors,
        checkedInSupervisors,
        absentSupervisors: Math.max(0, totalSupervisors - checkedInSupervisors),
        totalRooms,
        totalSessions,
        activeRoomsCount: activeRooms.length,
        studentHadir: studentHad,
        studentTidakHadir: studentTidakHad,
        activeExits,
        totalExits,
        totalWarnings,
        level3Count: level3Alerts.length,
        submittedReports,
        unverifiedReports,
      },
      schedules,
      level3Alerts,
    });
  });

  router.get('/admin/reports', requireAuth, requireAdmin, (_req, res) => {
    const rows = db
      .prepare(
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
      )
      .all() as Array<Record<string, unknown>>;

    const verifs = db
      .prepare(
        `SELECT rv.*, u.username AS admin_nama
         FROM report_verifications rv
         JOIN users u ON u.id = rv.admin_id
         ORDER BY rv.id DESC`
      )
      .all() as Array<Record<string, unknown>>;

    res.json(
      rows.map((r) => ({
        ...r,
        verifications: verifs.filter((v) => v.report_id === r.id),
      }))
    );
  });

  router.post('/admin/reports/:reportId/verify', requireAuth, requireAdmin, (req: AuthedRequest, res) => {
    const reportId = Number(req.params.reportId);
    const { status, catatan } = req.body as { status?: 'terverifikasi' | 'perlu_perbaikan'; catatan?: string };
    if (status !== 'terverifikasi' && status !== 'perlu_perbaikan') {
      res.status(400).json({ error: 'Status verifikasi tidak valid.' });
      return;
    }
    if (status === 'perlu_perbaikan' && (!catatan || catatan.trim() === '')) {
      res.status(400).json({ error: 'Catatan wajib diisi ketika meminta perbaikan laporan.' });
      return;
    }

    const report = db
      .prepare(
        `SELECT sr.*, s.user_id AS supervisor_user_id
         FROM supervision_reports sr
         JOIN supervisors s ON s.id = sr.supervisor_id
         WHERE sr.id = ?`
      )
      .get(reportId) as { id: number; status: string; supervisor_user_id: number | null; jenis: string; exam_schedule_id: number } | undefined;

    if (!report) {
      res.status(404).json({ error: 'Laporan tidak ditemukan.' });
      return;
    }

    const now = getServerWibNow().isoWib;
    const tx = db.transaction(() => {
      db.prepare(`UPDATE supervision_reports SET status = ? WHERE id = ?`).run(status, reportId);
      db.prepare(
        `INSERT INTO report_verifications (report_id, admin_id, status, catatan, waktu) VALUES (?, ?, ?, ?, ?)`
      ).run(reportId, req.authUser!.id, status, catatan || null, now);
    });
    tx();

    if (report.supervisor_user_id) {
      const nid = createNotification({
        userId: report.supervisor_user_id,
        judul: status === 'terverifikasi' ? 'Laporan Pengawasan Terverifikasi' : 'Laporan Pengawasan Perlu Perbaikan',
        isi:
          status === 'terverifikasi'
            ? `Dokumen ${report.jenis === 'berita_acara' ? 'Berita Acara' : 'Daftar Hadir'} Anda telah diverifikasi Admin.`
            : `Admin meminta perbaikan pada ${report.jenis === 'berita_acara' ? 'Berita Acara' : 'Daftar Hadir'}: ${catatan}`,
        kategori: 'laporan',
        linkTarget: `supervisor:reports:${report.exam_schedule_id}`,
      });
      broadcastToUser(report.supervisor_user_id, { type: 'notification:new', notificationId: nid });
    }

    broadcastToSchedule(report.exam_schedule_id, { type: 'report:updated', scheduleId: report.exam_schedule_id });
    appendAuditLog({
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
  });

  router.get('/admin/audit-logs', requireAuth, requireAdmin, (req, res) => {
    const limit = Math.min(300, Math.max(20, Number(req.query.limit) || 150));
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (q) {
      const like = `%${q}%`;
      const rows = db
        .prepare(
          `SELECT * FROM audit_logs
           WHERE aksi LIKE ? OR entitas LIKE ? OR COALESCE(username, '') LIKE ?
           ORDER BY id DESC LIMIT ?`
        )
        .all(like, like, like, limit);
      res.json(rows);
      return;
    }
    const rows = db.prepare(`SELECT * FROM audit_logs ORDER BY id DESC LIMIT ?`).all(limit);
    res.json(rows);
  });

  // FR-MON-05: Downloadable XLSX/CSV recap export
  router.get('/admin/recap/export', requireAuth, requireAdmin, (req, res) => {
    const format = req.query.format === 'csv' ? 'csv' : 'xlsx';
    const schedulesRaw = db
      .prepare(
        `SELECT sch.id, ses.nama_sesi, ex.nama AS kegiatan, sch.tanggal, sch.jam_mulai, sch.jam_selesai,
                rm.kode AS kode_ruang, rm.nama AS nama_ruang, sub.nama AS mata_pelajaran
         FROM exam_schedules sch
         JOIN exam_sessions ses ON ses.id = sch.exam_session_id
         JOIN exams ex ON ex.id = ses.exam_id
         JOIN rooms rm ON rm.id = sch.room_id
         JOIN subjects sub ON sub.id = sch.subject_id
         ORDER BY sch.tanggal ASC, sch.jam_mulai ASC`
      )
      .all() as Array<Record<string, unknown>>;

    const recapRows = schedulesRaw.map((s) => {
      const sid = Number(s.id);
      const hadir = (db.prepare(`SELECT COUNT(*) AS c FROM attendance WHERE exam_schedule_id = ? AND status = 'hadir'`).get(sid) as { c: number }).c;
      const tidakHadir = (db.prepare(`SELECT COUNT(*) AS c FROM attendance WHERE exam_schedule_id = ? AND status = 'tidak_hadir'`).get(sid) as { c: number }).c;
      const p1 = (db.prepare(`SELECT COUNT(*) AS c FROM warnings WHERE exam_schedule_id = ? AND tingkat = 1 AND is_correction = 0`).get(sid) as { c: number }).c;
      const p2 = (db.prepare(`SELECT COUNT(*) AS c FROM warnings WHERE exam_schedule_id = ? AND tingkat = 2 AND is_correction = 0`).get(sid) as { c: number }).c;
      const p3 = (db.prepare(`SELECT COUNT(*) AS c FROM warnings WHERE exam_schedule_id = ? AND tingkat = 3 AND is_correction = 0`).get(sid) as { c: number }).c;
      const izinKeluar = (db.prepare(`SELECT COUNT(*) AS c FROM exit_permissions WHERE exam_schedule_id = ?`).get(sid) as { c: number }).c;
      const kejadian = (db.prepare(`SELECT COUNT(*) AS c FROM incident_reports WHERE exam_schedule_id = ?`).get(sid) as { c: number }).c;

      return {
        Kegiatan: s.kegiatan,
        Sesi: s.nama_sesi,
        Tanggal: s.tanggal,
        Waktu_WIB: `${s.jam_mulai}-${s.jam_selesai}`,
        Ruang: `${s.kode_ruang} - ${s.nama_ruang}`,
        Mata_Pelajaran: s.mata_pelajaran,
        Peserta_Hadir: hadir,
        Peserta_Tidak_Hadir: tidakHadir,
        Peringatan_1: p1,
        Peringatan_2: p2,
        Peringatan_3: p3,
        Izin_Keluar: izinKeluar,
        Catatan_Kejadian: kejadian,
      };
    });

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
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="Rekap_SIPENGUJI.xlsx"');
    res.send(buf);
  });

  // ========================
  // SUPERVISOR: DASHBOARD & SCHEDULES
  // ========================
  router.get('/supervisor/schedules', requireAuth, (req: AuthedRequest, res) => {
    const user = req.authUser!;
    if (user.role === 'admin') {
      const all = db
        .prepare(
          `SELECT sch.*, ses.exam_id, ses.nama_sesi, ex.nama AS exam_nama, ex.madrasah_nama, ex.tahun_ajaran, ex.warning_minutes_before_end,
                  sub.kode AS subject_kode, sub.nama AS subject_nama,
                  rm.kode AS room_kode, rm.nama AS room_nama, rm.kapasitas AS room_kapasitas
           FROM exam_schedules sch
           JOIN exam_sessions ses ON ses.id = sch.exam_session_id
           JOIN exams ex ON ex.id = ses.exam_id
           JOIN subjects sub ON sub.id = sch.subject_id
           JOIN rooms rm ON rm.id = sch.room_id
           ORDER BY sch.tanggal ASC, sch.jam_mulai ASC`
        )
        .all() as Array<Record<string, unknown>>;
      res.json({ serverTime: getServerWibNow(), schedules: all.map((r) => buildScheduleItem(r)) });
      return;
    }

    if (!user.supervisorId) {
      res.json({ serverTime: getServerWibNow(), schedules: [] });
      return;
    }

    const rows = db
      .prepare(
        `SELECT sch.*, ses.exam_id, ses.nama_sesi, ex.nama AS exam_nama, ex.madrasah_nama, ex.tahun_ajaran, ex.warning_minutes_before_end,
                sub.kode AS subject_kode, sub.nama AS subject_nama,
                rm.kode AS room_kode, rm.nama AS room_nama, rm.kapasitas AS room_kapasitas
         FROM supervision_assignments sa
         JOIN exam_schedules sch ON sch.id = sa.exam_schedule_id
         JOIN exam_sessions ses ON ses.id = sch.exam_session_id
         JOIN exams ex ON ex.id = ses.exam_id
         JOIN subjects sub ON sub.id = sch.subject_id
         JOIN rooms rm ON rm.id = sch.room_id
         WHERE sa.supervisor_id = ?
         ORDER BY sch.tanggal ASC, sch.jam_mulai ASC`
      )
      .all(user.supervisorId) as Array<Record<string, unknown>>;

    res.json({
      serverTime: getServerWibNow(),
      schedules: rows.map((r) => buildScheduleItem(r, user.supervisorId)),
    });
  });

  // ========================
  // MENGAWASI UJIAN (FR-MGU, protected by requireAssignedSchedule)
  // ========================
  router.get('/supervision/:scheduleId', requireAuth, requireAssignedSchedule, (req: AuthedRequest, res) => {
    const scheduleId = Number(req.params.scheduleId);
    const row = db
      .prepare(
        `SELECT sch.*, ses.exam_id, ses.nama_sesi, ex.nama AS exam_nama, ex.madrasah_nama, ex.tahun_ajaran, ex.warning_minutes_before_end,
                sub.kode AS subject_kode, sub.nama AS subject_nama,
                rm.kode AS room_kode, rm.nama AS room_nama, rm.kapasitas AS room_kapasitas,
                rm.rows_count, rm.cols_count, rm.layout_json, rm.denah_lingkungan_json
         FROM exam_schedules sch
         JOIN exam_sessions ses ON ses.id = sch.exam_session_id
         JOIN exams ex ON ex.id = ses.exam_id
         JOIN subjects sub ON sub.id = sch.subject_id
         JOIN rooms rm ON rm.id = sch.room_id
         WHERE sch.id = ?`
      )
      .get(scheduleId) as Record<string, unknown> | undefined;

    if (!row) {
      res.status(404).json({ error: 'Jadwal pengawasan tidak ditemukan.' });
      return;
    }

    const scheduleItem = buildScheduleItem(row, req.authUser?.supervisorId);

    const seatsRaw = db
      .prepare(
        `SELECT s.*, st.exam_id AS st_exam_id, st.nomor_peserta, st.nisn, st.nis, st.nama AS st_nama, st.kelas AS st_kelas
         FROM seats s
         LEFT JOIN students st ON st.id = s.student_id
         WHERE s.room_id = ?
         ORDER BY s.baris ASC, s.kolom ASC`
      )
      .all(row.room_id) as Array<Record<string, unknown>>;

    const attendanceRows = db
      .prepare(`SELECT * FROM attendance WHERE exam_schedule_id = ?`)
      .all(scheduleId) as Array<Record<string, unknown>>;
    const warningsRows = db
      .prepare(`SELECT * FROM warnings WHERE exam_schedule_id = ? ORDER BY id ASC`)
      .all(scheduleId) as Array<Record<string, unknown>>;
    const exitsRows = db
      .prepare(`SELECT * FROM exit_permissions WHERE exam_schedule_id = ? ORDER BY id ASC`)
      .all(scheduleId) as Array<Record<string, unknown>>;
    const incidents = db
      .prepare(`SELECT * FROM incident_reports WHERE exam_schedule_id = ? ORDER BY id DESC`)
      .all(scheduleId);

    const reportsRaw = db
      .prepare(
        `SELECT sr.*, sup.nama_lengkap AS supervisor_nama
         FROM supervision_reports sr
         JOIN supervisors sup ON sup.id = sr.supervisor_id
         WHERE sr.exam_schedule_id = ?`
      )
      .all(scheduleId) as Array<Record<string, unknown>>;

    const verifs = db
      .prepare(
        `SELECT rv.*, u.username AS admin_nama
         FROM report_verifications rv
         JOIN users u ON u.id = rv.admin_id
         WHERE rv.report_id IN (SELECT id FROM supervision_reports WHERE exam_schedule_id = ?)
         ORDER BY rv.id DESC`
      )
      .all(scheduleId) as Array<Record<string, unknown>>;

    const seats = seatsRaw.map((s) => {
      const studentId = s.student_id ? Number(s.student_id) : null;
      const att = studentId ? attendanceRows.find((a) => Number(a.student_id) === studentId) : undefined;
      const wList = studentId
        ? warningsRows.filter((w) => Number(w.student_id) === studentId)
        : [];
      const eList = studentId ? exitsRows.filter((e) => Number(e.student_id) === studentId) : [];
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
      reports: reportsRaw.map((r) => ({
        ...r,
        verifications: verifs.filter((v) => v.report_id === r.id),
      })),
    });
  });

  // Supervisor check-in
  router.post('/supervision/:scheduleId/check-in', requireAuth, requireAssignedSchedule, (req: AuthedRequest, res) => {
    const scheduleId = Number(req.params.scheduleId);
    const user = req.authUser!;
    if (!user.supervisorId) {
      res.status(403).json({ error: 'Hanya pengawas bertugas yang dapat mencatat hadir pengawas.' });
      return;
    }

    const sched = db.prepare(`SELECT * FROM exam_schedules WHERE id = ?`).get(scheduleId) as Record<string, unknown> | undefined;
    if (!sched) {
      res.status(404).json({ error: 'Jadwal tidak ditemukan.' });
      return;
    }
    const status = computeScheduleStatus(String(sched.tanggal), String(sched.jam_mulai), String(sched.jam_selesai), Number(sched.status_manual_cancel));
    if (status !== 'aktif') {
      res.status(403).json({ error: 'Check-in pengawas hanya dapat dilakukan saat jadwal berstatus Aktif (WIB).' });
      return;
    }

    const assign = db
      .prepare(`SELECT id FROM supervision_assignments WHERE exam_schedule_id = ? AND supervisor_id = ?`)
      .get(scheduleId, user.supervisorId) as { id: number } | undefined;
    if (!assign) {
      res.status(403).json({ error: 'Penugasan pengawas tidak ditemukan.' });
      return;
    }

    const now = getServerWibNow().isoWib;
    db.prepare(
      `INSERT INTO supervisor_attendance (assignment_id, waktu_hadir, status) VALUES (?, ?, 'hadir')
       ON CONFLICT(assignment_id) DO UPDATE SET waktu_hadir = excluded.waktu_hadir, status = 'hadir'`
    ).run(assign.id, now);

    db.prepare(`UPDATE exam_schedules SET actual_started_at = COALESCE(actual_started_at, ?) WHERE id = ?`).run(now, scheduleId);

    broadcastToSchedule(scheduleId, { type: 'supervision:updated', scheduleId });
    broadcastToAdmins({ type: 'monitoring:updated', scheduleId });
    res.json({ ok: true, waktu_hadir: now });
  });

  // Attendance mutation with optimistic concurrency conflict detection (BR-10)
  router.post('/supervision/:scheduleId/attendance', requireAuth, requireAssignedSchedule, (req: AuthedRequest, res) => {
    const user = req.authUser!;
    if (user.role !== 'supervisor') {
      res.status(403).json({ error: 'Hanya pengawas bertugas yang dapat mengubah kehadiran peserta.' });
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

    const sched = db.prepare(`SELECT * FROM exam_schedules WHERE id = ?`).get(scheduleId) as Record<string, unknown> | undefined;
    if (!sched) {
      res.status(404).json({ error: 'Jadwal tidak ditemukan.' });
      return;
    }
    const schStatus = computeScheduleStatus(String(sched.tanggal), String(sched.jam_mulai), String(sched.jam_selesai), Number(sched.status_manual_cancel));
    if (schStatus !== 'aktif') {
      res.status(403).json({ error: 'Kehadiran hanya dapat diubah saat ujian berlangsung (Aktif).' });
      return;
    }

    const current = db
      .prepare(`SELECT id, updated_version, status FROM attendance WHERE student_id = ? AND exam_schedule_id = ?`)
      .get(studentId, scheduleId) as { id: number; updated_version: number; status: string } | undefined;

    const currentVer = current?.updated_version ?? 0;
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
      db.prepare(
        `UPDATE attendance SET status = ?, dicatat_oleh = ?, waktu = ?, updated_version = ? WHERE id = ?`
      ).run(status, user.id, now, nextVer, current.id);
    } else {
      db.prepare(
        `INSERT INTO attendance (student_id, exam_schedule_id, status, dicatat_oleh, waktu, updated_version)
         VALUES (?, ?, ?, ?, ?, 1)`
      ).run(studentId, scheduleId, status, user.id, now);
    }

    appendAuditLog({
      userId: user.id,
      username: user.username,
      aksi: 'RECORD_ATTENDANCE',
      entitas: 'attendance',
      entitasId: `${scheduleId}:${studentId}`,
      nilaiLama: current ? { status: current.status } : null,
      nilaiBaru: { status },
      ip: getClientIp(req),
    });

    broadcastToSchedule(scheduleId, {
      type: 'attendance:updated',
      scheduleId,
      studentId,
      status,
      updated_version: nextVer,
      by: user.namaLengkap,
    });
    broadcastToAdmins({ type: 'monitoring:updated', scheduleId });

    res.json({ ok: true, updated_version: nextVer, waktu: now });
  });

  // Warnings (FR-MGU-C, BR-05, BR-06, BR-10, BR-12)
  router.post('/supervision/:scheduleId/warnings', requireAuth, requireAssignedSchedule, (req: AuthedRequest, res) => {
    const user = req.authUser!;
    if (user.role !== 'supervisor') {
      res.status(403).json({ error: 'Hanya pengawas bertugas yang dapat mencatat peringatan.' });
      return;
    }
    const scheduleId = Number(req.params.scheduleId);
    const { studentId, tingkat, alasan, isCorrection, correctsWarningId, idempotencyKey } = req.body as {
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

    // Idempotency check
    if (idempotencyKey) {
      const existing = db.prepare(`SELECT * FROM warnings WHERE idempotency_key = ?`).get(idempotencyKey);
      if (existing) {
        res.json({ ok: true, warning: existing, deduplicated: true });
        return;
      }
    }

    const sched = db
      .prepare(
        `SELECT es.*, rm.kode AS room_kode, sub.nama AS subject_nama
         FROM exam_schedules es
         JOIN rooms rm ON rm.id = es.room_id
         JOIN subjects sub ON sub.id = es.subject_id
         WHERE es.id = ?`
      )
      .get(scheduleId) as Record<string, unknown> | undefined;
    if (!sched) {
      res.status(404).json({ error: 'Jadwal tidak ditemukan.' });
      return;
    }

    const schStatus = computeScheduleStatus(String(sched.tanggal), String(sched.jam_mulai), String(sched.jam_selesai), Number(sched.status_manual_cancel));
    if (schStatus !== 'aktif') {
      res.status(403).json({ error: 'Peringatan hanya dapat dicatat saat jadwal berstatus Aktif.' });
      return;
    }

    const student = db.prepare(`SELECT nama, nomor_peserta FROM students WHERE id = ?`).get(studentId) as
      | { nama: string; nomor_peserta: string }
      | undefined;

    const now = getServerWibNow().isoWib;
    const info = db
      .prepare(
        `INSERT INTO warnings (student_id, exam_schedule_id, tingkat, alasan, is_correction, corrects_warning_id, dicatat_oleh, dicatat_oleh_nama, waktu_server, idempotency_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        studentId,
        scheduleId,
        tingkat,
        alasan.trim(),
        isCorrection ? 1 : 0,
        correctsWarningId ?? null,
        user.id,
        user.namaLengkap,
        now,
        idempotencyKey ?? null
      );
    const warningId = Number(info.lastInsertRowid);
    const created = db.prepare(`SELECT * FROM warnings WHERE id = ?`).get(warningId);

    appendAuditLog({
      userId: user.id,
      username: user.username,
      aksi: isCorrection ? 'CORRECTION_WARNING' : `ISSUE_WARNING_LEVEL_${tingkat}`,
      entitas: 'warnings',
      entitasId: warningId,
      nilaiBaru: { studentId, tingkat, alasan: alasan.trim(), correctsWarningId },
      ip: getClientIp(req),
    });

    // BR-06: Warning Level 3 automatically notifies Admin panitia (system does NOT expel student)
    if (tingkat === 3 && !isCorrection) {
      notifyAllAdmins({
        judul: `Laporan Peringatan 3 — Ruang ${sched.room_kode}`,
        isi: `Peserta ${student?.nama || studentId} (${student?.nomor_peserta || '-'}) menerima Peringatan Tingkat 3 pada ${sched.subject_nama}. Alasan: "${alasan.trim()}". Tindak lanjut berada di tangan Panitia.`,
        kategori: 'peringatan_3',
        linkTarget: `admin:monitoring:${scheduleId}`,
      });
      broadcastToAdmins({
        type: 'warning:level3',
        scheduleId,
        studentId,
        warning: created,
      });
    }

    broadcastToSchedule(scheduleId, {
      type: 'warning:created',
      scheduleId,
      studentId,
      warning: created,
    });
    broadcastToAdmins({ type: 'monitoring:updated', scheduleId });

    res.status(201).json({ ok: true, warning: created });
  });

  // Exit permissions (FR-MGU-D, BR-14)
  router.post('/supervision/:scheduleId/exits', requireAuth, requireAssignedSchedule, (req: AuthedRequest, res) => {
    const user = req.authUser!;
    if (user.role !== 'supervisor') {
      res.status(403).json({ error: 'Hanya pengawas bertugas yang dapat mencatat izin keluar.' });
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

    const sched = db.prepare(`SELECT * FROM exam_schedules WHERE id = ?`).get(scheduleId) as Record<string, unknown> | undefined;
    if (!sched) {
      res.status(404).json({ error: 'Jadwal tidak ditemukan.' });
      return;
    }
    const schStatus = computeScheduleStatus(String(sched.tanggal), String(sched.jam_mulai), String(sched.jam_selesai), Number(sched.status_manual_cancel));
    if (schStatus !== 'aktif') {
      res.status(403).json({ error: 'Izin keluar hanya dapat dicatat saat ujian berlangsung.' });
      return;
    }

    const now = getServerWibNow().isoWib;

    if (action === 'keluar') {
      if (!studentId || !alasan || alasan.trim() === '') {
        res.status(400).json({ error: 'Peserta dan alasan izin keluar wajib diisi.' });
        return;
      }
      if (idempotencyKey) {
        const existing = db.prepare(`SELECT * FROM exit_permissions WHERE idempotency_key = ?`).get(idempotencyKey);
        if (existing) {
          res.json({ ok: true, exit: existing, deduplicated: true });
          return;
        }
      }
      // BR-14: One student cannot have two active exit permissions simultaneously
      const active = db
        .prepare(
          `SELECT id FROM exit_permissions WHERE student_id = ? AND exam_schedule_id = ? AND waktu_kembali IS NULL`
        )
        .get(studentId, scheduleId);
      if (active) {
        res.status(409).json({
          error: 'Peserta ini sudah memiliki izin keluar aktif (BR-14). Catat KEMBALI terlebih dahulu.',
        });
        return;
      }

      const info = db
        .prepare(
          `INSERT INTO exit_permissions (student_id, exam_schedule_id, alasan, waktu_keluar, dicatat_oleh, dicatat_oleh_nama, idempotency_key)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(studentId, scheduleId, alasan.trim(), now, user.id, user.namaLengkap, idempotencyKey ?? null);
      const created = db.prepare(`SELECT * FROM exit_permissions WHERE id = ?`).get(info.lastInsertRowid);

      appendAuditLog({
        userId: user.id,
        username: user.username,
        aksi: 'EXIT_PERMISSION_START',
        entitas: 'exit_permissions',
        entitasId: Number(info.lastInsertRowid),
        nilaiBaru: { studentId, alasan: alasan.trim(), waktu_keluar: now },
        ip: getClientIp(req),
      });

      broadcastToSchedule(scheduleId, { type: 'exit:updated', scheduleId, studentId, exit: created });
      broadcastToAdmins({ type: 'monitoring:updated', scheduleId });
      res.status(201).json({ ok: true, exit: created });
      return;
    }

    if (action === 'kembali') {
      const target = exitId
        ? (db.prepare(`SELECT * FROM exit_permissions WHERE id = ? AND exam_schedule_id = ?`).get(exitId, scheduleId) as
            | { id: number; student_id: number; waktu_keluar: string; waktu_kembali: string | null }
            | undefined)
        : (db
            .prepare(
              `SELECT * FROM exit_permissions WHERE student_id = ? AND exam_schedule_id = ? AND waktu_kembali IS NULL ORDER BY id DESC LIMIT 1`
            )
            .get(studentId, scheduleId) as
            | { id: number; student_id: number; waktu_keluar: string; waktu_kembali: string | null }
            | undefined);

      if (!target) {
        res.status(404).json({ error: 'Izin keluar aktif tidak ditemukan.' });
        return;
      }
      if (target.waktu_kembali) {
        res.status(409).json({ error: 'Peserta sudah tercatat kembali sebelumnya.' });
        return;
      }

      const durasiDetik = computeDurationSeconds(target.waktu_keluar, now);
      db.prepare(`UPDATE exit_permissions SET waktu_kembali = ?, durasi_detik = ? WHERE id = ?`).run(
        now,
        durasiDetik,
        target.id
      );
      const updated = db.prepare(`SELECT * FROM exit_permissions WHERE id = ?`).get(target.id);

      appendAuditLog({
        userId: user.id,
        username: user.username,
        aksi: 'EXIT_PERMISSION_RETURN',
        entitas: 'exit_permissions',
        entitasId: target.id,
        nilaiBaru: { waktu_kembali: now, durasi_detik: durasiDetik },
        ip: getClientIp(req),
      });

      broadcastToSchedule(scheduleId, {
        type: 'exit:updated',
        scheduleId,
        studentId: target.student_id,
        exit: updated,
      });
      broadcastToAdmins({ type: 'monitoring:updated', scheduleId });
      res.json({ ok: true, exit: updated });
      return;
    }

    res.status(400).json({ error: 'Aksi izin keluar harus "keluar" atau "kembali".' });
  });

  // Incident reports
  router.post('/supervision/:scheduleId/incidents', requireAuth, requireAssignedSchedule, (req: AuthedRequest, res) => {
    const user = req.authUser!;
    if (user.role !== 'supervisor') {
      res.status(403).json({ error: 'Hanya pengawas bertugas yang dapat mencatat kejadian.' });
      return;
    }
    const scheduleId = Number(req.params.scheduleId);
    const { deskripsi } = req.body as { deskripsi?: string };
    if (!deskripsi || deskripsi.trim() === '') {
      res.status(400).json({ error: 'Deskripsi kejadian wajib diisi.' });
      return;
    }
    const now = getServerWibNow().isoWib;
    const info = db
      .prepare(
        `INSERT INTO incident_reports (exam_schedule_id, deskripsi, waktu, dicatat_oleh, dicatat_oleh_nama)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(scheduleId, deskripsi.trim(), now, user.id, user.namaLengkap);
    const created = db.prepare(`SELECT * FROM incident_reports WHERE id = ?`).get(info.lastInsertRowid);

    appendAuditLog({
      userId: user.id,
      username: user.username,
      aksi: 'CREATE_INCIDENT_REPORT',
      entitas: 'incident_reports',
      entitasId: Number(info.lastInsertRowid),
      nilaiBaru: { scheduleId, deskripsi: deskripsi.trim() },
      ip: getClientIp(req),
    });

    broadcastToSchedule(scheduleId, { type: 'incident:created', scheduleId, incident: created });
    broadcastToAdmins({ type: 'monitoring:updated', scheduleId });
    res.status(201).json({ ok: true, incident: created });
  });

  // ========================
  // UPLOAD BERKAS & PENYELESAIAN (FR-UPL & FR-SLS)
  // ========================
  router.post(
    '/supervision/:scheduleId/reports/berita-acara',
    requireAuth,
    requireAssignedSchedule,
    (req: AuthedRequest, res) => {
      const user = req.authUser!;
      if (user.role !== 'supervisor' || !user.supervisorId) {
        res.status(403).json({ error: 'Hanya pengawas bertugas yang dapat mengirim berita acara.' });
        return;
      }
      const scheduleId = Number(req.params.scheduleId);
      const { kondisi_pelaksanaan, catatan_tambahan, ttd_url } = req.body as {
        kondisi_pelaksanaan?: string;
        catatan_tambahan?: string;
        ttd_url?: string;
      };

      const existing = db
        .prepare(`SELECT * FROM supervision_reports WHERE exam_schedule_id = ? AND jenis = 'berita_acara'`)
        .get(scheduleId) as { id: number; status: string; version: number } | undefined;

      // BR-16: Verified report cannot be modified by supervisor
      if (existing && existing.status === 'terverifikasi') {
        res.status(403).json({
          error: 'Berita acara sudah Terverifikasi dan tidak dapat diubah pengawas (BR-16).',
        });
        return;
      }

      // Check supervisor signature (Section 11.5: empty signature cannot submit)
      const sup = db.prepare(`SELECT ttd_url, nama_lengkap FROM supervisors WHERE id = ?`).get(user.supervisorId) as {
        ttd_url: string | null;
        nama_lengkap: string;
      };
      const effectiveTtd = ttd_url || sup.ttd_url;
      if (!effectiveTtd) {
        res.status(400).json({ error: 'Tanda tangan digital kosong. Lengkapi tanda tangan sebelum mengirim.' });
        return;
      }

      // BR-15: Verify all seated students in room have attendance marked (no 'belum')
      const sched = db.prepare(`SELECT room_id FROM exam_schedules WHERE id = ?`).get(scheduleId) as { room_id: number };
      const seatedStudents = db
        .prepare(`SELECT student_id FROM seats WHERE room_id = ? AND student_id IS NOT NULL`)
        .all(sched.room_id) as Array<{ student_id: number }>;
      const attendance = db
        .prepare(`SELECT student_id, status FROM attendance WHERE exam_schedule_id = ?`)
        .all(scheduleId) as Array<{ student_id: number; status: string }>;

      const unmarkedCount = seatedStudents.filter((st) => {
        const a = attendance.find((x) => x.student_id === st.student_id);
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
      const incidents = db
        .prepare(`SELECT deskripsi, waktu, dicatat_oleh_nama FROM incident_reports WHERE exam_schedule_id = ?`)
        .all(scheduleId);

      const dataJson = JSON.stringify({
        jumlah_terdaftar: jumlahTerdaftar,
        jumlah_hadir: jumlahHadir,
        jumlah_tidak_hadir: jumlahTidakHadir,
        kondisi_pelaksanaan: kondisi_pelaksanaan || 'Lancar dan Tertib',
        catatan_tambahan: catatan_tambahan || '',
        kejadian: incidents,
        nama_pengawas: sup.nama_lengkap,
        ttd_url: effectiveTtd,
      });

      const now = getServerWibNow().isoWib;
      if (existing) {
        db.prepare(
          `UPDATE supervision_reports SET supervisor_id = ?, data_json = ?, status = 'menunggu_verifikasi', dikirim_pada = ?, version = version + 1 WHERE id = ?`
        ).run(user.supervisorId, dataJson, now, existing.id);
      } else {
        db.prepare(
          `INSERT INTO supervision_reports (exam_schedule_id, supervisor_id, jenis, data_json, status, dikirim_pada, version)
           VALUES (?, ?, 'berita_acara', ?, 'menunggu_verifikasi', ?, 1)`
        ).run(scheduleId, user.supervisorId, dataJson, now);
      }

      notifyAllAdmins({
        judul: 'Berita Acara Masuk Menunggu Verifikasi',
        isi: `${sup.nama_lengkap} mengirim Berita Acara untuk Jadwal #${scheduleId} (${jumlahHadir}/${jumlahTerdaftar} hadir).`,
        kategori: 'laporan',
        linkTarget: 'admin:reports',
      });
      broadcastToAdmins({ type: 'monitoring:updated', scheduleId });
      broadcastToSchedule(scheduleId, { type: 'report:updated', scheduleId });

      appendAuditLog({
        userId: user.id,
        username: user.username,
        aksi: 'SUBMIT_BERITA_ACARA',
        entitas: 'supervision_reports',
        entitasId: scheduleId,
        nilaiBaru: { jumlahTerdaftar, jumlahHadir, jumlahTidakHadir },
        ip: getClientIp(req),
      });

      res.json({ ok: true });
    }
  );

  router.post(
    '/supervision/:scheduleId/reports/daftar-hadir',
    requireAuth,
    requireAssignedSchedule,
    upload.single('file'),
    (req: AuthedRequest, res) => {
      const user = req.authUser!;
      if (user.role !== 'supervisor' || !user.supervisorId) {
        res.status(403).json({ error: 'Hanya pengawas bertugas yang dapat mengunggah daftar hadir.' });
        return;
      }
      if (!req.file) {
        res.status(400).json({ error: 'Berkas foto/scan daftar hadir wajib dipilih.' });
        return;
      }
      const scheduleId = Number(req.params.scheduleId);
      const existing = db
        .prepare(`SELECT * FROM supervision_reports WHERE exam_schedule_id = ? AND jenis = 'daftar_hadir'`)
        .get(scheduleId) as { id: number; status: string } | undefined;

      if (existing && existing.status === 'terverifikasi') {
        res.status(403).json({ error: 'Daftar hadir sudah Terverifikasi dan tidak dapat diubah pengawas (BR-16).' });
        return;
      }

      const now = getServerWibNow().isoWib;
      const sha256 = crypto.createHash('sha256').update(fs.readFileSync(req.file.path)).digest('hex');

      const docInfo = db
        .prepare(
          `INSERT INTO documents (jenis, nama_file, path, sha256, uploaded_by, version, status_verifikasi, created_at)
           VALUES ('daftar_hadir_scan', ?, ?, ?, ?, 1, 'menunggu_verifikasi', ?)`
        )
        .run(req.file.originalname, req.file.path, sha256, user.id, now);
      const docId = Number(docInfo.lastInsertRowid);
      const fileRef = `/api/files/${docId}`;

      const dataJson = JSON.stringify({
        nama_file: req.file.originalname,
        sha256,
        catatan: req.body.catatan || '',
      });

      if (existing) {
        db.prepare(
          `UPDATE supervision_reports SET supervisor_id = ?, file_path = ?, data_json = ?, status = 'menunggu_verifikasi', dikirim_pada = ?, version = version + 1 WHERE id = ?`
        ).run(user.supervisorId, fileRef, dataJson, now, existing.id);
      } else {
        db.prepare(
          `INSERT INTO supervision_reports (exam_schedule_id, supervisor_id, jenis, data_json, file_path, status, dikirim_pada, version)
           VALUES (?, ?, 'daftar_hadir', ?, ?, 'menunggu_verifikasi', ?, 1)`
        ).run(scheduleId, user.supervisorId, dataJson, fileRef, now);
      }

      notifyAllAdmins({
        judul: 'Daftar Hadir Diunggah Menunggu Verifikasi',
        isi: `${user.namaLengkap} mengunggah berkas Daftar Hadir (${req.file.originalname}) untuk Jadwal #${scheduleId}.`,
        kategori: 'laporan',
        linkTarget: 'admin:reports',
      });
      broadcastToAdmins({ type: 'monitoring:updated', scheduleId });
      broadcastToSchedule(scheduleId, { type: 'report:updated', scheduleId });

      appendAuditLog({
        userId: user.id,
        username: user.username,
        aksi: 'UPLOAD_DAFTAR_HADIR',
        entitas: 'supervision_reports',
        entitasId: scheduleId,
        nilaiBaru: { filename: req.file.originalname, sha256 },
        ip: getClientIp(req),
      });

      res.json({ ok: true, file_path: fileRef });
    }
  );

  // Authenticated private file download (FR-18.4, path-traversal safe)
  router.get('/files/:docId', requireAuth, (req: AuthedRequest, res) => {
    const docId = Number(req.params.docId);
    const doc = db.prepare(`SELECT * FROM documents WHERE id = ?`).get(docId) as
      | { id: number; nama_file: string; path: string; uploaded_by: number | null }
      | undefined;
    if (!doc) {
      res.status(404).json({ error: 'Berkas tidak ditemukan.' });
      return;
    }
    const user = req.authUser!;
    if (user.role !== 'admin' && doc.uploaded_by !== user.id) {
      res.status(403).json({ error: 'Anda tidak memiliki izin mengakses berkas ini.' });
      return;
    }
    const resolved = path.resolve(doc.path);
    if (!resolved.startsWith(UPLOADS_DIR + path.sep) || !fs.existsSync(resolved)) {
      res.status(404).json({ error: 'Berkas fisik tidak ditemukan.' });
      return;
    }
    res.sendFile(resolved);
  });

  // Dataset for rendering and downloading the 11 administrative documents
  router.get('/admin/documents/dataset', requireAuth, requireAdmin, (_req, res) => {
    const exam = db.prepare(`SELECT * FROM exams ORDER BY id DESC LIMIT 1`).get() as Record<string, unknown> | undefined;
    const rooms = db.prepare(`SELECT * FROM rooms ORDER BY kode ASC`).all() as Array<Record<string, unknown>>;
    const seats = db
      .prepare(
        `SELECT s.*, st.nomor_peserta, st.nisn, st.nis, st.nama AS student_nama, st.kelas
         FROM seats s LEFT JOIN students st ON st.id = s.student_id
         ORDER BY s.baris ASC, s.kolom ASC`
      )
      .all() as Array<Record<string, unknown>>;
    const supervisors = db.prepare(`SELECT * FROM supervisors ORDER BY nama_lengkap ASC`).all();
    const schedulesRaw = db
      .prepare(
        `SELECT sch.*, ses.exam_id, ses.nama_sesi, ex.nama AS exam_nama, ex.madrasah_nama, ex.tahun_ajaran, ex.warning_minutes_before_end,
                sub.kode AS subject_kode, sub.nama AS subject_nama,
                rm.kode AS room_kode, rm.nama AS room_nama, rm.kapasitas AS room_kapasitas
         FROM exam_schedules sch
         JOIN exam_sessions ses ON ses.id = sch.exam_session_id
         JOIN exams ex ON ex.id = ses.exam_id
         JOIN subjects sub ON sub.id = sch.subject_id
         JOIN rooms rm ON rm.id = sch.room_id
         ORDER BY sch.tanggal ASC, sch.jam_mulai ASC`
      )
      .all() as Array<Record<string, unknown>>;
    const incidents = db.prepare(`SELECT * FROM incident_reports ORDER BY id DESC`).all();
    const warnings = db
      .prepare(
        `SELECT w.*, st.nama AS student_nama, st.nomor_peserta
         FROM warnings w JOIN students st ON st.id = w.student_id ORDER BY w.id DESC`
      )
      .all();

    res.json({
      serverTime: getServerWibNow(),
      exam: exam || null,
      rooms: rooms.map((r) => ({ ...r, seats: seats.filter((s) => s.room_id === r.id) })),
      supervisors,
      schedules: schedulesRaw.map((r) => buildScheduleItem(r)),
      incidents,
      warnings,
    });
  });

  return router;
}
