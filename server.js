/**
 * CollaBoard - Collaborative Whiteboard Server
 * Node.js + Express + WebSocket (ws)
 *
 * Architecture:
 * - Each "room" is a shared canvas identified by a short code
 * - All WebSocket clients in the same room receive each other's drawing events
 * - Strokes are stored server-side so late joiners see the full board
 * - Rate limiting per connection prevents spam/flooding
 * - Rooms can be "temp" (auto-clears after N minutes) or "perm" (persists until manual clear)
 */

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Serve the static client
app.use(express.static(path.join(__dirname, 'public')));

// ─── Configuration ────────────────────────────────────────────────────────────
const CONFIG = {
  MAX_STROKES_PER_ROOM: 8000,       // Prevent unbounded memory growth
  MAX_POINTS_PER_STROKE: 2000,      // Clip excessively long strokes
  RATE_LIMIT_EVENTS_PER_SEC: 80,    // Max drawing events per client per second
  RATE_LIMIT_WINDOW_MS: 1000,
  ROOM_ID_MAX_LEN: 24,
  DEFAULT_TEMP_MINUTES: 30,
  MIN_TEMP_MINUTES: 1,
  MAX_TEMP_MINUTES: 1440,           // 24 hours
  EMPTY_ROOM_TTL_MS: 5 * 60 * 1000, // Clean up empty rooms after 5 min
};

// ─── Room Management ──────────────────────────────────────────────────────────
// rooms: Map<roomId, Room>
const rooms = new Map();

function sanitizeRoomId(id) {
  return String(id || '')
    .replace(/[^a-zA-Z0-9_-]/g, '')
    .slice(0, CONFIG.ROOM_ID_MAX_LEN) || uuidv4().slice(0, 8);
}

function generateRoomCode() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function getOrCreateRoom(roomId, options = {}) {
  if (!rooms.has(roomId)) {
    const mode = options.mode === 'perm' ? 'perm' : 'temp';
    const tempMinutes = Math.min(
      Math.max(parseInt(options.tempMinutes) || CONFIG.DEFAULT_TEMP_MINUTES, CONFIG.MIN_TEMP_MINUTES),
      CONFIG.MAX_TEMP_MINUTES
    );

    const room = {
      id: roomId,
      mode,
      tempMinutes,
      strokes: [],          // Completed strokes — sent to new joiners
      activeStrokes: {},    // In-progress strokes keyed by clientId (not persisted)
      clients: new Map(),   // clientId → ws
      createdAt: Date.now(),
      clearTimer: null,
      cleanupTimer: null,
    };

    if (mode === 'temp') {
      room.clearTimer = setTimeout(() => {
        clearRoom(roomId, 'timer');
      }, tempMinutes * 60 * 1000);
    }

    rooms.set(roomId, room);
    console.log(`[room] Created room "${roomId}" mode=${mode}${mode === 'temp' ? ` ttl=${tempMinutes}min` : ''}`);
  }
  return rooms.get(roomId);
}

function clearRoom(roomId, reason = 'manual') {
  const room = rooms.get(roomId);
  if (!room) return;
  room.strokes = [];
  room.activeStrokes = {};
  broadcastToRoom(roomId, { type: 'clear', reason });
  console.log(`[room] Cleared room "${roomId}" reason=${reason}`);
}

function broadcastToRoom(roomId, message, excludeClientId = null) {
  const room = rooms.get(roomId);
  if (!room) return;
  const data = JSON.stringify(message);
  room.clients.forEach((ws, clientId) => {
    if (clientId !== excludeClientId && ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  });
}

function scheduleRoomCleanup(roomId) {
  const room = rooms.get(roomId);
  if (!room || room.cleanupTimer) return;
  room.cleanupTimer = setTimeout(() => {
    const r = rooms.get(roomId);
    if (r && r.clients.size === 0) {
      if (r.clearTimer) clearTimeout(r.clearTimer);
      rooms.delete(roomId);
      console.log(`[room] Deleted empty room "${roomId}"`);
    }
  }, CONFIG.EMPTY_ROOM_TTL_MS);
}

// ─── Rate Limiter ─────────────────────────────────────────────────────────────
class RateLimiter {
  constructor(maxEvents, windowMs) {
    this.maxEvents = maxEvents;
    this.windowMs = windowMs;
    this.events = [];
  }
  allow() {
    const now = Date.now();
    this.events = this.events.filter(t => now - t < this.windowMs);
    if (this.events.length >= this.maxEvents) return false;
    this.events.push(now);
    return true;
  }
}

// ─── Validation helpers ───────────────────────────────────────────────────────
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

function sanitizeStroke(stroke) {
  return {
    tool: stroke.tool === 'eraser' ? 'eraser' : 'pencil',
    color: HEX_COLOR.test(stroke.color) ? stroke.color : '#000000',
    size: Math.min(Math.max(Math.round(parseFloat(stroke.size) || 2), 1), 100),
    points: Array.isArray(stroke.points)
      ? stroke.points
          .slice(0, CONFIG.MAX_POINTS_PER_STROKE)
          .map(p => ({ x: +parseFloat(p.x).toFixed(2), y: +parseFloat(p.y).toFixed(2) }))
          .filter(p => isFinite(p.x) && isFinite(p.y))
      : [],
  };
}

// ─── WebSocket Handler ────────────────────────────────────────────────────────
wss.on('connection', (ws) => {
  const clientId = uuidv4();
  const limiter = new RateLimiter(CONFIG.RATE_LIMIT_EVENTS_PER_SEC, CONFIG.RATE_LIMIT_WINDOW_MS);
  let roomId = null;

  ws.on('message', (raw) => {
    // Parse JSON safely
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    // Rate-limit drawing events (not join/clear)
    if (msg.type === 'segment' || msg.type === 'strokeEnd') {
      if (!limiter.allow()) return; // silently drop
    }

    switch (msg.type) {

      // ── Join a room ──────────────────────────────────────────────────────
      case 'join': {
        if (roomId) break; // already joined — ignore

        roomId = sanitizeRoomId(msg.roomId || generateRoomCode());
        const room = getOrCreateRoom(roomId, {
          mode: msg.mode,
          tempMinutes: msg.tempMinutes,
        });

        // Cancel any pending cleanup
        if (room.cleanupTimer) {
          clearTimeout(room.cleanupTimer);
          room.cleanupTimer = null;
        }

        room.clients.set(clientId, ws);
        ws.clientId = clientId;
        ws.roomId = roomId;

        // Send current board state to this client
        ws.send(JSON.stringify({
          type: 'init',
          roomId,
          clientId,
          mode: room.mode,
          tempMinutes: room.tempMinutes,
          strokes: room.strokes,
          userCount: room.clients.size,
        }));

        // Notify others of updated user count
        broadcastToRoom(roomId, { type: 'userCount', count: room.clients.size }, clientId);
        console.log(`[ws] Client ${clientId.slice(0,6)} joined room "${roomId}" (${room.clients.size} users)`);
        break;
      }

      // ── Live drawing segment (forwarded instantly, not persisted) ─────────
      // These give the "live" feel to other users while someone is drawing
      case 'segment': {
        if (!roomId) break;
        const { x0, y0, x1, y1, color, size, tool } = msg;
        if (![x0, y0, x1, y1].every(isFinite)) break;

        broadcastToRoom(roomId, {
          type: 'segment',
          clientId,
          x0: +parseFloat(x0).toFixed(2),
          y0: +parseFloat(y0).toFixed(2),
          x1: +parseFloat(x1).toFixed(2),
          y1: +parseFloat(y1).toFixed(2),
          color: HEX_COLOR.test(color) ? color : '#000000',
          size: Math.min(Math.max(Math.round(parseFloat(size) || 2), 1), 100),
          tool: tool === 'eraser' ? 'eraser' : 'pencil',
        }, clientId);
        break;
      }

      // ── Stroke completed — persist for new joiners ────────────────────────
      case 'stroke': {
        if (!roomId) break;
        const room = rooms.get(roomId);
        if (!room) break;

        const stroke = sanitizeStroke(msg);
        if (stroke.points.length < 1) break;

        if (room.strokes.length < CONFIG.MAX_STROKES_PER_ROOM) {
          room.strokes.push(stroke);
        }
        // Broadcast full stroke so remote peers can replace their live preview
        broadcastToRoom(roomId, { type: 'stroke', clientId, stroke }, clientId);
        break;
      }

      // ── Clear board ───────────────────────────────────────────────────────
      case 'clear': {
        if (!roomId) break;
        clearRoom(roomId, 'manual');
        // Also send back to the requester so their canvas clears
        ws.send(JSON.stringify({ type: 'clear', reason: 'manual' }));
        break;
      }

      default:
        break;
    }
  });

  ws.on('close', () => {
    if (roomId) {
      const room = rooms.get(roomId);
      if (room) {
        room.clients.delete(clientId);
        delete room.activeStrokes[clientId];
        broadcastToRoom(roomId, { type: 'userCount', count: room.clients.size });
        console.log(`[ws] Client ${clientId.slice(0,6)} left room "${roomId}" (${room.clients.size} remaining)`);
        if (room.clients.size === 0) scheduleRoomCleanup(roomId);
      }
    }
  });

  ws.on('error', (err) => {
    console.error(`[ws] Error for client ${clientId.slice(0,6)}:`, err.message);
  });
});

// ─── HTTP Routes ──────────────────────────────────────────────────────────────
// Health check endpoint (useful for Render/Railway zero-downtime deploys)
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    rooms: rooms.size,
    connections: wss.clients.size,
    uptime: process.uptime(),
  });
});

// ─── Start ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n  🎨 CollaBoard server running at http://localhost:${PORT}\n`);
});
