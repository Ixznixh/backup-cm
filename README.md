# Celestial Music

A modern, ad-free music player Progressive Web App (PWA) inspired by the sleek visual language of premium iOS applications. Built with React, TypeScript, Tailwind CSS, Express, and `youtubei.js` on the server backend.

---

## 🚀 Getting Started

### 1. Prerequisites
- **Node.js**: v18.0.0 or later (Node.js 20+ recommended)
- **npm** or **bun** / **yarn**

### 2. Install Dependencies
```bash
npm install
```

### 3. Start Development Server (Full-Stack)
```bash
npm run dev
```
This starts both the Express backend API and the Vite development server on port `3000`.

### 4. Open Local URL
Visit `http://localhost:3000` in your web browser or iOS Safari.

---

## 🏗️ Production Build & Deployment

### Build the Application
```bash
npm run build
```
This builds the client assets into `dist/` with Vite and bundles the server into `dist/server.cjs` with `esbuild`.

### Start Production Server
```bash
npm start
```
Starts `node dist/server.cjs` listening on port `3000` (and `0.0.0.0` for container ingress).

---

## 🛠️ Architecture & Music Provider

- **Backend**: Express + `youtubei.js` running on the Node server.
- **Client**: React PWA communicating with `/api/*` endpoints.
- **Provider Isolation**: Provider internals are strictly isolated to the server. The client never imports `youtubei.js` directly and consumes only normalized JSON.
- **Zero API Keys Required**: No YouTube Data API key or Google API key is needed for standard operation.

### Audio resolution
- **Primary source**: JioSaavn 320 kbps AAC. Tracks are matched by title, artist and duration so the audio always belongs to the song on screen; weak matches are rejected instead of playing the wrong recording.
- **Fallback**: YouTube Music (`youtubei.js`). Stream extraction is refused by YouTube on many datacenter IPs, so this is a backup, not the default.
- **Direct CDN playback**: resolved JioSaavn URLs are CDN-hosted with HTTP Range + CORS support, so `/api/song/:id/audio` answers with a `302` and the client streams straight from the edge — no proxy hop, real seeking, and reliable iOS lock-screen playback. `/prewarm` hands over the next track's direct URL so track changes need no server round trip.
- **No filler audio**: if nothing playable can be resolved the endpoint returns `503` and the player skips the track. (Generated test tones remain available only for explicit `test-*` / `celestial-*` diagnostic ids.)

### Endpoints
- `GET /api/home` - Real home feed sections (Quick Picks, Recommended, Trending, Charts)
- `GET /api/search?q=:query` - Search songs, artists, albums, and playlists
- `GET /api/search/suggestions?q=:query` - Real search auto-complete suggestions
- `GET /api/song/:id` - Normalized track metadata
- `GET /api/song/:id/audio` - Real audio: `302` to the direct CDN stream, or a proxied `206` range stream for sources that need server headers
- `POST /api/song/prepare` - Resolves direct CDN URLs for a batch of upcoming tracks in one call (keeps background track changes instant)
- `GET /api/song/:id/prewarm` - Pre-resolves the next track so a transition needs no server round trip
- `GET /api/album/:id` - Album metadata and full tracklist
- `GET /api/artist/:id` - Artist overview, top songs, albums, and singles
- `GET /api/playlist/:id` - Playlist metadata and items
- `GET /api/lyrics/:id` - Synced/plain lyrics via LRCLIB and YouTube Music
- `GET /api/queue/:id` - Contextual recommendations and up next queue

---

## 🧪 Demo Mode (Testing / Development)

By default, Celestial Music operates exclusively in **Real Music Mode** (`VITE_DEMO_MODE=false`).

To enable offline/mock test data:
```env
VITE_DEMO_MODE=true
```

---

## 🚀 Deploy to Vercel

The frontend is a static Vite build; the music API runs as one Express function in `api/index.ts`
(the resolver has to be server-side because the catalogue API blocks browser requests via CORS).

1. Push this repo to GitHub.
2. In Vercel, **Add New → Project** and import the repository.
   Framework preset, build command and output directory are read from `vercel.json` — do not override them.
3. Deploy. The site is live at `https://<project>.vercel.app`.

Optional environment variables (all have working defaults):

```env
GEMINI_API_KEY=      # AI-written lyrics, optional
YOUTUBE_API_KEY=     # not required, the API is keyless
```

To attach a custom domain: Vercel → Project → **Settings → Domains → Add**, then point the
domain's DNS at Vercel (`A 76.76.21.21` for an apex domain, `CNAME cname.vercel-dns.com` for `www`).

> **After changing anything under `server/`, run `npm run build:api` and commit `api/index.js`.**
> Vercel packages that file as the serverless function, so the committed bundle is what ships.
> It is bundled rather than compiled per-file because Vercel runs TypeScript output as native ESM,
> where the extensionless imports used across `server/` do not resolve.

---

## ⚠️ Provider Limitations & Policy Compliance

- **No Ads or Analytics**: Zero tracking pixels, advertisements, or third-party tracking scripts.
- **DRM & Access Restrictions**: Only audio streams made legitimately accessible by the provider are streamed. If a track is geoblocked or restricted by YouTube, the app gracefully reports status without crashing.
- **Local Persistence**: User playlists, favorites, custom library tracks, and recently played history are persisted locally in the browser via IndexedDB.
