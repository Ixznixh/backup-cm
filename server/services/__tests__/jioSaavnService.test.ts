import { describe, it, expect } from 'vitest';
import {
  normalizeForMatch,
  scoreCandidate,
  pickBestMatch,
  decryptMediaUrl,
  isDirectPlayableCdnUrl,
  artistSimilarity,
  buildTitleVariants,
  buildMatchHypotheses,
  isLabelCredit,
  SaavnCandidateMeta,
} from '../jioSaavnService';

const kesariya = { title: 'Kesariya', artist: 'Pritam, Arijit Singh, Amitabh Bhattacharya', duration: 268 };
const kesariyaLofi = { title: 'Kesariya (Lofi Flip)', artist: 'VIBIE, Arijit Singh, Pritam', duration: 240 };
const kesariyaCover = { title: 'Kesariya', artist: 'Some Cover Band', duration: 268 };
const unrelated = { title: 'Shape of You', artist: 'Ed Sheeran', duration: 233 };

describe('JioSaavn — track matching', () => {
  it('strips bracket noise and punctuation when normalising', () => {
    expect(normalizeForMatch('Kesariya (From "Brahmastra")')).toBe('kesariya');
    expect(normalizeForMatch('  Blinding   Lights [Official Video] ')).toBe('blinding lights');
  });

  it('scores the original recording above a lofi rework', () => {
    const target = { title: 'Kesariya', artist: 'Arijit Singh', durationSec: 268 };
    expect(scoreCandidate(kesariya, target)).toBeGreaterThan(scoreCandidate(kesariyaLofi, target));
    expect(scoreCandidate(kesariya, target)).toBeGreaterThan(scoreCandidate(kesariyaCover, target));
  });

  it('picks the matching recording, not a rework', () => {
    const match = pickBestMatch([kesariyaLofi, kesariya], {
      title: 'Kesariya',
      artist: 'Arijit Singh',
      durationSec: 268,
    });
    expect(match?.title).toBe('Kesariya');
    expect(match?.duration).toBe(268);
  });

  it('keeps Japanese/Tamil titles intact', () => {
    expect(normalizeForMatch('Kanave Kanave (From "David")')).toBe('kanave kanave');
    expect(normalizeForMatch('உயிரே உயிரே')).toBe('உயிரே உயிரே');
  });

  it('accepts a different-length edit when title and artist both match exactly', () => {
    // Real case: YouTube Music lists this track at 210s, the Saavn copy is 128s.
    const saavnEdit = { title: 'Aaja Raja (From "KH x RK Reunion")', artist: 'Anirudh Ravichander, Chintu', duration: 128 };
    expect(
      pickBestMatch([saavnEdit], {
        title: 'Aaja Raja (From "KH x RK Reunion")',
        artist: 'Anirudh Ravichander',
        durationSec: 210,
      })?.duration
    ).toBe(128);
  });

  it('rejects a same-titled cover whose length and artist do not match', () => {
    const cover = { title: 'Aaja Raja', artist: 'Unknown Cover Band', duration: 190 };
    expect(
      pickBestMatch([cover], { title: 'Aaja Raja', artist: 'Anirudh Ravichander', durationSec: 128 })
    ).toBeNull();
  });

  it('still matches when no duration hint is available', () => {
    expect(pickBestMatch([kesariya], { title: 'Kesariya', artist: 'Arijit Singh' })?.title).toBe(
      'Kesariya'
    );
  });

  it('refuses to return a wrong song for an unresolvable track', () => {
    const target = { title: 'Blinding Lights', artist: 'The Weeknd', durationSec: 200 };
    const candidates: SaavnCandidateMeta[] = [
      { title: 'Blinding Lights (Nightcore)', artist: 'Nøvacore', duration: 137 },
      { title: 'blinding lights (ambient version)', artist: 'stillsilent.', duration: 213 },
      unrelated,
    ];
    expect(pickBestMatch(candidates, target)).toBeNull();
  });
});

describe('JioSaavn — messy YouTube Music metadata', () => {
  it('matches a handle-style artist credit against the catalogue spelling', () => {
    // YouTube Music reports @SaiAbhyankkar; JioSaavn credits "Sai Abhyankkar".
    expect(artistSimilarity('@SaiAbhyankkar', 'Vivek, Sai Abhyankkar, Shruti Haasan')).toBeGreaterThan(
      0.5
    );
  });

  it('matches a title whose heading is a whole video description', () => {
    const variants = buildTitleVariants('| Sardar 2 | Karthi | Malavika Mohanan | PS Mithran');
    expect(variants[0]).toBe('Sardar 2 | Karthi | Malavika Mohanan | PS Mithran');
    expect(variants).toContain('Sardar 2');
    expect(variants).toContain('Karthi');
  });

  it('strips presentational suffixes but keeps remix qualifiers', () => {
    expect(buildTitleVariants('Andhamaa Andhamaa Film Version')).toContain('Andhamaa Andhamaa');
    expect(buildTitleVariants('Nira - Lyrical Video')).toContain('Nira');
    // A remix is different audio, so it must never be reduced to the original title.
    expect(buildTitleVariants('Kesariya Lofi Remix')).not.toContain('Kesariya');
  });

  it('tries the artist field as the song name for video-style titles', () => {
    // Real case: the feed entry's title is a cast list, its artist field is the song name.
    const hypotheses = buildMatchHypotheses('| Sardar 2 | Karthi | Malavika Mohanan | Sam CS', 'Mayil Veera');
    expect(hypotheses).toContainEqual({ title: 'Mayil Veera', artist: undefined });
  });

  it('does not swap title and artist for a normal, well-formed track', () => {
    const hypotheses = buildMatchHypotheses('Kesariya', 'Arijit Singh');
    expect(hypotheses).toEqual([{ title: 'Kesariya', artist: 'Arijit Singh' }]);
  });

  it('keeps a single search for clean metadata and caps fan-out', () => {
    expect(buildMatchHypotheses('Kesariya', 'Pritam, Arijit Singh').length).toBe(1);
    expect(
      buildMatchHypotheses('A | B | C | D | E', 'Some Artist Name Here').length
    ).toBeLessThanOrEqual(3);
  });
});

describe('JioSaavn — label credits and video-length durations', () => {
  it('recognises label and channel credits as non-performers', () => {
    expect(isLabelCredit('Think Music India')).toBe(true);
    expect(isLabelCredit('Sony Music South')).toBe(true);
    expect(isLabelCredit('Kappa TV')).toBe(true);
    expect(isLabelCredit('Anirudh Ravichander')).toBe(false);
    expect(isLabelCredit('Sean Roldan')).toBe(false);
  });

  it('accepts an exact title when the catalogued copy is shorter than the video', () => {
    // Real case: "Ezhutha Kadhaiyo" is 272s in the feed (the video) and 194s in the catalogue.
    const saavnTrack = { title: 'Ezhutha Kadhaiyo', artist: 'Sean Roldan, Meha Agarwal', duration: 194 };
    expect(
      pickBestMatch([saavnTrack], {
        title: 'Ezhutha Kadhaiyo',
        artist: 'Think Music India',
        durationSec: 272,
      })?.duration
    ).toBe(194);
  });

  it('still rejects a near-titled different song', () => {
    // "Sait Ji" and "Great Ji" are different tracks on the same album.
    const other = { title: 'Great Ji', artist: 'Hiphop Tamizha, Thamizh Aadhavan', duration: 261 };
    expect(
      pickBestMatch([other], { title: 'Sait Ji', artist: 'Hiphop Tamizha', durationSec: 263 })
    ).toBeNull();
  });
});

describe('JioSaavn — media URL handling', () => {
  it('decrypts a real encrypted media URL and upgrades it to 320 kbps', () => {
    // Captured from song.getDetails for "Kesariya" and verified against the CDN (HTTP 206, audio/mp4).
    const encrypted =
      'ID2ieOjCrwfgWvL5sXl4B1ImC5QfbsDyryhkSYK5IH2E7FCO52VR6yhNbcEbes5iCcja4+W8xhE0SwtCJToN4Bw7tS9a8Gtq';
    expect(decryptMediaUrl(encrypted)).toBe(
      'https://aac.saavncdn.com/871/c2febd353f3a076a406fa37510f31f9f_320.mp4'
    );
  });

  it('returns null for garbage instead of throwing', () => {
    expect(decryptMediaUrl('')).toBeNull();
    expect(decryptMediaUrl('not-base64-ciphertext')).toBeNull();
  });

  it('recognises direct-playable CDN URLs only', () => {
    expect(isDirectPlayableCdnUrl('https://aac.saavncdn.com/871/abc_320.mp4')).toBe(true);
    expect(isDirectPlayableCdnUrl('http://aac.saavncdn.com/871/abc_320.mp4')).toBe(false);
    expect(isDirectPlayableCdnUrl('https://evil-saavncdn.com/abc.mp4')).toBe(false);
    expect(isDirectPlayableCdnUrl('https://r1---sn-abc.googlevideo.com/videoplayback')).toBe(false);
    expect(isDirectPlayableCdnUrl('')).toBe(false);
  });
});
