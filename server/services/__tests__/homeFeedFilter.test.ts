import { describe, it, expect } from 'vitest';
import { isPlayableSongEntry } from '../youtubeMusic';

describe('Home feed — playable song filtering', () => {
  it('keeps ordinary tracks', () => {
    expect(
      isPlayableSongEntry({ title: 'Senjitaley', artist: 'Anirudh Ravichander', duration: 252 })
    ).toBe(true);
    // Video headings are still single songs, so they must survive.
    expect(
      isPlayableSongEntry({
        title: '| RAAYAN | Dhanush | Sun Pictures | A.R. Rahman',
        artist: 'Water Packet',
        duration: 261,
      })
    ).toBe(true);
  });

  it('drops compilation uploads by length', () => {
    // Real entries from the feed: 58, 100 and 109 minute jukebox uploads.
    expect(isPlayableSongEntry({ title: 'Sean Roldan Songs', artist: 'Peru Enna Peru', duration: 3480 })).toBe(false);
    expect(isPlayableSongEntry({ title: '2026 Tamil Hits Songs', artist: 'Saravana Djoko', duration: 6037 })).toBe(false);
    expect(isPlayableSongEntry({ title: 'Jukebox', artist: 'Anirudh Ravichander', duration: 6572 })).toBe(false);
  });

  it('drops playlist-shaped titles and channel artist names', () => {
    expect(isPlayableSongEntry({ title: 'Music', artist: 'Hiphop Tamizha', duration: 200 })).toBe(false);
    expect(isPlayableSongEntry({ title: 'Naan Gaali Music', artist: 'Think Music India', duration: 283 })).toBe(false);
    expect(isPlayableSongEntry({ title: 'Some Song', artist: 'Kappa TV', duration: 300 })).toBe(false);
  });

  it('rejects empty entries', () => {
    expect(isPlayableSongEntry(null)).toBe(false);
    expect(isPlayableSongEntry({ title: '' })).toBe(false);
  });
});
