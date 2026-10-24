/**
 * JioSaavn stream resolver.
 *
 * YouTube blocks stream extraction from datacenter IPs ("Sign in to confirm you're not a bot"),
 * which is why tracks were falling back to generated audio. JioSaavn's public catalogue API
 * serves direct 320 kbps AAC (MP4) URLs from its CDN, with HTTP Range support and permissive
 * CORS, and does not require an account or an API key. That makes it the right primary audio
 * source for a browser / iOS background player:
 *
 *  - audio/mp4 (AAC) is natively supported by iOS Safari and Android Chrome
 *  - byte-range requests work, so seeking and lock-screen scrubbing work
 *  - the CDN sends `Access-Control-Allow-Origin: *`, so the audio element can stream the URL
 *    directly with no server round trip (zero added latency) and the Web Audio EQ keeps working
 *
 * Resolution is a single search request. Matches are scored on title, artist and duration so the
 * audio always belongs to the track the app is displaying; a weak match is rejected rather than
 * playing the wrong song.
 */

import DES from 'des.js';

const SAAVN_API = 'https://www.jiosaavn.com/api.php';
const SAAVN_DES_KEY = '38346591';
const SAAVN_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const SEARCH_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_CACHE_ENTRIES = 800;
const REQUEST_TIMEOUT_MS = 6000;

export interface SaavnTrack {
  id: string;
  title: string;
  artist: string;
  album: string;
  duration: number; // seconds
  streamUrl320: string;
  artwork?: string;
  language?: string;
  year?: string;
}

export interface SaavnMatchTarget {
  title: string;
  artist?: string;
  durationSec?: number;
}

export interface SaavnCandidateMeta {
  title: string;
  artist: string;
  duration: number;
}

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'from', 'feat', 'ft', 'featuring', 'with',
  'official', 'video', 'audio', 'lyric', 'lyrics', 'song', 'full', 'hd', '4k',
  'remaster', 'remastered', 'version', 'edit', 'explicit', 'clean',
]);

export function normalizeForMatch(value: string | null | undefined): string {
  if (!value) return '';
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\((?:[^)]*)\)|\[[^\]]*\]/g, ' ')
    // Keep marks (\p{M}): Tamil/Telugu/Devanagari vowel signs are combining marks and
    // stripping them would corrupt the title.
    .replace(/[^\p{L}\p{N}\p{M}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenSet(value: string | null | undefined): Set<string> {
  return new Set(
    normalizeForMatch(value)
      .split(' ')
      .filter((token) => token.length > 0 && !STOP_WORDS.has(token))
  );
}

/** Sørensen–Dice coefficient over token sets (order-insensitive, tolerant of extra words). */
export function tokenSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) {
    if (b.has(token)) shared++;
  }
  return (2 * shared) / (a.size + b.size);
}

/** Collapses a name to comparable letters/digits only, so handles and spacing do not matter. */
function compactName(value: string | null | undefined): string {
  return normalizeForMatch(value).replace(/\s+/g, '');
}

/**
 * Artist match that also understands handle-style credits.
 * YouTube Music reports single artists as `@SaiAbhyankkar` while the catalogue says
 * `Sai Abhyankkar`; token similarity sees those as different names, so a credit that is
 * contained in the candidate's credit list counts as a strong match.
 */
export function artistSimilarity(targetArtist: string | undefined, candidateArtist: string | undefined): number {
  const base = tokenSimilarity(tokenSet(targetArtist || ''), tokenSet(candidateArtist || ''));
  const candidateCompact = compactName(candidateArtist);
  if (!candidateCompact) return base;

  // Try each credited artist separately: "A, B" should match a candidate credited "B, C".
  const credits = (targetArtist || '')
    .split(/[,&]|feat\.?|ft\.?/i)
    .map((credit) => compactName(credit))
    .filter((credit) => credit.length >= 5);

  if (credits.some((credit) => candidateCompact.includes(credit))) {
    return Math.max(base, 0.85);
  }
  return base;
}

export function scoreCandidate(candidate: SaavnCandidateMeta, target: SaavnMatchTarget): number {
  const targetTitle = tokenSet(target.title);
  const candidateTitle = tokenSet(candidate.title);
  let titleScore = tokenSimilarity(targetTitle, candidateTitle);

  if (normalizeForMatch(candidate.title) === normalizeForMatch(target.title)) {
    titleScore = Math.max(titleScore, 0.95);
  } else if (
    candidateTitle.size > 0 &&
    normalizeForMatch(candidate.title).startsWith(normalizeForMatch(target.title))
  ) {
    titleScore = Math.max(titleScore, 0.8);
  }

  const artistScore = artistSimilarity(target.artist, candidate.artist);

  let durationScore = 0.5;
  if (target.durationSec && candidate.duration > 0) {
    const delta = Math.abs(candidate.duration - target.durationSec);
    if (delta <= 3) durationScore = 1;
    else if (delta <= 6) durationScore = 0.7;
    else if (delta <= 12) durationScore = 0.35;
    else if (delta <= 25) durationScore = 0.15;
    else durationScore = 0;
  }

  return 0.62 * titleScore + 0.23 * artistScore + 0.15 * durationScore;
}

/**
 * YouTube Music lists labels and channels as the artist for licensed uploads ("Think Music
 * India", "Sony Music South", "Kappa TV"). Those are not performers, so they must not be
 * used to reject an otherwise exact title match.
 */
export function isLabelCredit(artist: string | null | undefined): boolean {
  if (!artist) return false;
  return /\b(music|records|studios?|entertainment|official|label|audio|tv|films?|productions?)\b/i.test(
    artist
  );
}

/**
 * Picks the candidate whose audio is the same recording as the target track.
 * Returns null when nothing is convincing — the caller must then not play a wrong song.
 */
export function pickBestMatch<T extends SaavnCandidateMeta>(candidates: T[], target: SaavnMatchTarget): T | null {
  if (!target.title || candidates.length === 0) return null;

  const targetTitle = tokenSet(target.title);
  const targetArtist = tokenSet(target.artist || '');

  let best: T | null = null;
  let bestScore = 0;

  for (const candidate of candidates) {
    const score = scoreCandidate(candidate, target);
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }

  if (!best) return null;

  const titleScore = tokenSimilarity(targetTitle, tokenSet(best.title));
  const artistScore = artistSimilarity(target.artist, best.artist);
  const durationDelta =
    target.durationSec && best.duration > 0 ? Math.abs(best.duration - target.durationSec) : null;

  const exactTitle = normalizeForMatch(best.title) === normalizeForMatch(target.title);
  // A label/channel credit carries no information about which recording this is.
  const artistKnown = targetArtist.size > 0 && !isLabelCredit(target.artist);
  const artistOk = !artistKnown || artistScore >= 0.25;

  // Catalogue copies of the same recording can differ in length (edits, extended intros), and
  // the feed's duration is often the *video* length rather than the song's. An exact title
  // with a matching artist — or with no real artist credit at all — is trusted at any length;
  // otherwise a length mismatch means we found a different version and must not play it.
  const durationOk =
    durationDelta === null ||
    durationDelta <= 12 ||
    (exactTitle && (artistScore >= 0.34 || !artistKnown));

  // Require most of the *target* title to appear in the candidate, not just a majority of the
  // union. Two-word titles that share one word ("Sait Ji" vs "Great Ji") reach 0.5 dice and
  // would otherwise play a different song from the same album, which is worse than skipping.
  // The reverse case still passes: "Kesariya" vs "Kesariya (Lofi Flip)" is 100% coverage.
  const bestTokens = tokenSet(best.title);
  let sharedTokens = 0;
  for (const token of targetTitle) {
    if (bestTokens.has(token)) sharedTokens++;
  }
  const targetCoverage = targetTitle.size > 0 ? sharedTokens / targetTitle.size : 0;
  const titleOk = targetCoverage >= 0.7 || exactTitle || titleScore >= 0.8;

  return titleOk && durationOk && (artistOk || (durationDelta !== null && durationDelta <= 4)) && bestScore >= 0.5
    ? best
    : null;
}

/**
 * Title spellings worth searching, most literal first.
 *
 * YouTube Music's feed contains video entries whose "title" is a full video heading such as
 * `| Sardar 2 | Karthi | Malavika Mohanan | PS Mithran | Sam CS`, so the song name is only one
 * of the `|` segments (or, for those entries, the artist field). Searching the literal string
 * for such a title returns nothing related, which is why tracks went silent.
 */
export function buildTitleVariants(rawTitle: string): string[] {
  const variants: string[] = [];
  const push = (value: string) => {
    const trimmed = value.replace(/^[\s|·•-]+|[\s|·•-]+$/g, '').trim();
    if (trimmed.length < 2) return;
    const key = normalizeForMatch(trimmed);
    if (!key) return;
    if (variants.some((existing) => normalizeForMatch(existing) === key)) return;
    variants.push(trimmed);
  };

  push(rawTitle);

  // Presentational suffixes name the same recording ("Film Version", "Lyrical Video").
  // Remix/cover style suffixes are deliberately not stripped: those are different audio.
  const withoutQualifier = rawTitle
    .replace(
      /\s*[([-]?\s*\b(film version|video song|full video|lyrical video|lyric video|official video|video song|video|lyrical|lyrics)\b[)\]]?\s*$/i,
      ''
    )
    .trim();
  if (withoutQualifier && normalizeForMatch(withoutQualifier) !== normalizeForMatch(rawTitle)) {
    push(withoutQualifier);
  }

  if (rawTitle.includes('|')) {
    rawTitle
      .split('|')
      .map((segment) => segment.trim())
      .filter((segment) => segment.length > 1)
      // Document order: headings read "Song | Artist | Label", so the first segment is the
      // most likely song name.
      .forEach(push);
  }

  const dashed = rawTitle.split(/\s+[-–—]\s+/);
  if (dashed.length > 1) push(dashed[0]);

  return variants;
}

export interface MatchHypothesis {
  title: string;
  artist?: string;
}

/**
 * Alternative title/artist pairs to try for a track, most likely first.
 * Capped at three so a messy title never fans out into a burst of catalogue requests.
 */
export function buildMatchHypotheses(rawTitle: string, rawArtist?: string): MatchHypothesis[] {
  const artist = (rawArtist || '').trim();
  const hypotheses: MatchHypothesis[] = [];
  const seen = new Set<string>();
  const push = (title: string, credit?: string) => {
    const key = `${normalizeForMatch(title)}|${normalizeForMatch(credit || '')}`;
    if (!normalizeForMatch(title) || seen.has(key)) return;
    seen.add(key);
    hypotheses.push({ title, artist: credit || undefined });
  };

  // Video entries list the song name in the credit field (e.g. artist "Mayil Veera" for a
  // "| Sardar 2 | Karthi | ..." heading). Only trust the swap for single, short credits.
  const singleCredit = artist && !/[,&]|feat\.?|ft\.?/i.test(artist) && artist.split(/\s+/).length <= 5;
  const swapped = Boolean(rawTitle.includes('|') && singleCredit);

  // Reserve a slot for the swap so it is never pushed out by title segments.
  for (const variant of buildTitleVariants(rawTitle).slice(0, swapped ? 2 : 3)) {
    push(variant, artist);
  }
  if (swapped) push(artist, '');

  return hypotheses.slice(0, 3);
}

/** Decrypts JioSaavn's DES-protected media URL and upgrades it to the 320 kbps rendition. */
export function decryptMediaUrl(encrypted: string, prefer320 = true): string | null {
  if (!encrypted) return null;
  try {
    const des = DES.DES.create({ type: 'decrypt', key: Buffer.from(SAAVN_DES_KEY) });
    const decrypted = Buffer.concat([
      Buffer.from(des.update(Buffer.from(encrypted, 'base64')) as ArrayLike<number>),
      Buffer.from(des.final() as ArrayLike<number>),
    ])
      .toString('utf8')
      .trim();

    if (!/^https?:\/\//.test(decrypted)) return null;

    if (prefer320) {
      return decrypted.replace(/_\d+\.mp4(\?.*)?$/, '_320.mp4$1');
    }
    return decrypted;
  } catch {
    return null;
  }
}

function toTrack(raw: any): SaavnTrack | null {
  const more = raw?.more_info || {};
  const encrypted = more.encrypted_media_url || '';
  const streamUrl = decryptMediaUrl(encrypted, more['320kbps'] === 'true');
  if (!streamUrl) return null;

  const artists: string[] = Array.isArray(more.artistMap?.primary_artists)
    ? more.artistMap.primary_artists.map((a: any) => a?.name).filter(Boolean)
    : [];
  const subtitleArtists = String(raw?.subtitle || '')
    .split(' - ')[0]
    .split(',')
    .map((s: string) => s.trim())
    .filter(Boolean);

  const artwork = typeof raw?.image === 'string' ? raw.image.replace(/150x150|50x50/, '500x500') : undefined;

  return {
    id: String(raw?.id || ''),
    title: decodeHtmlEntities(String(raw?.title || '')),
    artist: decodeHtmlEntities(artists.join(', ') || subtitleArtists.join(', ')),
    album: decodeHtmlEntities(String(more?.album || '')),
    duration: parseInt(String(more?.duration || raw?.duration || '0'), 10) || 0,
    streamUrl320: streamUrl,
    artwork,
    language: raw?.language ? String(raw.language) : undefined,
    year: raw?.year ? String(raw.year) : undefined,
  };
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&#039;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

class JioSaavnService {
  private searchCache = new Map<string, { tracks: SaavnTrack[]; expires: number }>();
  private inflightSearches = new Map<string, Promise<SaavnTrack[]>>();
  private trackCache = new Map<string, { track: SaavnTrack | null; expires: number }>();
  private albumCache = new Map<string, { tracks: SaavnTrack[]; expires: number }>();
  private inflightAlbums = new Map<string, Promise<SaavnTrack[]>>();

  public isConfigured(): boolean {
    return true;
  }

  /**
   * Finds the Saavn track that corresponds to a YouTube Music track.
   * One HTTP request on a cache miss; cached for 6 hours afterwards.
   */
  public async findTrack(
    title: string,
    artist?: string,
    durationSec?: number,
    album?: string
  ): Promise<SaavnTrack | null> {
    const cleanTitle = (title || '').trim();
    if (!cleanTitle) return null;

    const cacheKey = `${normalizeForMatch(cleanTitle)}|${normalizeForMatch(artist)}|${normalizeForMatch(
      album
    )}|${Math.round(durationSec || 0)}`;

    const cached = this.trackCache.get(cacheKey);
    if (cached && cached.expires > Date.now()) {
      return cached.track;
    }

    const hypotheses = buildMatchHypotheses(cleanTitle, artist);

    // Search every hypothesis at once (usually just one request) and match against the
    // combined candidate pool, so a messy title costs no extra round trips.
    // A rejected search means the catalogue was unreachable, not that the track is missing —
    // that distinction decides whether the result may be cached below.
    const resultSets = await Promise.allSettled(
      hypotheses.map((hypothesis) => this.search(this.buildQuery(hypothesis.title, hypothesis.artist)))
    );
    let searchFailed = resultSets.some((result) => result.status === 'rejected');

    const pool = new Map<string, SaavnTrack>();
    for (const result of resultSets) {
      if (result.status !== 'fulfilled') continue;
      for (const track of result.value) {
        if (!pool.has(track.id)) pool.set(track.id, track);
      }
    }
    const candidates = [...pool.values()];

    // Ordered by confidence: the literal title wins, cleaned variants only fill the gaps.
    let match: SaavnTrack | null = null;
    for (const hypothesis of hypotheses) {
      match = pickBestMatch(candidates, {
        title: hypothesis.title,
        artist: hypothesis.artist,
        durationSec,
      });
      if (match) break;
    }

    // Second round without the artist. An artist credit that is a distributor or a channel
    // ("T-Series Telugu", "Saregama", ...) makes the query return nothing relevant, and the
    // cost is paid only by tracks that would otherwise fail.
    if (!match && hypotheses.length > 0) {
      try {
        const bareTracks = await this.search(hypotheses[0].title);
        for (const hypothesis of hypotheses) {
          match = pickBestMatch(bareTracks, {
            title: hypothesis.title,
            artist: hypothesis.artist,
            durationSec,
          });
          if (match) break;
        }
      } catch {
        searchFailed = true;
      }
    }

    // Last pass: catalogue search ranks popular tracks above album deep cuts, so a real
    // album track can be missing from the result page entirely. Looking inside the album
    // itself finds it by name.
    let albumFailed = false;
    if (!match && album) {
      try {
        const albumTracks = await this.findAlbumTracks(album, artist);
        for (const hypothesis of hypotheses) {
          match = pickBestMatch(albumTracks, {
            title: hypothesis.title,
            artist: hypothesis.artist,
            durationSec,
          });
          if (match) break;
        }
      } catch {
        albumFailed = true;
      }
    }

    // Only cache a definitive answer. Caching a miss caused by a timeout or a rate limit would
    // silence that track for six hours after a single bad moment.
    if (!searchFailed && !albumFailed) {
      this.remember(this.trackCache, cacheKey, { track: match, expires: Date.now() + SEARCH_TTL_MS });
    }
    return match;
  }

  /** Returns the cached track for a Saavn song id, or null. */
  public getCachedByUrl(streamUrl: string): SaavnTrack | null {
    for (const entry of this.trackCache.values()) {
      if (entry.track?.streamUrl320 === streamUrl) return entry.track;
    }
    return null;
  }

  /**
   * Resolves an album name to its track list.
   *
   * Catalogue search ranks popular songs above album deep cuts, so a track that definitely
   * exists can be absent from the result page. Loading its album finds it by name instead.
   */
  private async findAlbumTracks(albumName: string, artist?: string): Promise<SaavnTrack[]> {
    const key = `${normalizeForMatch(albumName)}|${normalizeForMatch(artist)}`;

    const cached = this.albumCache.get(key);
    if (cached && cached.expires > Date.now()) return cached.tracks;

    const inflight = this.inflightAlbums.get(key);
    if (inflight) return inflight;

    const task = this.requestAlbumTracks(albumName)
      .then((tracks) => {
        this.remember(this.albumCache, key, { tracks, expires: Date.now() + SEARCH_TTL_MS });
        return tracks;
      })
      .finally(() => {
        this.inflightAlbums.delete(key);
      });

    this.inflightAlbums.set(key, task);
    return task;
  }

  private async requestAlbumTracks(albumName: string): Promise<SaavnTrack[]> {
    const search = await this.requestApi({
      __call: 'search.getAlbumResults',
      q: albumName,
      p: '1',
      n: '6',
    });

    const results: any[] = Array.isArray(search?.results) ? search.results : [];
    const targetAlbum = tokenSet(albumName);

    // Only the two closest album matches are opened: unrelated albums are pure extra latency.
    const albums = results
      .filter((album) => album?.id)
      .map((album) => ({
        id: String(album.id),
        score: tokenSimilarity(targetAlbum, tokenSet(String(album.title || ''))),
      }))
      .filter((album) => album.score >= 0.4)
      .sort((a, b) => b.score - a.score)
      .slice(0, 2);

    const lists = await Promise.all(
      albums.map(async (album) => {
        try {
          const details = await this.requestApi({
            __call: 'content.getAlbumDetails',
            albumid: album.id,
          });
          return Array.isArray(details?.list) ? details.list : [];
        } catch {
          return [];
        }
      })
    );

    const tracks = new Map<string, SaavnTrack>();
    for (const raw of lists.flat()) {
      if (raw?.type && raw.type !== 'song') continue;
      const track = toTrack(raw);
      if (track && !tracks.has(track.id)) tracks.set(track.id, track);
    }
    return [...tracks.values()];
  }

  private buildQuery(title: string, artist?: string): string {
    // A label credit in the query buries the song ("Ezhutha Kadhaiyo Think Music" returns
    // nothing useful), so search on the title alone in that case.
    if (isLabelCredit(artist)) {
      return title.replace(/\(.*?\)|\[.*?\]/g, ' ').replace(/\s+/g, ' ').trim();
    }

    const primaryArtist = (artist || '')
      .split(/[,&]|feat\.?|ft\.?/i)[0]
      .replace(/\(.*?\)|\[.*?\]/g, ' ')
      .trim();

    const cleanTitle = title.replace(/\(.*?\)|\[.*?\]/g, ' ').replace(/\s+/g, ' ').trim();
    return primaryArtist ? `${cleanTitle} ${primaryArtist}` : cleanTitle;
  }

  private async search(query: string): Promise<SaavnTrack[]> {
    const key = normalizeForMatch(query);
    if (!key) return [];

    const cached = this.searchCache.get(key);
    if (cached && cached.expires > Date.now()) {
      return cached.tracks;
    }

    const inflight = this.inflightSearches.get(key);
    if (inflight) return inflight;

    const task = this.requestSearch(query)
      .then((tracks) => {
        this.remember(this.searchCache, key, { tracks, expires: Date.now() + SEARCH_TTL_MS });
        return tracks;
      })
      .finally(() => {
        this.inflightSearches.delete(key);
      });

    this.inflightSearches.set(key, task);
    return task;
  }

  private async requestApi(params: Record<string, string>): Promise<any> {
    const query = new URLSearchParams({
      _format: 'json',
      _marker: '0',
      api_version: '4',
      ctx: 'web6dot0',
      ...params,
    });

    const response = await fetch(`${SAAVN_API}?${query.toString()}`, {
      headers: {
        'User-Agent': SAAVN_USER_AGENT,
        Accept: 'application/json, text/plain, */*',
        Referer: 'https://www.jiosaavn.com/',
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`JioSaavn ${params.__call} HTTP ${response.status}`);
    }

    return response.json();
  }

  private async requestSearch(query: string): Promise<SaavnTrack[]> {
    const payload = await this.requestApi({
      __call: 'search.getResults',
      q: query,
      n: '12',
      p: '1',
    });

    const results: any[] = Array.isArray(payload?.results) ? payload.results : [];

    const tracks: SaavnTrack[] = [];
    for (const raw of results) {
      // Search results mix songs, albums and playlists — only songs carry media URLs.
      if (raw?.type && raw.type !== 'song') continue;
      const track = toTrack(raw);
      if (track) tracks.push(track);
    }
    return tracks;
  }

  private remember<K, V extends { expires: number }>(cache: Map<K, V>, key: K, value: V): void {
    if (cache.size >= MAX_CACHE_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, value);
  }
}

export const jioSaavnService = new JioSaavnService();

/** Hosts whose audio can be played directly by the client (CORS + Range + no auth). */
export function isDirectPlayableCdnUrl(url: string): boolean {
  try {
    const { hostname, protocol } = new URL(url);
    return protocol === 'https:' && /(^|\.)saavncdn\.com$/.test(hostname);
  } catch {
    return false;
  }
}
