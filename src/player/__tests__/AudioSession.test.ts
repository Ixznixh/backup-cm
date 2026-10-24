import { describe, it, expect, afterEach } from 'vitest';
import {
  claimPlaybackAudioSession,
  releasePlaybackAudioSession,
  isPlaybackAudioSessionClaimed,
  getSongArtworkUrl,
  buildMediaArtwork,
  buildLockScreenMetadata,
  createSquareThumbnail,
  getCompactArtwork,
  isAudioSessionSupported,
} from '../AudioSession';
import { Song } from '../../types';

const baseSong: Song = {
  id: 'dQw4w9WgXcQ',
  title: 'Test Track',
  artist: 'Test Artist',
  artistId: 'artist-1',
  album: 'Test Album',
  albumId: 'album-1',
  duration: 200,
  streamUrl: '/api/song/dQw4w9WgXcQ/audio',
  artworkUrl: '/pwa-512x512.png',
};

type NavWithSession = Navigator & { audioSession?: { type: string } };

afterEach(() => {
  try {
    delete (navigator as NavWithSession).audioSession;
  } catch {
    // Node's navigator may reject deletion — not important for assertions.
  }
});

describe('AudioSession — OS playback session', () => {
  it('reports no session support and no-ops when the Audio Session API is missing', () => {
    expect(isAudioSessionSupported()).toBe(false);
    expect(claimPlaybackAudioSession()).toBe(false);
  });

  it('claims the playback session type and is idempotent', () => {
    const session = { type: 'auto' };
    Object.defineProperty(navigator, 'audioSession', {
      value: session,
      configurable: true,
      writable: true,
    });

    expect(isAudioSessionSupported()).toBe(true);
    expect(claimPlaybackAudioSession()).toBe(true);
    expect(session.type).toBe('playback');
    expect(isPlaybackAudioSessionClaimed()).toBe(true);

    // Claiming again must not throw or change anything.
    expect(claimPlaybackAudioSession()).toBe(true);
    expect(session.type).toBe('playback');
  });

  it('hands the session back to the system on release', () => {
    const session = { type: 'playback' };
    Object.defineProperty(navigator, 'audioSession', {
      value: session,
      configurable: true,
      writable: true,
    });

    claimPlaybackAudioSession();
    releasePlaybackAudioSession();

    expect(session.type).toBe('auto');
  });
});

describe('AudioSession — lock screen metadata', () => {
  it('falls back to the YouTube thumbnail for bare video ids', () => {
    const artworkUrl = getSongArtworkUrl({ ...baseSong, artworkUrl: '' });
    expect(artworkUrl).toBe('https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg');
  });

  it('returns null when a track has no artwork at all', () => {
    expect(getSongArtworkUrl({ ...baseSong, id: 'custom-track', artworkUrl: '' })).toBeNull();
    expect(getSongArtworkUrl(null)).toBeNull();
  });

  it('publishes a full-size artwork entry for the expanded player', () => {
    const artwork = buildMediaArtwork(baseSong);
    expect(artwork.length).toBeGreaterThanOrEqual(1);
    expect(artwork[artwork.length - 1].sizes).toBe('512x512');
    expect(artwork[artwork.length - 1].src).toBe('/pwa-512x512.png');
  });

  it('always provides artwork, even for a track without any image', () => {
    const artwork = buildMediaArtwork({ ...baseSong, id: 'custom-track', artworkUrl: '' });
    expect(artwork.length).toBe(2);
    expect(artwork[0].sizes).toBe('96x96');
    expect(artwork[1].sizes).toBe('512x512');
  });

  it('builds title / artist / album with sane fallbacks', () => {
    expect(buildLockScreenMetadata(null)).toBeNull();

    const metadata = buildLockScreenMetadata({ ...baseSong, artist: '', album: '' });
    expect(metadata?.title).toBe('Test Track');
    expect(metadata?.artist).toBe('Celestial Music');
    expect(metadata?.album).toBe('Celestial Music');
  });

  it('never rejects when canvas rendering is unavailable', async () => {
    await expect(createSquareThumbnail('/pwa-512x512.png')).resolves.toBeNull();
    await expect(getCompactArtwork('/pwa-512x512.png')).resolves.toBeNull();
  });
});
