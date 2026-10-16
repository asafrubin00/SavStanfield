import { supabase } from './db';
import { norm } from './util';
import type { Links } from './types';

/** Call one of the music APIs through our proxy (/api/ext). */
export async function ext<T = unknown>(src: string, path: string, params: Record<string, string | number | undefined> = {}): Promise<T> {
  const qs = new URLSearchParams({ src, path });
  for (const [k, v] of Object.entries(params)) if (v !== undefined) qs.set(k, String(v));
  const headers: Record<string, string> = {};
  if (supabase) {
    const { data } = await supabase.auth.getSession();
    if (data.session) headers.Authorization = `Bearer ${data.session.access_token}`;
  }
  const r = await fetch(`/api/ext?${qs}`, { headers });
  const text = await r.text();
  let body: unknown = null;
  try { body = JSON.parse(text); } catch { /* non-JSON */ }
  if (!r.ok) throw new Error((body as { error?: string })?.error ?? `${src} returned ${r.status}`);
  return body as T;
}

// ——— Simple per-source pacing so we stay inside each API's rate limits ———
const gaps: Record<string, number> = { itunes: 3100, mb: 1100, deezer: 120, genius: 250, wiki: 100, wikidata: 100, youtube: 200 };
const lastCall: Record<string, Promise<void>> = {};
export function paced<T>(src: string, fn: () => Promise<T>): Promise<T> {
  const prev = lastCall[src] ?? Promise.resolve();
  const run = prev.then(fn);
  lastCall[src] = run.then(() => new Promise<void>((r) => setTimeout(r, gaps[src] ?? 0)), () => new Promise<void>((r) => setTimeout(r, gaps[src] ?? 0)));
  return run;
}
/** Paced call with a couple of retries when a service says it's busy or rate-limited. */
const call = async <T,>(src: string, path: string, params?: Record<string, string | number | undefined>): Promise<T> => {
  for (let attempt = 0; ; attempt++) {
    try { return await paced(src, () => ext<T>(src, path, params)); }
    catch (e) {
      const m = (e as Error).message;
      if (attempt >= 2 || !/busy|rate|429|503|try again/i.test(m)) throw e;
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    }
  }
};

// ——— Matching helpers ———
const stripSuffix = (t: string) => t.replace(/\s*-\s*(single|ep)$/i, '').replace(/\s*[([](deluxe|explicit|clean|remaster(ed)?|expanded)[^)\]]*[)\]]/gi, '').trim();
export function titleScore(a: string, b: string) {
  const x = norm(stripSuffix(a)), y = norm(stripSuffix(b));
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.startsWith(y) || y.startsWith(x)) return 0.8;
  const xs = new Set(x.split(' ')), ys = y.split(' ');
  const hit = ys.filter((w) => xs.has(w)).length;
  return (hit / Math.max(xs.size, ys.length)) * 0.7;
}
export const artistMatch = (a: string, b: string) => { const x = norm(a), y = norm(b); return !!x && !!y && (x === y || x.includes(y) || y.includes(x)); };
export const bigArt = (u?: string | null) => u?.replace(/\/\d+x\d+bb\./, '/1200x1200bb.');

// ——— Apple (iTunes Search API: free, no key) ———
export interface AppleAlbum { id: number; title: string; artist: string; artistId?: number; artwork?: string; date?: string; url: string; tracks?: number; genre?: string; kind: string }
interface ItunesRow { wrapperType: string; collectionType?: string; collectionId: number; collectionName: string; artistName: string; artistId?: number; artworkUrl100?: string; releaseDate?: string; collectionViewUrl: string; trackCount?: number; primaryGenreName?: string; trackId?: number; trackName?: string; trackNumber?: number; discNumber?: number; trackTimeMillis?: number; trackViewUrl?: string; artistLinkUrl?: string; kind?: string }
const toAlbum = (r: ItunesRow): AppleAlbum => {
  const kind = /- single$/i.test(r.collectionName) ? 'Single' : /- ep$/i.test(r.collectionName) ? 'EP' : 'Album';
  return { id: r.collectionId, title: stripSuffix(r.collectionName), artist: r.artistName, artistId: r.artistId, artwork: bigArt(r.artworkUrl100), date: r.releaseDate?.slice(0, 10), url: r.collectionViewUrl?.split('?')[0], tracks: r.trackCount, genre: r.primaryGenreName, kind };
};
/** Apple's search chokes on punctuation (e.g. "DRILLMATIC: Heart vs. Mind"), so search on plain words. */
export const searchTerm = (s: string) => s.replace(/[^\p{L}\p{N}\s$&']/gu, ' ').replace(/\s+/g, ' ').trim();
export async function appleSearchAlbums(term: string, limit = 12, country = 'GB'): Promise<AppleAlbum[]> {
  const r = await call<{ results: ItunesRow[] }>('itunes', 'search', { term: searchTerm(term), entity: 'album', media: 'music', limit, country });
  return r.results.map(toAlbum);
}
/** Best Apple match for a release: UK store first, then US (some releases are region-locked). */
export async function appleFindAlbum(title: string, artist: string): Promise<AppleAlbum | undefined> {
  for (const country of ['GB', 'US']) {
    const hit = (await appleSearchAlbums(`${artist} ${title}`, 15, country)).find((x) => titleScore(x.title, title) >= 0.8 && artistMatch(x.artist, artist));
    if (hit) return hit;
  }
  return undefined;
}
export async function appleSearchSongs(term: string, limit = 12) {
  const r = await call<{ results: ItunesRow[] }>('itunes', 'search', { term, entity: 'song', media: 'music', limit });
  return r.results.map((s) => ({ id: s.trackId!, title: s.trackName!, artist: s.artistName, album: s.collectionName, albumId: s.collectionId, artwork: bigArt(s.artworkUrl100), date: s.releaseDate?.slice(0, 10), url: s.trackViewUrl?.split('?')[0] ?? '' }));
}
export async function appleSearchArtists(term: string, limit = 8) {
  const r = await call<{ results: ItunesRow[] }>('itunes', 'search', { term, entity: 'musicArtist', media: 'music', limit });
  return r.results.map((a) => ({ id: a.artistId!, name: a.artistName, url: a.artistLinkUrl?.split('?')[0] ?? '', genre: a.primaryGenreName }));
}
export async function appleAlbumTracks(collectionId: number) {
  let r = await call<{ results: ItunesRow[] }>('itunes', 'lookup', { id: collectionId, entity: 'song', limit: 200 });
  if (r.results.length < 2) r = await call<{ results: ItunesRow[] }>('itunes', 'lookup', { id: collectionId, entity: 'song', limit: 200, country: 'US' });
  return r.results.filter((x) => x.wrapperType === 'track').map((t) => ({ id: t.trackId!, title: t.trackName!, artist: t.artistName, number: t.trackNumber ?? null, disc: t.discNumber ?? null, ms: t.trackTimeMillis ?? null, url: t.trackViewUrl?.split('?')[0] ?? '' }));
}
export async function appleArtistAlbums(artistId: number): Promise<AppleAlbum[]> {
  const r = await call<{ results: ItunesRow[] }>('itunes', 'lookup', { id: artistId, entity: 'album', limit: 200 });
  return r.results.filter((x) => x.wrapperType === 'collection').map(toAlbum);
}

// ——— MusicBrainz (free; 1 request a second) ———
export interface MBGroup { id: string; title: string; type: string; secondary: string[]; date?: string; artist: string; score?: number }
interface MBGroupRaw { id: string; title: string; 'primary-type'?: string; 'secondary-types'?: string[]; 'first-release-date'?: string; 'artist-credit'?: { name: string; joinphrase?: string }[]; score?: number }
const toGroup = (g: MBGroupRaw): MBGroup => ({
  id: g.id, title: g.title, type: g['primary-type'] ?? 'Other', secondary: g['secondary-types'] ?? [], date: g['first-release-date'] || undefined,
  artist: (g['artist-credit'] ?? []).map((c) => c.name + (c.joinphrase ?? '')).join(''), score: g.score,
});
const q = (s: string) => `"${s.replace(/["\\]/g, ' ')}"`;
export async function mbSearchGroups(title: string, artist?: string): Promise<MBGroup[]> {
  const query = `releasegroup:${q(title)}${artist ? ` AND artist:${q(artist)}` : ''}`;
  const r = await call<{ 'release-groups': MBGroupRaw[] }>('mb', 'release-group', { query, limit: 10 });
  return r['release-groups'].map(toGroup);
}
export async function mbSearchArtists(name: string) {
  const r = await call<{ artists: { id: string; name: string; disambiguation?: string; country?: string; type?: string; score: number }[] }>('mb', 'artist', { query: `artist:${q(name)}`, limit: 8 });
  return r.artists;
}
export async function mbArtistGroups(mbid: string): Promise<MBGroup[]> {
  const all: MBGroup[] = [];
  for (let offset = 0; offset < 1000; offset += 100) {
    const r = await call<{ 'release-groups': MBGroupRaw[]; 'release-group-count': number }>('mb', 'release-group', { artist: mbid, limit: 100, offset });
    all.push(...r['release-groups'].map(toGroup));
    if (all.length >= r['release-group-count'] || !r['release-groups'].length) break;
  }
  return all;
}
interface MBRel { type: string; url?: { resource: string } }
/** Turn MusicBrainz URL relationships into our link keys. */
export async function mbLinks(kind: 'artist' | 'release-group', mbid: string): Promise<Links & { wikidata?: string }> {
  const r = await call<{ relations?: MBRel[] }>('mb', `${kind}/${mbid}`, { inc: 'url-rels' });
  const out: Links & { wikidata?: string } = { musicbrainz: `https://musicbrainz.org/${kind}/${mbid}` };
  for (const rel of r.relations ?? []) {
    const u = rel.url?.resource; if (!u) continue;
    const h = new URL(u).hostname.replace(/^www\./, '');
    if (h.endsWith('wikidata.org')) out.wikidata = u.split('/').pop();
    else if (h === 'en.wikipedia.org') out.wikipedia = u;
    else if (h === 'genius.com') out.genius ??= u;
    else if (h === 'discogs.com') out.discogs ??= u;
    else if (h === 'rateyourmusic.com') out.rym ??= u;
    else if (h === 'albumoftheyear.org') out.aoty ??= u;
    else if (h === 'music.apple.com' || h === 'itunes.apple.com') out.apple ??= u;
    else if (h === 'open.spotify.com') out.spotify ??= u;
    else if (h === 'youtube.com' || h === 'music.youtube.com') out.youtube ??= u;
    else if (h === 'instagram.com') out.instagram ??= u;
    else if (rel.type === 'official homepage') out.website ??= u;
  }
  return out;
}

// ——— Wikipedia / Wikidata ———
export async function wikidataToWikipedia(qid: string): Promise<string | undefined> {
  const r = await call<{ entities: Record<string, { sitelinks?: { enwiki?: { title: string } } }> }>('wikidata', 'w/api.php', { action: 'wbgetentities', ids: qid, props: 'sitelinks', sitefilter: 'enwiki', format: 'json' });
  const t = r.entities[qid]?.sitelinks?.enwiki?.title;
  return t ? `https://en.wikipedia.org/wiki/${encodeURIComponent(t.replace(/ /g, '_'))}` : undefined;
}
export async function wikiSearch(text: string) {
  const r = await call<{ pages: { key: string; title: string; description?: string; thumbnail?: { url: string } }[] }>('wiki', 'w/rest.php/v1/search/page', { q: text, limit: 6 });
  return r.pages.map((p) => ({ title: p.title, description: p.description ?? '', url: `https://en.wikipedia.org/wiki/${encodeURIComponent(p.key)}` }));
}
export async function wikiSummary(url: string) {
  const title = decodeURIComponent(url.split('/wiki/')[1] ?? '');
  if (!title) return null;
  const r = await call<{ extract?: string; thumbnail?: { source: string }; originalimage?: { source: string } }>('wiki', `api/rest_v1/page/summary/${encodeURIComponent(title)}`);
  return { extract: r.extract ?? '', image: r.originalimage?.source ?? r.thumbnail?.source };
}

// ——— Deezer (free, no key; good artist photos and covers) ———
export async function deezerArtist(name: string) {
  const r = await call<{ data: { id: number; name: string; picture_xl: string; link: string; nb_fan: number }[] }>('deezer', 'search/artist', { q: name, limit: 5 });
  return r.data.find((a) => norm(a.name) === norm(name)) ?? null;
}
export async function deezerAlbum(title: string, artist: string) {
  const r = await call<{ data: { id: number; title: string; cover_xl: string; link: string; artist: { name: string } }[] }>('deezer', 'search/album', { q: `artist:"${artist}" album:"${stripSuffix(title)}"`, limit: 5 });
  return r.data?.find((a) => titleScore(a.title, title) >= 0.8 && artistMatch(a.artist.name, artist)) ?? null;
}

// ——— Genius (free token) ———
export interface GeniusHit { id: number; title: string; full_title: string; url: string; artist: string; artistId: number; artistUrl: string; image?: string; artistImage?: string }
interface GeniusArtistRaw { id: number; name: string; url: string; image_url?: string }
export async function geniusSearch(text: string): Promise<GeniusHit[]> {
  const r = await call<{ response: { hits: { type: string; result: { id: number; title: string; full_title: string; url: string; song_art_image_url?: string; primary_artist: GeniusArtistRaw } }[] } }>('genius', 'search', { q: searchTerm(text) });
  return r.response.hits.filter((h) => h.type === 'song').map(({ result: s }) => ({ id: s.id, title: s.title, full_title: s.full_title, url: s.url, artist: s.primary_artist.name, artistId: s.primary_artist.id, artistUrl: s.primary_artist.url, image: s.song_art_image_url, artistImage: s.primary_artist.image_url }));
}
export async function geniusSong(id: number) {
  const r = await call<{ response: { song: { url: string; release_date?: string; album?: { id: number; name: string; url: string; cover_art_url?: string } | null; producer_artists: GeniusArtistRaw[]; featured_artists: GeniusArtistRaw[]; writer_artists: GeniusArtistRaw[]; media?: { provider: string; url: string }[] } } }>('genius', `songs/${id}`, { text_format: 'plain' });
  const s = r.response.song;
  return { url: s.url, album: s.album ?? null, producers: s.producer_artists, featured: s.featured_artists, youtube: s.media?.find((m) => m.provider === 'youtube')?.url, release_date: s.release_date };
}
export async function geniusArtist(id: number) {
  const r = await call<{ response: { artist: { id: number; name: string; url: string; image_url?: string; description?: { plain?: string }; alternate_names?: string[] } } }>('genius', `artists/${id}`, { text_format: 'plain' });
  return r.response.artist;
}

// ——— YouTube (free key, ~100 searches a day) ———
export async function youtubeSearch(text: string, type: 'video' | 'playlist' = 'video') {
  const r = await call<{ items: { id: { videoId?: string; playlistId?: string }; snippet: { title: string; channelTitle: string; thumbnails: { medium?: { url: string } } } }[] }>('youtube', 'search', { part: 'snippet', q: text, type, maxResults: 6 });
  return r.items.map((i) => {
    const id = i.id.videoId ?? i.id.playlistId!;
    return { id, title: i.snippet.title, channel: i.snippet.channelTitle, thumb: i.snippet.thumbnails.medium?.url, url: i.id.videoId ? `https://www.youtube.com/watch?v=${id}` : `https://www.youtube.com/playlist?list=${id}` };
  });
}
export function youtubeEmbed(url?: string | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    const list = u.searchParams.get('list');
    if (u.pathname === '/playlist' && list) return `https://www.youtube-nocookie.com/embed/videoseries?list=${list}`;
    const v = u.searchParams.get('v') ?? (u.hostname === 'youtu.be' ? u.pathname.slice(1) : null);
    return v ? `https://www.youtube-nocookie.com/embed/${v}` : null;
  } catch { return null; }
}
export function appleEmbed(url?: string | null): string | null {
  if (!url || !/music\.apple\.com|itunes\.apple\.com/.test(url)) return null;
  return url.replace(/^https:\/\/(music|itunes)\.apple\.com/, 'https://embed.music.apple.com');
}
