# 🎨 CollaBoard — Collaborative Whiteboard

A lightweight real-time multiplayer whiteboard built with **HTML5 Canvas + Node.js + WebSockets**.  
No accounts. No tracking. Just draw together.

---

## ✨ Features

| Feature | Details |
|---|---|
| 🖊️ Tools | Pencil, Eraser, Color picker, Brush size slider |
| 🎨 Palette | 20 preset colors + custom color picker |
| 👥 Multiplayer | Real-time drawing sync via WebSockets |
| 🔗 Rooms | Join by URL `?room=YOURCODE` or enter a code |
| ⏱️ Temp mode | Board auto-clears after N minutes (configurable) |
| 💾 Perm mode | Board persists until manually cleared |
| 📱 Mobile | Full touch support (draw with finger/stylus) |
| ⌨️ Shortcuts | `P` = pencil, `E` = eraser, `[`/`]` = size |
| 🔒 Rate limiting | Server drops drawing events > 80/sec per client |

---

## 🚀 Run Locally

### Prerequisites
- Node.js 16+ and npm

### Install & Start

```bash
# 1. Install dependencies
npm install

# 2. Start the server
npm start

# 3. Open in browser
open http://localhost:3000
```

For development with auto-restart:
```bash
npm run dev
```

### Share a Room
1. Open `http://localhost:3000` in your browser
2. Enter a room code (or leave blank to generate one)
3. Choose **Temporary** (auto-clears) or **Permanent** mode
4. Click **Join / Create Room**
5. Share the URL — it will look like: `http://localhost:3000/?room=ABC123`

---

## 🌐 Deploy for Free

### Option A: Render.com (Recommended)
Render supports WebSockets natively on free tier.

1. Push this folder to a GitHub repo
2. Go to [render.com](https://render.com) → **New Web Service**
3. Connect your GitHub repo
4. Set:
   - **Build Command**: `npm install`
   - **Start Command**: `node server.js`
   - **Environment**: Node
5. Deploy. Your URL will be `https://your-app.onrender.com`

> ⚠️ Free tier on Render spins down after 15 min of inactivity.
> Use the `/api/health` endpoint with an uptime monitor (e.g. UptimeRobot) to keep it awake.

### Option B: Railway.app
1. Push to GitHub
2. Create a new project at [railway.app](https://railway.app)
3. Deploy from GitHub — Railway auto-detects Node.js
4. It will assign a public `*.railway.app` URL

### Option C: Fly.io
```bash
npm install -g flyctl
fly auth login
fly launch   # follow prompts, choose free instance size
fly deploy
```

### Option D: Glitch.com
1. Go to [glitch.com](https://glitch.com) → **New Project → Import from GitHub**
2. Glitch keeps Node.js apps running and supports WebSockets
3. Paste your GitHub repo URL

---

## 🏗️ Architecture

```
Browser A          Server              Browser B
   |                  |                   |
   |──── join ───────►|                   |
   |◄─── init ────────|   (sends strokes) |
   |                  |                   |
   |──── segment ────►|──── segment ─────►|  (live preview)
   |──── segment ────►|──── segment ─────►|
   |                  |                   |
   |──── stroke  ────►|──── stroke  ─────►|  (persist + replay)
   |                  | (stores to room)  |
   |                  |                   |
```

### How Multiplayer Syncing Works

Two-tier event system:

1. **`segment` events** (sent ~70fps while drawing)  
   Each mouse/touch move sends `{x0, y0, x1, y1, color, size, tool}`.  
   The server rate-checks and forwards instantly to all room peers.  
   This gives the "drawing live" feel — minimal latency.

2. **`stroke` events** (sent on mouseup/touchend)  
   The complete array of points for the stroke is sent once.  
   The server **stores it** in the room's stroke history.  
   New users who join later receive all stored strokes in the `init` packet and replay them to reconstruct the board state.

This separation means:
- Low latency during drawing (tiny segment messages)  
- Correctness on join/reconnect (full stroke replay)  
- No overwriting: each user draws to the shared canvas independently, and WebSocket ordering within a connection is guaranteed

### Room Lifecycle

```
create room → clients join → draw → [temp: auto-clear after N min | perm: manual clear]
                                  → clients leave → room kept 5min → auto-deleted
```

---

## 🔒 Security & Privacy

- **No accounts** — rooms are identified by a random code only
- **No personal data stored** — no IPs, no user IDs, no cookies
- **Rate limiting** — server drops events exceeding 80 draw events/second per connection
- **Input validation** — all coordinates, colors, and sizes are sanitized server-side
- **Max stroke count** per room: 8000 (prevents memory exhaustion)
- **Room cleanup** — empty rooms are deleted after 5 minutes

---

## 📁 Project Structure

```
collaboard/
├── server.js          # Node.js WebSocket + Express server
├── package.json       # Dependencies
├── README.md          # This file
└── public/
    └── index.html     # Single-file client (Canvas + JS + CSS)
```

---

## 🛠️ Configuration

Edit the `CONFIG` object at the top of `server.js`:

```js
const CONFIG = {
  MAX_STROKES_PER_ROOM: 8000,       // Memory limit
  MAX_POINTS_PER_STROKE: 2000,      // Clip long strokes
  RATE_LIMIT_EVENTS_PER_SEC: 80,    // Anti-flood
  DEFAULT_TEMP_MINUTES: 30,         // Default auto-clear time
  MAX_TEMP_MINUTES: 1440,           // Max TTL (24 hours)
  EMPTY_ROOM_TTL_MS: 5 * 60 * 1000 // Room cleanup delay
};
```

---

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `P` | Pencil tool |
| `E` | Eraser tool |
| `[` | Decrease brush size |
| `]` | Increase brush size |

---

*Built with ❤️ using HTML5 Canvas, Node.js, and the `ws` WebSocket library.*
