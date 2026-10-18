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
const gaps: Record<string, number> = { itunes: 3100, mb: 1100, deezer: 120, genius: 250, wiki: 100, wikidata: 100, youtube: 200, caa: 150, soundcloud: 400, scoembed: 200 };
const lastCall: Record<string, Promise<void>> = {};
export function paced<T>(src: string, fn: () => Promise<T>): Promise<T> {
  const prev = lastCall[src] ?? Promise.resolve();
  const run = prev.then(fn);
  lastCall[src] = run.then(() => new Promise<void>((r) => setTimeout(r, gaps[src] ?? 0)), () => new Promise<void>((r) => setTimeout(r, gaps[src] ?? 0)));
  return run;
}
/** Paced call with a couple of retries when a service says it's busy or rate-limited. */
export const call = async <T,>(src: string, path: string, params?: Record<string, string | number | undefined>): Promise<T> => {
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
// ——— Fuzzy matching (second pass) ———
/** Lower-case, no accents, no punctuation or spaces, no leading "the", no edition suffixes. */
export const compact = (s: string) => norm(stripSuffix(s)).replace(/^the /, '').replace(/\s+/g, '');
function dice(a: string, b: string) {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const grams = new Map<string, number>();
  for (let i = 0; i < a.length - 1; i++) { const g = a.slice(i, i + 2); grams.set(g, (grams.get(g) ?? 0) + 1); }
  let hit = 0;
  for (let i = 0; i < b.length - 1; i++) { const g = b.slice(i, i + 2); const n = grams.get(g) ?? 0; if (n) { hit++; grams.set(g, n - 1); } }
  return (2 * hit) / (a.length + b.length - 2);
}
/** 0–1 similarity that shrugs off spacing, hyphens, punctuation, "The" and small typos. */
export function fuzzy(a: string, b: string) {
  const x = compact(a), y = compact(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const [s, l] = x.length < y.length ? [x, y] : [y, x];
  if (l.includes(s) && s.length / l.length >= 0.6) return 0.9;
  return dice(x, y);
}
/** Best similarity between a candidate artist and any artist in a credit like "A & B". */
export function fuzzyArtist(credit: string, candidate: string) {
  const parts = [credit, ...credit.split(/\s*(?:&|,|\bx\b|\bas\b|feat\.?)\s*/i)].map((p) => p.trim()).filter(Boolean);
  const cands = [candidate, ...candidate.split(/\s*(?:&|,|\bx\b|feat\.?)\s*/i)].map((p) => p.trim()).filter(Boolean);
  let best = 0;
  for (const p of parts) for (const c of cands) best = Math.max(best, fuzzy(p, c));
  return best;
}
/** Title variants: without (parentheticals), the part after a colon, and without "Artist's" / "Artist Presents" prefixes. */
function titleVariants(t: string, artist: string) {
  const out = new Set([t]);
  const noParens = t.replace(/\s*[([][^)\]]*[)\]]/g, '').trim(); if (noParens) out.add(noParens);
  for (const v of [...out]) { const i = v.lastIndexOf(':'); if (i > 0 && v.length - i > 4) out.add(v.slice(i + 1).trim()); }
  for (const name of artist.split(/\s*(?:&|,)\s*/)) {
    const re = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\$]/g, '\\$&')}(?:'s|’s)?\\s+(?:presents\\s+)?`, 'i');
    for (const v of [...out]) { const s = v.replace(re, '').trim(); if (s && s !== v) out.add(s); }
  }
  return [...out];
}
/** Title similarity using the variants above on the candidate side, plain on ours (minus parentheticals). */
export function fuzzyTitle(candidate: string, ours: string, candArtist: string) {
  const mine = [ours, ours.replace(/\s*[([][^)\]]*[)\]]/g, '').trim()].filter(Boolean);
  let best = 0;
  for (const c of titleVariants(candidate, candArtist)) for (const m of mine) best = Math.max(best, fuzzy(c, m));
  return best;
}
export const TITLE_OK = 0.85, ARTIST_OK = 0.7;
/** Pick the best candidate that clears both thresholds. */
export function bestMatch<T>(items: T[], title: string, artist: string, get: (t: T) => { title: string; artist: string }) {
  let best: { item: T; score: number } | null = null;
  for (const it of items) {
    const g = get(it); const t = fuzzyTitle(g.title, title, g.artist);
    // Compilations often list "Various Artists": accept only on an exact, reasonably long title.
    const va = /^various( artists)?$/i.test(g.artist.trim()) && t === 1 && compact(title).length >= 8;
    const a = va ? ARTIST_OK : fuzzyArtist(artist, g.artist);
    if (t < TITLE_OK || a < ARTIST_OK) continue;
    const score = t * 0.6 + a * 0.4;
    if (!best || score > best.score) best = { item: it, score };
  }
  return best;
}

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

export interface DeezerAlbum { id: number; title: string; cover_xl: string; cover_medium: string; link: string; artist: { name: string }; record_type?: string }
/** Plain (unquoted) Deezer album search — for fuzzy matching. */
export async function deezerSearchAlbums(q: string, limit = 10): Promise<DeezerAlbum[]> {
  const r = await call<{ data?: DeezerAlbum[] }>('deezer', 'search/album', { q: searchTerm(q), limit });
  return r.data ?? [];
}

/** Loose MusicBrainz release-group search (no exact-phrase quoting). */
export async function mbSearchGroupsLoose(title: string, artist: string): Promise<MBGroup[]> {
  const words = (s: string) => searchTerm(s).replace(/[+\-!(){}[\]^"~*?:\\/]/g, ' ').trim();
  const r = await call<{ 'release-groups': MBGroupRaw[] }>('mb', 'release-group', { query: `releasegroup:(${words(title)}) AND artist:(${words(artist)})`, limit: 10 });
  return r['release-groups'].map(toGroup);
}

/** Front cover from the Cover Art Archive for a MusicBrainz release group, if one exists. */
export async function caaCover(mbid: string): Promise<string | null> {
  try {
    const r = await call<{ images: { front: boolean; image: string; thumbnails: Record<string, string> }[] }>('caa', `release-group/${mbid}`);
    const f = r.images.find((i) => i.front) ?? r.images[0];
    return f ? (f.thumbnails['500'] ?? f.thumbnails.large ?? f.image).replace(/^http:/, 'https:') : null;
  } catch { return null; }
}
export const caaThumb = (mbid: string) => `https://coverartarchive.org/release-group/${mbid}/front-250`;

// ——— Labels ———
/** "℗ 2016 Def Jam Recordings, a division of UMG Recordings, Inc." → ["Def Jam Recordings"] */
export function labelsFromCopyright(c?: string | null): string[] {
  if (!c) return [];
  let s = c.replace(/^[\s℗©(Pp)]+/u, '').replace(/^\(?[pc]\)?\s*/i, '').replace(/^\d{4}(\s*[-–]\s*\d{4})?\s*/, '');
  s = s.split(/,\s*(a division|a unit|an? \w+ company|under exclusive|distributed|marketed|inc\b|llc\b)/i)[0];
  s = s.split(/\s+(under exclusive|exclusively licensed|distributed by|marketed by|in association with)\b/i)[0];
  return splitLabels(s);
}
export const splitLabels = (s: string) => s.split(/\s*\/\s*|\s*;\s*|\s+x\s+/i).map((x) => x.replace(/,?\s+(inc|llc|ltd|limited|corp|corporation)\.?$/i, '').replace(/[.,]+$/, '').trim()).filter((x) => x.length > 1 && !/^(\[?no label\]?|not on label|self[- ]released|independent)$/i.test(x));

export async function deezerAlbumLabel(id: number): Promise<string[]> {
  const r = await call<{ label?: string; error?: unknown }>('deezer', `album/${id}`);
  return r.label ? splitLabels(r.label) : [];
}
export async function appleAlbumLabel(id: number): Promise<string[]> {
  const r = await call<{ results: { copyright?: string }[] }>('itunes', 'lookup', { id, entity: 'album' });
  return labelsFromCopyright(r.results[0]?.copyright);
}
export async function mbGroupLabels(mbid: string): Promise<string[]> {
  const r = await call<{ releases: { status?: string; date?: string; country?: string; 'label-info'?: { label?: { name: string } }[] }[] }>('mb', 'release', { 'release-group': mbid, inc: 'labels', limit: 25 });
  // The original release: earliest dated official one with a label, US first on ties
  const withLabel = r.releases.filter((x) => x['label-info']?.some((li) => li.label?.name && !/no label/i.test(li.label.name)));
  const rank = (x: typeof withLabel[0]) => `${x.status === 'Official' ? 0 : 1}${x.date || '9999'}${x.country === 'US' ? 0 : x.country === 'XW' ? 1 : 2}`;
  const rel = withLabel.sort((a, b) => rank(a).localeCompare(rank(b)))[0];
  return [...new Set((rel?.['label-info'] ?? []).map((li) => li.label?.name ?? '').flatMap(splitLabels))];
}

// ——— SoundCloud ———
/** Embed + artwork for a pasted SoundCloud URL (no key needed). */
export async function soundcloudOembed(url: string): Promise<{ title: string; author: string; thumb?: string; html: string } | null> {
  try {
    const r = await ext<{ title: string; author_name: string; thumbnail_url?: string; html: string }>('scoembed', '', { url });
    return { title: r.title, author: r.author_name, thumb: r.thumbnail_url?.replace(/-(large|t300x300|t500x500)\./, '-t500x500.'), html: r.html };
  } catch { return null; }
}
export const isSoundcloud = (u?: string | null) => !!u && /^https?:\/\/(www\.|m\.|on\.)?soundcloud\.com\//i.test(u);
export function soundcloudEmbed(url?: string | null) {
  return isSoundcloud(url) ? `https://w.soundcloud.com/player/?url=${encodeURIComponent(url!)}&color=%232a3fd1&visual=true&show_comments=false` : null;
}
export interface SCItem { id: number; kind: 'playlist' | 'track'; title: string; artist: string; url: string; artwork?: string; year?: string; tracks?: number }
interface SCRaw { id: number; title: string; permalink_url: string; artwork_url?: string | null; user?: { username: string; avatar_url?: string }; created_at?: string; release_year?: number; track_count?: number; playlist_type?: string }
const scArt = (u?: string | null) => u ? u.replace(/-(large|t300x300)\./, '-t500x500.') : undefined;
/** Whether SoundCloud search is set up on the server (it needs a paid Artist Pro app). Checked once per visit. */
let scEnabled: Promise<boolean> | null = null;
export function soundcloudSearchEnabled(): Promise<boolean> {
  scEnabled ??= ext('soundcloud', 'playlists', { q: 'test', limit: 1 }).then(() => true, (e: Error) => !/not set up/i.test(e.message));
  return scEnabled;
}
/** Search SoundCloud albums/playlists (and tracks for singles). Needs SoundCloud app keys on the server. */
export async function soundcloudSearch(q: string, kinds: ('playlist' | 'track')[] = ['playlist', 'track']): Promise<SCItem[]> {
  const out: SCItem[] = [];
  for (const kind of kinds) {
    const r = await call<SCRaw[] | { collection: SCRaw[] }>('soundcloud', kind === 'playlist' ? 'playlists' : 'tracks', { q: searchTerm(q), limit: 10, linked_partitioning: 'true', access: 'playable' });
    const list = Array.isArray(r) ? r : r.collection ?? [];
    out.push(...list.map((x) => ({ id: x.id, kind, title: x.title, artist: x.user?.username ?? '', url: x.permalink_url, artwork: scArt(x.artwork_url ?? x.user?.avatar_url), year: x.release_year ? String(x.release_year) : x.created_at?.slice(0, 4), tracks: x.track_count })));
  }
  return out;
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
