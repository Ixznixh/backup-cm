/**
 * AudioSession.ts
 *
 * OS-level audio session and lock-screen (Now Playing) integration.
 *
 * This is what makes the web app behave like a native music player on iPhone:
 *
 * 1. Audio Session API (Safari 16.4+, iOS PWA):
 *    Web audio is treated as "ambient" by default, so the hardware ringer/silent switch
 *    mutes it and the OS may pause it as soon as the screen locks. Setting the session
 *    type to "playback" declares intentional media playback: it survives the silent
 *    switch, participates in Control Center / lock-screen controls and behaves like
 *    Apple Music or Spotify. It also gives us exclusive media priority, so the app is
 *    interrupted cleanly (and can resume) instead of fighting other audio.
 *
 * 2. Media Session metadata:
 *    Title / artist / album / artwork for the lock screen, Control Center, CarPlay and
 *    the iOS Dynamic Island. iOS shows the artwork from the SMALLEST matching entry in
 *    the compact player (it does not downscale a 512px image to the 96px thumbnail slot
 *    before iOS 18), so we generate a real square 96x96 thumbnail once per artwork and
 *    keep the full-resolution image for the expanded player.
 */

import { Song } from '../types';

type AudioSessionType = 'auto' | 'playback' | 'transient' | 'transient-solo' | 'ambient' | 'play-and-record';

interface AudioSessionLike {
  type: AudioSessionType;
}

interface AudioSessionNavigator extends Navigator {
  audioSession?: AudioSessionLike;
}

const COMPACT_ARTWORK_SIZE = 96;
const FULL_ARTWORK_SIZE = 512;
const MAX_CACHED_THUMBNAILS = 16;

/** artwork source URL -> inline data URL of the generated square thumbnail */
const thumbnailCache = new Map<string, string>();
const thumbnailInflight = new Map<string, Promise<string | null>>();

let sessionClaimed = false;

export function isAudioSessionSupported(): boolean {
  if (typeof navigator === 'undefined') return false;
  return Boolean((navigator as AudioSessionNavigator).audioSession);
}

/**
 * Declares this page as a media playback session. Safe to call repeatedly and on every
 * platform (no-op where the Audio Session API is unavailable, e.g. desktop Firefox).
 */
export function claimPlaybackAudioSession(): boolean {
  if (typeof navigator === 'undefined') return false;

  const session = (navigator as AudioSessionNavigator).audioSession;
  if (!session) return false;

  try {
    if (session.type !== 'playback') {
      session.type = 'playback';
    }
    sessionClaimed = true;
    return true;
  } catch {
    return false;
  }
}

/**
 * Hands the audio session back to the system (used when playback is fully stopped so the
 * ringer switch controls notifications normally again).
 */
export function releasePlaybackAudioSession(): void {
  if (typeof navigator === 'undefined' || !sessionClaimed) return;

  const session = (navigator as AudioSessionNavigator).audioSession;
  if (!session) return;

  try {
    session.type = 'auto';
  } catch {
    // Ignore: some WebKit builds reject the transition mid-playback.
  }
}

export function isPlaybackAudioSessionClaimed(): boolean {
  return sessionClaimed;
}

export function isStandalonePWA(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
  try {
    const displayMode = window.matchMedia?.('(display-mode: standalone)')?.matches;
    const iosStandalone = (navigator as Navigator & { standalone?: boolean }).standalone === true;
    return Boolean(displayMode || iosStandalone);
  } catch {
    return false;
  }
}

function isDirectImageSource(src: string): boolean {
  return src.startsWith('blob:') || src.startsWith('data:') || src.startsWith('/api/');
}

function toAbsoluteUrl(src: string): string {
  if (typeof window === 'undefined') return src;
  if (/^(https?:|blob:|data:)/.test(src)) return src;
  try {
    return new URL(src, window.location.origin).href;
  } catch {
    return src;
  }
}

/**
 * Canvas needs CORS-cleared pixels. Artwork hosted elsewhere goes through our own image
 * proxy, which sets `Access-Control-Allow-Origin: *`.
 */
function corsSafeImageSource(src: string): string {
  const absolute = toAbsoluteUrl(src);
  if (isDirectImageSource(src) || isDirectImageSource(absolute)) return absolute;
  if (!/^https?:/.test(absolute)) return absolute;
  return `/api/image-proxy?url=${encodeURIComponent(absolute)}`;
}

function rememberThumbnail(source: string, dataUrl: string): void {
  if (thumbnailCache.size >= MAX_CACHED_THUMBNAILS) {
    const oldest = thumbnailCache.keys().next().value;
    if (oldest !== undefined) {
      thumbnailCache.delete(oldest);
    }
  }
  thumbnailCache.set(source, dataUrl);
}

/**
 * Inline data URL (not a blob: URL): the OS Now Playing card is rendered outside the page,
 * and a blob URL scoped to the page can fail to load there. A 96x96 JPEG is only a few KB.
 */
function canvasToDataUrl(canvas: HTMLCanvasElement): Promise<string | null> {
  try {
    const dataUrl = canvas.toDataURL('image/jpeg', 0.9);
    return Promise.resolve(dataUrl && dataUrl.startsWith('data:image') ? dataUrl : null);
  } catch {
    return Promise.resolve(null);
  }
}

/**
 * Centre-crops the artwork to a square thumbnail. Returns null (never rejects) when the
 * image cannot be decoded or the canvas is unavailable.
 */
export async function createSquareThumbnail(src: string, size = COMPACT_ARTWORK_SIZE): Promise<string | null> {
  if (typeof document === 'undefined' || typeof Image === 'undefined') return null;

  return new Promise((resolve) => {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.referrerPolicy = 'no-referrer';
    let settled = false;

    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      resolve(value);
    };

    const timer = window.setTimeout(() => finish(null), 6000);

    image.onload = () => {
      try {
        const naturalWidth = image.naturalWidth || image.width;
        const naturalHeight = image.naturalHeight || image.height;
        if (!naturalWidth || !naturalHeight) {
          finish(null);
          return;
        }

        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          finish(null);
          return;
        }

        const side = Math.min(naturalWidth, naturalHeight);
        const sx = (naturalWidth - side) / 2;
        const sy = (naturalHeight - side) / 2;
        ctx.drawImage(image, sx, sy, side, side, 0, 0, size, size);
        canvasToDataUrl(canvas).then(finish);
      } catch {
        finish(null);
      }
    };

    image.onerror = () => finish(null);
    image.src = corsSafeImageSource(src);
  });
}

export function getCachedCompactArtwork(src: string): string | null {
  return thumbnailCache.get(toAbsoluteUrl(src)) || thumbnailCache.get(src) || null;
}

/**
 * Returns (and caches) a square 96x96 thumbnail for the given artwork URL.
 */
export function getCompactArtwork(src: string): Promise<string | null> {
  const cacheKey = toAbsoluteUrl(src);
  const cached = thumbnailCache.get(cacheKey);
  if (cached) return Promise.resolve(cached);

  const inflight = thumbnailInflight.get(cacheKey);
  if (inflight) return inflight;

  const task = createSquareThumbnail(cacheKey).then((dataUrl) => {
    thumbnailInflight.delete(cacheKey);
    if (dataUrl) rememberThumbnail(cacheKey, dataUrl);
    return dataUrl;
  });

  thumbnailInflight.set(cacheKey, task);
  return task;
}

/**
 * Primary artwork URL for a track. Handles the id-only YouTube case and relative paths.
 */
export function getSongArtworkUrl(song: Song | null | undefined): string | null {
  if (!song) return null;

  const raw = song.artwork || song.artworkUrl;
  if (raw) {
    const absolute = toAbsoluteUrl(raw);
    if (!absolute || absolute.endsWith('/undefined') || absolute.endsWith('/null')) return null;
    return absolute;
  }

  // Bare YouTube video id (11 chars) — use YouTube's own thumbnail CDN.
  if (song.id && /^[a-zA-Z0-9_-]{11}$/.test(song.id)) {
    return `https://i.ytimg.com/vi/${song.id}/hqdefault.jpg`;
  }

  return null;
}

/**
 * Builds the MediaMetadata artwork list.
 *
 * - Compact 96x96 entry first (lock-screen compact player, iOS < 18 behaviour)
 * - Full 512x512 entry for the expanded player / CarPlay / Android notification
 */
export function buildMediaArtwork(song: Song | null | undefined): MediaImage[] {
  const source = getSongArtworkUrl(song);
  const artwork: MediaImage[] = [];

  if (!source) {
    const fallback = toAbsoluteUrl('/pwa-512x512.png');
    return [
      { src: fallback, sizes: `${COMPACT_ARTWORK_SIZE}x${COMPACT_ARTWORK_SIZE}`, type: 'image/png' },
      { src: fallback, sizes: `${FULL_ARTWORK_SIZE}x${FULL_ARTWORK_SIZE}`, type: 'image/png' },
    ];
  }

  const compact = getCachedCompactArtwork(source);
  if (compact) {
    artwork.push({ src: compact, sizes: `${COMPACT_ARTWORK_SIZE}x${COMPACT_ARTWORK_SIZE}`, type: 'image/jpeg' });
  }

  artwork.push({ src: source, sizes: `${FULL_ARTWORK_SIZE}x${FULL_ARTWORK_SIZE}`, type: 'image/jpeg' });

  return artwork;
}

export interface LockScreenMetadata {
  title: string;
  artist: string;
  album: string;
  artwork: MediaImage[];
}

export function buildLockScreenMetadata(song: Song | null | undefined): LockScreenMetadata | null {
  if (!song) return null;

  return {
    title: song.title || 'Unknown Track',
    artist: song.artist || song.artists || 'Celestial Music',
    album: song.album || 'Celestial Music',
    artwork: buildMediaArtwork(song),
  };
}

/**
 * Applies title/artist/album/artwork to the OS Now Playing card.
 * Returns the pending compact-artwork task so the caller can re-publish metadata once the
 * generated thumbnail is ready (only if the track is still the current one).
 */
export function applyLockScreenMetadata(song: Song | null | undefined): Promise<string | null> | null {
  if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return null;

  const metadata = buildLockScreenMetadata(song);
  if (!metadata) return null;

  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: metadata.title,
      artist: metadata.artist,
      album: metadata.album,
      artwork: metadata.artwork,
    });
  } catch {
    // Metadata assignment can throw on unsupported artwork combinations — never fatal.
  }

  const source = getSongArtworkUrl(song);
  if (!source || getCachedCompactArtwork(source)) return null;

  return getCompactArtwork(source);
}
