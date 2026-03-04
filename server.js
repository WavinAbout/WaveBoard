/**
 * CollaBoard v2 — Collaborative Whiteboard Server
 * Supports: path, fill, shape, image, text strokes
 * Rate-limiting, room management, replay for new joiners
 */

const express = require('express');
const http    = require('http');
const WebSocket = require('ws');
const path    = require('path');
const { v4: uuidv4 } = require('uuid');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));

// ── Config ────────────────────────────────────────────────────────────────────
const CFG = {
  MAX_STROKES:      10000,
  MAX_POINTS:       4000,
  MAX_IMAGE_BYTES:  400000,
  RATE_LIMIT:       120,
  RATE_WINDOW:      1000,
  ROOM_ID_MAX:      24,
  DEFAULT_TEMP_MIN: 60,
  MIN_TEMP_MIN:     1,
  MAX_TEMP_MIN:     1440,
  EMPTY_ROOM_TTL:   5 * 60000,
};

const rooms = new Map();

function sanitizeId(id) {
  return String(id || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, CFG.ROOM_ID_MAX)
    || uuidv4().slice(0, 8);
}

function getOrCreate(roomId, opts = {}) {
  if (!rooms.has(roomId)) {
    const mode   = opts.mode === 'perm' ? 'perm' : 'temp';
    const tempMin = Math.min(Math.max(parseInt(opts.tempMinutes) || CFG.DEFAULT_TEMP_MIN, CFG.MIN_TEMP_MIN), CFG.MAX_TEMP_MIN);
    const room   = { id: roomId, mode, tempMin, strokes: [], clients: new Map(), createdAt: Date.now(), clearTimer: null, cleanupTimer: null };
    if (mode === 'temp') room.clearTimer = setTimeout(() => clearRoom(roomId, 'timer'), tempMin * 60000);
    rooms.set(roomId, room);
    console.log(`[room+] "${roomId}" mode=${mode}${mode==='temp'?` ttl=${tempMin}min`:''}`);
  }
  return rooms.get(roomId);
}

function clearRoom(roomId, reason) {
  const r = rooms.get(roomId);
  if (!r) return;
  r.strokes = [];
  broadcast(roomId, { type: 'clear', reason });
  console.log(`[room] "${roomId}" cleared (${reason})`);
}

function broadcast(roomId, msg, excludeId) {
  const r = rooms.get(roomId);
  if (!r) return;
  const raw = JSON.stringify(msg);
  r.clients.forEach((ws, cid) => {
    if (cid !== excludeId && ws.readyState === WebSocket.OPEN) ws.send(raw);
  });
}

function scheduleCleanup(roomId) {
  const r = rooms.get(roomId);
  if (!r || r.cleanupTimer) return;
  r.cleanupTimer = setTimeout(() => {
    const room = rooms.get(roomId);
    if (room && room.clients.size === 0) {
      if (room.clearTimer) clearTimeout(room.clearTimer);
      rooms.delete(roomId);
      console.log(`[room-] "${roomId}" deleted`);
    }
  }, CFG.EMPTY_ROOM_TTL);
}

class RateLimiter {
  constructor() { this.events = []; }
  allow() {
    const now = Date.now();
    this.events = this.events.filter(t => now - t < CFG.RATE_WINDOW);
    if (this.events.length >= CFG.RATE_LIMIT) return false;
    this.events.push(now);
    return true;
  }
}

const HEX = /^#[0-9a-fA-F]{3,8}$/;
const validColor   = c => typeof c === 'string' && HEX.test(c) ? c : '#000000';
const validSize    = n => Math.min(Math.max(Math.round(parseFloat(n)||2), 0.5), 300);
const validCoord   = n => isFinite(parseFloat(n)) ? +parseFloat(n).toFixed(2) : 0;
const validOpacity = n => Math.min(Math.max(parseFloat(n)||1, 0.01), 1);

function validateStroke(raw) {
  const t = String(raw.strokeType || 'path');
  const base = { strokeType: t, color: validColor(raw.color), size: validSize(raw.size), opacity: validOpacity(raw.opacity) };

  if (t === 'path') {
    const pts = Array.isArray(raw.points)
      ? raw.points.slice(0, CFG.MAX_POINTS).map(p => ({ x: validCoord(p.x), y: validCoord(p.y) })).filter(p => isFinite(p.x) && isFinite(p.y))
      : [];
    return { ...base, tool: raw.tool === 'eraser' ? 'eraser' : 'pencil', points: pts };
  }
  if (t === 'fill') {
    return { ...base, x: validCoord(raw.x), y: validCoord(raw.y), tolerance: Math.min(Math.max(parseInt(raw.tolerance)||30, 0), 255) };
  }
  if (t === 'shape') {
    return { ...base, shape: ['line','rect','ellipse','arrow'].includes(raw.shape) ? raw.shape : 'line', x1: validCoord(raw.x1), y1: validCoord(raw.y1), x2: validCoord(raw.x2), y2: validCoord(raw.y2), filled: !!raw.filled, fillColor: validColor(raw.fillColor || raw.color) };
  }
  if (t === 'image') {
    const data = String(raw.data || '');
    if (data.length > CFG.MAX_IMAGE_BYTES) return null;
    return { ...base, x: validCoord(raw.x), y: validCoord(raw.y), w: Math.min(validSize(raw.w||100), 4000), h: Math.min(validSize(raw.h||100), 4000), data };
  }
  if (t === 'text') {
    return { ...base, x: validCoord(raw.x), y: validCoord(raw.y), text: String(raw.text||'').slice(0,500), font: String(raw.font||'16px sans-serif').slice(0,80) };
  }
  return null;
}

wss.on('connection', (ws) => {
  const clientId = uuidv4();
  const limiter  = new RateLimiter();
  let roomId = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (['segment','stroke'].includes(msg.type) && !limiter.allow()) return;

    switch (msg.type) {
      case 'join': {
        if (roomId) break;
        roomId = sanitizeId(msg.roomId);
        const room = getOrCreate(roomId, { mode: msg.mode, tempMinutes: msg.tempMinutes });
        if (room.cleanupTimer) { clearTimeout(room.cleanupTimer); room.cleanupTimer = null; }
        room.clients.set(clientId, ws);
        ws.send(JSON.stringify({ type: 'init', roomId, clientId, mode: room.mode, tempMin: room.tempMin, strokes: room.strokes, userCount: room.clients.size }));
        broadcast(roomId, { type: 'userCount', count: room.clients.size }, clientId);
        console.log(`[ws+] ${clientId.slice(0,6)} → "${roomId}" (${room.clients.size})`);
        break;
      }
      case 'segment': {
        if (!roomId) break;
        broadcast(roomId, { type: 'segment', clientId, x0: validCoord(msg.x0), y0: validCoord(msg.y0), x1: validCoord(msg.x1), y1: validCoord(msg.y1), color: validColor(msg.color), size: validSize(msg.size), tool: msg.tool === 'eraser' ? 'eraser' : 'pencil', opacity: validOpacity(msg.opacity) }, clientId);
        break;
      }
      case 'stroke': {
        if (!roomId) break;
        const room = rooms.get(roomId);
        if (!room) break;
        const stroke = validateStroke(msg);
        if (!stroke) break;
        if (room.strokes.length < CFG.MAX_STROKES) room.strokes.push(stroke);
        broadcast(roomId, { type: 'stroke', clientId, stroke }, clientId);
        break;
      }
      case 'clear': {
        if (!roomId) break;
        clearRoom(roomId, 'manual');
        ws.send(JSON.stringify({ type: 'clear', reason: 'manual' }));
        break;
      }
    }
  });

  ws.on('close', () => {
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (room) {
      room.clients.delete(clientId);
      broadcast(roomId, { type: 'userCount', count: room.clients.size });
      console.log(`[ws-] ${clientId.slice(0,6)} left "${roomId}" (${room.clients.size})`);
      if (room.clients.size === 0) scheduleCleanup(roomId);
    }
  });

  ws.on('error', (e) => console.error(`[ws!] ${clientId.slice(0,6)}:`, e.message));
});

app.get('/api/health', (_, res) => res.json({ ok: true, rooms: rooms.size, clients: wss.clients.size, uptime: process.uptime() }));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`\n  🎨 CollaBoard v2  →  http://localhost:${PORT}\n`));
