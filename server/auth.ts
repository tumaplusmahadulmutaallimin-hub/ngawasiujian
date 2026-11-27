import crypto from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import { execute, queryOne } from './db.ts';
import type { AuthUser } from '../src/types.ts';

let cachedTokenSecret: string | null = null;

export async function getTokenSecret(): Promise<string> {
  if (process.env.SESSION_SECRET && process.env.SESSION_SECRET.trim() !== '') {
    return process.env.SESSION_SECRET.trim();
  }
  if (cachedTokenSecret) return cachedTokenSecret;

  const existing = await queryOne<{ value: string }>(
    `SELECT value FROM app_config WHERE key = 'session_secret'`
  );
  if (existing?.value) {
    cachedTokenSecret = existing.value;
    return existing.value;
  }

  const generated = crypto.randomBytes(32).toString('hex');
  await execute(
    `INSERT INTO app_config (key, value) VALUES ('session_secret', $1) ON CONFLICT (key) DO NOTHING`,
    [generated]
  );
  const saved = await queryOne<{ value: string }>(
    `SELECT value FROM app_config WHERE key = 'session_secret'`
  );
  cachedTokenSecret = saved?.value || generated;
  return cachedTokenSecret;
}

const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes idle lock (FR-AUT-07 / OD-03)
const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_MS = 5 * 60 * 1000;

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  const parts = storedHash.split(':');
  if (parts.length !== 2) return false;
  const [salt, keyHex] = parts;
  if (!salt || !keyHex) return false;
  const derived = crypto.scryptSync(password, salt, 64);
  const storedBuf = Buffer.from(keyHex, 'hex');
  if (derived.length !== storedBuf.length) return false;
  return crypto.timingSafeEqual(derived, storedBuf);
}

export async function checkRateLimit(key: string): Promise<{ allowed: boolean; retryAfterSec: number }> {
  const entry = await queryOne<{ attempts: number; locked_until_ms: string | number }>(
    `SELECT attempts, locked_until_ms FROM rate_limits WHERE rate_key = $1`,
    [key]
  );
  if (!entry) return { allowed: true, retryAfterSec: 0 };
  const now = Date.now();
  const lockedUntil = Number(entry.locked_until_ms || 0);
  if (lockedUntil > now) {
    return { allowed: false, retryAfterSec: Math.ceil((lockedUntil - now) / 1000) };
  }
  if (lockedUntil > 0 && lockedUntil <= now) {
    await execute(`DELETE FROM rate_limits WHERE rate_key = $1`, [key]);
  }
  return { allowed: true, retryAfterSec: 0 };
}

export async function recordFailedAttempt(key: string): Promise<void> {
  const now = Date.now();
  const prev = await queryOne<{ attempts: number }>(
    `SELECT attempts FROM rate_limits WHERE rate_key = $1`,
    [key]
  );
  const nextCount = Number(prev?.attempts || 0) + 1;
  const lockedUntil = nextCount >= MAX_LOGIN_ATTEMPTS ? now + LOCKOUT_MS : 0;
  await execute(
    `INSERT INTO rate_limits (rate_key, attempts, locked_until_ms)
     VALUES ($1, $2, $3)
     ON CONFLICT (rate_key) DO UPDATE SET attempts = EXCLUDED.attempts, locked_until_ms = EXCLUDED.locked_until_ms`,
    [key, nextCount, lockedUntil]
  );
}

export async function clearFailedAttempts(key: string): Promise<void> {
  await execute(`DELETE FROM rate_limits WHERE rate_key = $1`, [key]);
}

export async function createSessionToken(userId: number): Promise<string> {
  const secret = await getTokenSecret();
  const sessionId = crypto.randomBytes(24).toString('hex');
  const payloadB64 = Buffer.from(JSON.stringify({ sid: sessionId, uid: userId })).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(payloadB64).digest('base64url');
  await execute(`INSERT INTO sessions (id, user_id, last_active_ms) VALUES ($1, $2, $3)`, [
    sessionId,
    userId,
    Date.now(),
  ]);
  return `${payloadB64}.${sig}`;
}

export async function revokeSessionToken(token: string): Promise<void> {
  const sid = await extractSessionId(token);
  if (sid) {
    await execute(`DELETE FROM sessions WHERE id = $1`, [sid]);
  }
}

async function extractSessionId(token: string): Promise<string | null> {
  const secret = await getTokenSecret();
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payloadB64, sig] = parts;
  const expectedSig = crypto.createHmac('sha256', secret).update(payloadB64).digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return null;
  }
  try {
    const parsed = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as {
      sid?: string;
      uid?: number;
    };
    return parsed.sid ?? null;
  } catch {
    return null;
  }
}

export async function authenticateToken(token: string): Promise<AuthUser | null> {
  const sid = await extractSessionId(token);
  if (!sid) return null;

  const session = await queryOne<{ user_id: number; last_active_ms: string | number }>(
    `SELECT user_id, last_active_ms FROM sessions WHERE id = $1`,
    [sid]
  );
  if (!session) return null;

  const now = Date.now();
  if (now - Number(session.last_active_ms) > IDLE_TIMEOUT_MS) {
    await execute(`DELETE FROM sessions WHERE id = $1`, [sid]);
    return null;
  }
  await execute(`UPDATE sessions SET last_active_ms = $1 WHERE id = $2`, [now, sid]);

  const user = await queryOne<{
    id: number;
    username: string;
    role: 'admin' | 'supervisor';
    status: 'active' | 'inactive';
    must_change_password: number;
    supervisor_id: number | null;
    nama_lengkap: string | null;
    nip_nuptk: string | null;
    foto_url: string | null;
    ttd_url: string | null;
    supervisor_status: 'active' | 'inactive' | null;
  }>(
    `SELECT u.id, u.username, u.role, u.status, u.must_change_password,
            s.id AS supervisor_id, s.nama_lengkap, s.nip_nuptk, s.foto_url, s.ttd_url, s.status AS supervisor_status
     FROM users u
     LEFT JOIN supervisors s ON s.user_id = u.id
     WHERE u.id = $1`,
    [session.user_id]
  );

  if (!user || user.status !== 'active') return null;
  if (user.role === 'supervisor' && user.supervisor_status === 'inactive') return null;

  return {
    id: Number(user.id),
    username: user.username,
    role: user.role,
    status: user.status,
    supervisorId: user.supervisor_id ? Number(user.supervisor_id) : null,
    namaLengkap: user.nama_lengkap ?? (user.role === 'admin' ? 'Panitia Ujian (Admin)' : user.username),
    nipNuptk: user.nip_nuptk,
    fotoUrl: user.foto_url,
    ttdUrl: user.ttd_url,
    mustChangePassword: Boolean(user.must_change_password),
  };
}

export interface AuthedRequest extends Request {
  authUser?: AuthUser;
  authToken?: string;
}

export async function requireAuth(req: AuthedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const header = req.headers.authorization;
    const queryToken = typeof req.query.token === 'string' ? req.query.token : undefined;
    const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : queryToken;

    if (!token) {
      res.status(401).json({ error: 'Sesi tidak ditemukan. Silakan masuk kembali.' });
      return;
    }
    const user = await authenticateToken(token);
    if (!user) {
      res.status(401).json({ error: 'Sesi berakhir atau tidak valid. Silakan masuk kembali.' });
      return;
    }
    req.authUser = user;
    req.authToken = token;
    next();
  } catch (err) {
    next(err);
  }
}

export function requireAdmin(req: AuthedRequest, res: Response, next: NextFunction): void {
  if (!req.authUser || req.authUser.role !== 'admin') {
    res.status(403).json({ error: 'Akses ditolak. Fitur ini khusus Admin / Panitia Ujian.' });
    return;
  }
  next();
}

export async function requireAssignedSchedule(
  req: AuthedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const user = req.authUser;
    if (!user) {
      res.status(401).json({ error: 'Tidak terautentikasi.' });
      return;
    }
    const scheduleId = Number(req.params.scheduleId);
    if (!Number.isInteger(scheduleId) || scheduleId <= 0) {
      res.status(400).json({ error: 'ID jadwal tidak valid.' });
      return;
    }

    if (user.role === 'admin') {
      next();
      return;
    }

    if (!user.supervisorId) {
      res.status(403).json({ error: 'Profil pengawas belum terhubung.' });
      return;
    }

    const assignment = await queryOne<{ id: number }>(
      `SELECT sa.id
       FROM supervision_assignments sa
       JOIN supervisors s ON s.id = sa.supervisor_id
       WHERE sa.exam_schedule_id = $1 AND sa.supervisor_id = $2 AND s.status = 'active'`,
      [scheduleId, user.supervisorId]
    );

    if (!assignment) {
      res.status(403).json({
        error: 'Akses ditolak (BR-03): Anda tidak ditugaskan pada ruang dan sesi ujian ini.',
      });
      return;
    }

    next();
  } catch (err) {
    next(err);
  }
}
