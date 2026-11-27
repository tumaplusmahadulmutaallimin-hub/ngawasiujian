import crypto from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import { db } from './db.ts';
import type { AuthUser } from '../src/types.ts';

// Ephemeral fallback signing key when SESSION_SECRET is unset (never stored in .env.example)
const TOKEN_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes idle lock (FR-AUT-07 / OD-03)
const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_MS = 5 * 60 * 1000;

interface SessionEntry {
  userId: number;
  lastActiveMs: number;
}

const activeSessions = new Map<string, SessionEntry>();
const failedAttempts = new Map<string, { count: number; lockedUntilMs: number }>();

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

export function checkRateLimit(key: string): { allowed: boolean; retryAfterSec: number } {
  const entry = failedAttempts.get(key);
  if (!entry) return { allowed: true, retryAfterSec: 0 };
  const now = Date.now();
  if (entry.lockedUntilMs > now) {
    return { allowed: false, retryAfterSec: Math.ceil((entry.lockedUntilMs - now) / 1000) };
  }
  if (entry.lockedUntilMs > 0 && entry.lockedUntilMs <= now) {
    failedAttempts.delete(key);
  }
  return { allowed: true, retryAfterSec: 0 };
}

export function recordFailedAttempt(key: string): void {
  const now = Date.now();
  const prev = failedAttempts.get(key) ?? { count: 0, lockedUntilMs: 0 };
  const nextCount = prev.count + 1;
  failedAttempts.set(key, {
    count: nextCount,
    lockedUntilMs: nextCount >= MAX_LOGIN_ATTEMPTS ? now + LOCKOUT_MS : 0,
  });
}

export function clearFailedAttempts(key: string): void {
  failedAttempts.delete(key);
}

export function createSessionToken(userId: number): string {
  const sessionId = crypto.randomBytes(24).toString('hex');
  const payloadB64 = Buffer.from(JSON.stringify({ sid: sessionId, uid: userId })).toString('base64url');
  const sig = crypto.createHmac('sha256', TOKEN_SECRET).update(payloadB64).digest('base64url');
  activeSessions.set(sessionId, { userId, lastActiveMs: Date.now() });
  return `${payloadB64}.${sig}`;
}

export function revokeSessionToken(token: string): void {
  const sid = extractSessionId(token);
  if (sid) activeSessions.delete(sid);
}

function extractSessionId(token: string): string | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payloadB64, sig] = parts;
  const expectedSig = crypto.createHmac('sha256', TOKEN_SECRET).update(payloadB64).digest('base64url');
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

export function authenticateToken(token: string): AuthUser | null {
  const sid = extractSessionId(token);
  if (!sid) return null;
  const session = activeSessions.get(sid);
  if (!session) return null;

  const now = Date.now();
  if (now - session.lastActiveMs > IDLE_TIMEOUT_MS) {
    activeSessions.delete(sid);
    return null;
  }
  session.lastActiveMs = now;

  const user = db
    .prepare(
      `SELECT u.id, u.username, u.role, u.status,
              s.id AS supervisor_id, s.nama_lengkap, s.nip_nuptk, s.foto_url, s.ttd_url, s.status AS supervisor_status
       FROM users u
       LEFT JOIN supervisors s ON s.user_id = u.id
       WHERE u.id = ?`
    )
    .get(session.userId) as
    | {
        id: number;
        username: string;
        role: 'admin' | 'supervisor';
        status: 'active' | 'inactive';
        supervisor_id: number | null;
        nama_lengkap: string | null;
        nip_nuptk: string | null;
        foto_url: string | null;
        ttd_url: string | null;
        supervisor_status: 'active' | 'inactive' | null;
      }
    | undefined;

  if (!user || user.status !== 'active') return null;
  if (user.role === 'supervisor' && user.supervisor_status === 'inactive') return null;

  return {
    id: user.id,
    username: user.username,
    role: user.role,
    status: user.status,
    supervisorId: user.supervisor_id ?? null,
    namaLengkap: user.nama_lengkap ?? (user.role === 'admin' ? 'Panitia Ujian (Admin)' : user.username),
    nipNuptk: user.nip_nuptk,
    fotoUrl: user.foto_url,
    ttdUrl: user.ttd_url,
  };
}

export interface AuthedRequest extends Request {
  authUser?: AuthUser;
  authToken?: string;
}

export function requireAuth(req: AuthedRequest, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  const queryToken = typeof req.query.token === 'string' ? req.query.token : undefined;
  const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : queryToken;

  if (!token) {
    res.status(401).json({ error: 'Sesi tidak ditemukan. Silakan masuk kembali.' });
    return;
  }
  const user = authenticateToken(token);
  if (!user) {
    res.status(401).json({ error: 'Sesi berakhir atau tidak valid. Silakan masuk kembali.' });
    return;
  }
  req.authUser = user;
  req.authToken = token;
  next();
}

export function requireAdmin(req: AuthedRequest, res: Response, next: NextFunction): void {
  if (!req.authUser || req.authUser.role !== 'admin') {
    res.status(403).json({ error: 'Akses ditolak. Fitur ini khusus Admin / Panitia Ujian.' });
    return;
  }
  next();
}

/**
 * BR-03 & AC-JDW-03: Server-side check verifying supervisor assignment to the requested schedule/room.
 * Admins are allowed read-only monitoring access.
 */
export function requireAssignedSchedule(req: AuthedRequest, res: Response, next: NextFunction): void {
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

  const assignment = db
    .prepare(
      `SELECT sa.id
       FROM supervision_assignments sa
       JOIN supervisors s ON s.id = sa.supervisor_id
       WHERE sa.exam_schedule_id = ? AND sa.supervisor_id = ? AND s.status = 'active'`
    )
    .get(scheduleId, user.supervisorId) as { id: number } | undefined;

  if (!assignment) {
    res.status(403).json({
      error: 'Akses ditolak (BR-03): Anda tidak ditugaskan pada ruang dan sesi ujian ini.',
    });
    return;
  }

  next();
}
