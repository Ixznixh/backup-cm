import { describe, it, expect } from 'vitest';
import { applyAudioQuality, scoreLyricsMatch } from '../youtubeMusic';

const cdnStream = (kbps = 320) => ({
  streamUrl: `https://aac.saavncdn.com/868/5cd4eba618f97900172464ba53837234_${kbps}.mp4`,
  available: true,
  format: 'audio/mp4',
  bitrate: kbps * 1000,
  duration: 251,
});

describe('Audio quality setting', () => {
  it('drops to the 160 kbps rendition for the Standard setting', () => {
    const stream = applyAudioQuality(cdnStream(), 'normal');
    expect(stream.streamUrl).toContain('_160.mp4');
    expect(stream.bitrate).toBe(160000);
  });

  it('keeps the 320 kbps rendition for High, Lossless and Hi-Res', () => {
    for (const quality of ['high', 'lossless', 'hires', '', undefined]) {
      expect(applyAudioQuality(cdnStream(), quality).streamUrl).toContain('_320.mp4');
    }
  });

  it('preserves query strings and leaves non-catalogue streams untouched', () => {
    const withQuery = { ...cdnStream(), streamUrl: `${cdnStream().streamUrl}?token=abc` };
    expect(applyAudioQuality(withQuery, 'normal').streamUrl).toContain('_160.mp4?token=abc');

    const youtubeStream = { ...cdnStream(), streamUrl: 'https://r1.googlevideo.com/videoplayback?expire=1' };
    expect(applyAudioQuality(youtubeStream, 'normal').streamUrl).toContain('googlevideo.com');
  });
});

describe('Lyric provider match scoring', () => {
  const target = { title: 'Kesariya', artist: 'Arijit Singh', duration: 269 };

  it('accepts the same recording', () => {
    expect(scoreLyricsMatch({ title: 'Kesariya', artist: 'Arijit Singh', duration: 268 }, target)).toBeGreaterThan(0.8);
    expect(
      scoreLyricsMatch({ title: 'Kesariya (From "Brahmastra")', artist: 'Arijit Singh, Pritam', duration: 269 }, target)
    ).toBeGreaterThan(0.8);
  });

  it('rejects a cover or a wrong song that happens to share a word', () => {
    expect(scoreLyricsMatch({ title: 'Kesariya Cover', artist: 'Unknown Band', duration: 300 }, target)).toBeLessThan(0.75);
    expect(scoreLyricsMatch({ title: 'Tum Hi Ho', artist: 'Arijit Singh', duration: 268 }, target)).toBeLessThan(0.55);
    expect(scoreLyricsMatch({ title: 'Shayad', artist: 'Arijit Singh', duration: 150 }, target)).toBeLessThan(0.55);
  });
});
