import type { Server as HttpServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { authenticateToken } from './auth.ts';
import { db } from './db.ts';
import type { AuthUser } from '../src/types.ts';

interface ClientMeta {
  ws: WebSocket;
  user: AuthUser;
  scheduleRooms: Set<number>;
  isAdminMonitor: boolean;
}

const clients = new Set<ClientMeta>();

export function setupWebSocketServer(httpServer: HttpServer): void {
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url || '/ws', 'http://localhost');
    const token = url.searchParams.get('token') || '';
    const user = authenticateToken(token);

    if (!user) {
      ws.close(4001, 'Unauthorized');
      return;
    }

    const meta: ClientMeta = {
      ws,
      user,
      scheduleRooms: new Set<number>(),
      isAdminMonitor: user.role === 'admin',
    };
    clients.add(meta);

    ws.send(JSON.stringify({ type: 'connected', userId: user.id, role: user.role }));

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as { type?: string; scheduleId?: number };
        if (msg.type === 'join:schedule' && typeof msg.scheduleId === 'number') {
          if (user.role === 'admin') {
            meta.scheduleRooms.add(msg.scheduleId);
          } else if (user.supervisorId) {
            const assigned = db
              .prepare(
                `SELECT id FROM supervision_assignments WHERE exam_schedule_id = ? AND supervisor_id = ?`
              )
              .get(msg.scheduleId, user.supervisorId);
            if (assigned) {
              meta.scheduleRooms.add(msg.scheduleId);
            }
          }
          broadcastPresence(msg.scheduleId);
        } else if (msg.type === 'leave:schedule' && typeof msg.scheduleId === 'number') {
          meta.scheduleRooms.delete(msg.scheduleId);
          broadcastPresence(msg.scheduleId);
        } else if (msg.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
        }
      } catch {
        // Ignore malformed client messages
      }
    });

    ws.on('close', () => {
      const rooms = Array.from(meta.scheduleRooms);
      clients.delete(meta);
      for (const sid of rooms) {
        broadcastPresence(sid);
      }
    });
  });
}

function broadcastPresence(scheduleId: number): void {
  const activeSupervisors: Array<{ userId: number; nama: string; role: string }> = [];
  for (const c of clients) {
    if (c.scheduleRooms.has(scheduleId) && c.ws.readyState === WebSocket.OPEN) {
      activeSupervisors.push({
        userId: c.user.id,
        nama: c.user.namaLengkap,
        role: c.user.role,
      });
    }
  }
  broadcastToSchedule(scheduleId, {
    type: 'presence:updated',
    scheduleId,
    activeUsers: activeSupervisors,
  });
}

export function broadcastToSchedule(scheduleId: number, payload: Record<string, unknown>): void {
  const encoded = JSON.stringify(payload);
  for (const c of clients) {
    if (c.ws.readyState !== WebSocket.OPEN) continue;
    if (c.scheduleRooms.has(scheduleId) || c.isAdminMonitor) {
      c.ws.send(encoded);
    }
  }
}

export function broadcastToAdmins(payload: Record<string, unknown>): void {
  const encoded = JSON.stringify(payload);
  for (const c of clients) {
    if (c.ws.readyState === WebSocket.OPEN && c.isAdminMonitor) {
      c.ws.send(encoded);
    }
  }
}

export function broadcastToUser(userId: number, payload: Record<string, unknown>): void {
  const encoded = JSON.stringify(payload);
  for (const c of clients) {
    if (c.ws.readyState === WebSocket.OPEN && c.user.id === userId) {
      c.ws.send(encoded);
    }
  }
}
