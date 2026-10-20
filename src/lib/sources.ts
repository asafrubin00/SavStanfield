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
// Edition tags that don't change which album it is…
const EDITION = /\b(deluxe|expanded|remaster(ed)?|anniversary|special|bonus|explicit|collector'?s?|platinum|reissue|edition|super|complete|uncut|bonus tracks?)\b/i;
// …and versions that are a different thing from the album itself
const VARIANT = /\b(instrumentals?|acapellas?|a cappella|clean|edited|radio|live|remix(es)?|remixed|mixed|screwed|chopped|slowed|reverb|sped up|karaoke|demos?|tribute|covers?|commentary|interview|lo-?fi|piano|orchestral|unplugged|8-?bit|lullaby|reimagined)\b/i;
const ROMAN = /\b(ii|iii|iv|vi|vii|viii|ix|xi|xii|xx)\b/g;
/** Drop " - Single/EP", "(feat. …)" and edition-only brackets/suffixes; keep anything that makes it a different release. */
export function cleanTitle(t: string) {
  let s = t.replace(/\s*-\s*(single|ep)$/i, '');
  s = s.replace(/\s*[([]([^)\]]*)[)\]]/g, (m, inner: string) => ((EDITION.test(inner) && !VARIANT.test(inner)) || /^\s*(feat|ft|with)\b/i.test(inner) ? '' : m));
  s = s.replace(/\s+[-–—]\s+([^-–—]+)$/, (m, inner: string) => (EDITION.test(inner) && !VARIANT.test(inner) ? '' : m));
  return s.trim();
}
/** True when two titles can't be the same release: a sequel number, a "Vol. 2", or an instrumental/live/clean version. */
export function incompatible(cand: string, ours: string) {
  const a = norm(cleanTitle(cand)), b = norm(cleanTitle(ours));
  if (VARIANT.test(a) !== VARIANT.test(b)) return true;
  const nums = (s: string) => [...(s.match(/\d+/g) ?? []), ...(s.match(ROMAN) ?? [])].join(',');
  return nums(a) !== nums(b);
}
/** 1 = same title, 0.9 = same apart from a small typo; anything else is below the 0.85 bar. */
export function titleScore(cand: string, ours: string) {
  const x = norm(cleanTitle(cand)), y = norm(cleanTitle(ours));
  if (!x || !y) return 0;
  if (incompatible(cand, ours)) return 0;
  const cx = x.replace(/\s+/g, '').replace(/^the/, ''), cy = y.replace(/\s+/g, '').replace(/^the/, '');
  if (cx === cy) return 1;
  if (cx.startsWith(cy) || cy.startsWith(cx)) return 0.6; // one title is the other plus extra words ("Tha Carter" vs "Tha Carter V")
  const d = dice(cx, cy);
  if (d >= 0.88 && Math.abs(cx.length - cy.length) <= 2) return 0.9; // typo-level difference, no extra words
  return Math.min(d, 0.6);
}
/** Each name in a credit ("Future & Lil Uzi Vert" → future, lil uzi vert), plus the whole credit. */
const creditNames = (s: string) => [s, ...s.split(/\s*(?:&|,|\+|\/|\bx\b|\bwith\b|\bfeat\.?|\bft\.?|\bfeaturing\b)\s*/i)].map((p) => norm(p).replace(/^the /, '')).filter(Boolean);
/** Same artist, or one of the names in a joint credit. Whole names only — "Future" is not "Future Hunger". */
export const artistMatch = (a: string, b: string) => { const B = creditNames(b); return creditNames(a).some((x) => B.includes(x)); };
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
  const x = compact(cleanTitle(a)), y = compact(cleanTitle(b));
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (incompatible(a, b)) return 0;
  const [s, l] = x.length < y.length ? [x, y] : [y, x];
  if (l.includes(s) && s.length / l.length >= 0.8) return 0.86;
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

/** Apple song link: album page with ?i=<song id> (which is what plays that song), minus tracking params. */
export function songUrl(u?: string) {
  if (!u) return '';
  try { const x = new URL(u); const i = x.searchParams.get('i'); return `${x.origin}${x.pathname}${i ? `?i=${i}` : ''}`; } catch { return u; }
}
export const bigArt = (u?: string | null) => u?.replace(/\/\d+x\d+bb\./, '/1200x1200bb.');

// ——— Apple (iTunes Search API: free, no key) ———
export interface AppleAlbum { id: number; title: string; artist: string; artistId?: number; artwork?: string; date?: string; url: string; tracks?: number; genre?: string; kind: string; explicitness?: string; country?: string }
interface ItunesRow { wrapperType: string; collectionType?: string; collectionId: number; collectionName: string; artistName: string; artistId?: number; artworkUrl100?: string; releaseDate?: string; collectionViewUrl: string; collectionExplicitness?: string; trackCount?: number; primaryGenreName?: string; trackId?: number; trackName?: string; trackNumber?: number; discNumber?: number; trackTimeMillis?: number; trackViewUrl?: string; artistLinkUrl?: string; kind?: string }
const toAlbum = (r: ItunesRow): AppleAlbum => {
  const kind = /- single$/i.test(r.collectionName) ? 'Single' : /- ep$/i.test(r.collectionName) ? 'EP' : 'Album';
  return { id: r.collectionId, title: r.collectionName.replace(/\s*-\s*(single|ep)$/i, ''), explicitness: r.collectionExplicitness, artist: r.artistName, artistId: r.artistId, artwork: bigArt(r.artworkUrl100), date: r.releaseDate?.slice(0, 10), url: r.collectionViewUrl?.split('?')[0], tracks: r.trackCount, genre: r.primaryGenreName, kind };
};
/** Apple's search chokes on punctuation (e.g. "DRILLMATIC: Heart vs. Mind"), so search on plain words. */
export const searchTerm = (s: string) => s.replace(/[^\p{L}\p{N}\s$&']/gu, ' ').replace(/\s+/g, ' ').trim();
export async function appleSearchAlbums(term: string, limit = 12, country = 'GB'): Promise<AppleAlbum[]> {
  const r = await call<{ results: ItunesRow[] }>('itunes', 'search', { term: searchTerm(term), entity: 'album', media: 'music', limit, country });
  return r.results.map((x) => ({ ...toAlbum(x), country }));
}
/** Best Apple match for a release: UK store first, then US (some releases are region-locked). */
/** Best Apple match: exact title (edition tags aside), right artist; explicit over clean, album over single. */
export function pickApple(list: AppleAlbum[], title: string, artist: string) {
  return list.map((x) => ({ x, s: titleScore(x.title, title) })).filter(({ x, s }) => s >= 0.85 && artistMatch(x.artist, artist))
    .sort((a, b) => b.s - a.s || Number(a.x.explicitness === 'cleaned') - Number(b.x.explicitness === 'cleaned') || Number(a.x.kind !== 'Album') - Number(b.x.kind !== 'Album') || (a.x.date ?? '').localeCompare(b.x.date ?? ''))[0]?.x;
}

/*
 * Apple's keyword search ranks by popularity across every field, so "Future Save Me" returns other artists'
 * songs called "Save Me" and never the EP. Looking through the artist's own catalogue is far more reliable.
 * Artist IDs are the same in every storefront; both lookups are cached for the session.
 */
const appleArtistIds = new Map<string, Promise<number[]>>();
const appleCatalogues = new Map<string, Promise<AppleAlbum[]>>();
function cached<T>(m: Map<string, Promise<T>>, k: string, f: () => Promise<T>) {
  let p = m.get(k);
  if (!p) { p = f(); m.set(k, p); p.catch(() => m.delete(k)); }
  return p;
}
/** Tell the matcher an artist's Apple ID we already know (from their artist page link). */
export function seedAppleArtist(name: string, url?: string | null, knownId?: number) {
  const id = knownId ?? url?.match(/\/artist\/(?:[^/]+\/)?(\d+)/)?.[1];
  if (id && name && !appleArtistIds.has(norm(name))) appleArtistIds.set(norm(name), Promise.resolve([Number(id)]));
}
const appleArtistIdsFor = (artist: string) => cached(appleArtistIds, norm(artist), async () => {
  const r = await call<{ results: ItunesRow[] }>('itunes', 'search', { term: searchTerm(artist), entity: 'musicArtist', media: 'music', limit: 10, country: 'GB' });
  return r.results.filter((a) => norm(a.artistName) === norm(artist)).slice(0, 2).map((a) => a.artistId!);
});
const appleCatalogue = (id: number, country: string) => cached(appleCatalogues, `${id}:${country}`, async () => {
  const r = await call<{ results: ItunesRow[] }>('itunes', 'lookup', { id, entity: 'album', limit: 200, country });
  return r.results.filter((x) => x.wrapperType === 'collection').map((x) => ({ ...toAlbum(x), country }));
});
/** Everything Apple lists under this artist in one storefront (up to 200 releases per artist ID). */
export async function appleAlbumsForArtist(artist: string, country = 'GB'): Promise<AppleAlbum[]> {
  const ids = artist.trim() ? await appleArtistIdsFor(artist) : [];
  return (await Promise.all(ids.map((id) => appleCatalogue(id, country)))).flat();
}
/** Albums in the artist's catalogue that look like this title, best first — for the pickers. */
export async function appleCatalogueMatches(title: string, artist: string, country = 'GB'): Promise<AppleAlbum[]> {
  const n = norm(cleanTitle(title));
  return (await appleAlbumsForArtist(artist, country))
    .map((a) => ({ a, s: Math.max(titleScore(a.title, title), n && norm(a.title).includes(n) ? 0.7 : 0) }))
    .filter((x) => x.s >= 0.5).sort((x, y) => y.s - x.s).map((x) => x.a);
}
export async function appleFindAlbum(title: string, artist: string): Promise<AppleAlbum | undefined> {
  for (const country of ['GB', 'US']) {
    const own = await appleAlbumsForArtist(artist, country).catch(() => [] as AppleAlbum[]);
    const hit = pickApple(own, title, artist) ?? pickApple(await appleSearchAlbums(`${artist} ${title}`, 25, country), title, artist);
    if (hit) return hit;
  }
  return undefined;
}
/** Look an Apple album up by its ID (UK store, then US). */
const appleById = new Map<number, AppleAlbum>();
/** Look up many Apple albums in a few calls (Apple allows lots of IDs per lookup); later appleAlbumById calls use the results. */
export async function appleAlbumsByIds(ids: number[], onProgress?: (done: number) => void) {
  let todo = [...new Set(ids)].filter((id) => !appleById.has(id)); let done = 0;
  for (const country of ['GB', 'US']) {
    for (let i = 0; i < todo.length; i += 150) {
      const r = await call<{ results: ItunesRow[] }>('itunes', 'lookup', { id: todo.slice(i, i + 150).join(','), entity: 'album', country });
      for (const x of r.results) if (x.wrapperType === 'collection' && !appleById.has(x.collectionId)) { appleById.set(x.collectionId, { ...toAlbum(x), country }); done++; }
      onProgress?.(done);
    }
    todo = todo.filter((id) => !appleById.has(id));
  }
}
export async function appleAlbumById(id: number): Promise<AppleAlbum | undefined> {
  const hit = appleById.get(id); if (hit) return hit;
  for (const country of ['GB', 'US']) {
    const r = await call<{ results: ItunesRow[] }>('itunes', 'lookup', { id, entity: 'album', country });
    const row = r.results.find((x) => x.wrapperType === 'collection');
    if (row) return { ...toAlbum(row), country };
  }
  return undefined;
}
export const appleIdFromUrl = (u?: string | null) => { const m = u?.match(/\/(\d{5,})(?:[/?#]|$)/); return m ? Number(m[1]) : undefined; };
export const deezerIdFromUrl = (u?: string | null) => { const m = u?.match(/deezer\.com\/(?:[a-z]{2}\/)?album\/(\d+)/); return m ? Number(m[1]) : undefined; };
export const mbidFromUrl = (u?: string | null) => u?.match(/musicbrainz\.org\/release-group\/([0-9a-f-]{36})/)?.[1];
export async function appleSearchSongs(term: string, limit = 12) {
  const r = await call<{ results: ItunesRow[] }>('itunes', 'search', { term, entity: 'song', media: 'music', limit });
  return r.results.map((s) => ({ id: s.trackId!, title: s.trackName!, artist: s.artistName, album: s.collectionName, albumId: s.collectionId, artwork: bigArt(s.artworkUrl100), date: s.releaseDate?.slice(0, 10), url: songUrl(s.trackViewUrl) }));
}
export async function appleSearchArtists(term: string, limit = 8) {
  const r = await call<{ results: ItunesRow[] }>('itunes', 'search', { term, entity: 'musicArtist', media: 'music', limit });
  return r.results.map((a) => ({ id: a.artistId!, name: a.artistName, url: a.artistLinkUrl?.split('?')[0] ?? '', genre: a.primaryGenreName }));
}
export async function appleAlbumTracks(collectionId: number) {
  let r = await call<{ results: ItunesRow[] }>('itunes', 'lookup', { id: collectionId, entity: 'song', limit: 200 });
  if (r.results.length < 2) r = await call<{ results: ItunesRow[] }>('itunes', 'lookup', { id: collectionId, entity: 'song', limit: 200, country: 'US' });
  return r.results.filter((x) => x.wrapperType === 'track').map((t) => ({ id: t.trackId!, title: t.trackName!, artist: t.artistName, number: t.trackNumber ?? null, disc: t.discNumber ?? null, ms: t.trackTimeMillis ?? null, url: songUrl(t.trackViewUrl) }));
}
export const appleArtistAlbums = (artistId: number) => appleCatalogue(artistId, 'GB');

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
  return r.data?.find((a) => titleScore(a.title, title) >= 0.85 && artistMatch(a.artist.name, artist)) ?? null;
}

export interface DeezerAlbum { id: number; title: string; cover_xl: string; cover_medium: string; link: string; artist: { name: string }; record_type?: string }
export async function deezerAlbumInfo(id: number): Promise<{ title: string; artist: string; cover?: string; link?: string } | null> {
  const r = await call<{ title?: string; artist?: { name: string }; cover_xl?: string; link?: string; error?: unknown }>('deezer', `album/${id}`);
  return r.title ? { title: r.title, artist: r.artist?.name ?? '', cover: r.cover_xl, link: r.link } : null;
}
export async function mbGroupInfo(mbid: string): Promise<{ title: string; artist: string } | null> {
  const r = await call<MBGroupRaw>('mb', `release-group/${mbid}`, { inc: 'artist-credits' });
  return r?.title ? { title: r.title, artist: (r['artist-credit'] ?? []).map((c) => c.name + (c.joinphrase ?? '')).join('') } : null;
}
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

// ——— Tracklists ———
export interface SourceTrack { title: string; artist?: string; number: number | null; disc: number | null; ms: number | null; links: Links; ext: Record<string, unknown>; producers?: string[] }
export async function deezerAlbumTracks(id: number): Promise<SourceTrack[]> {
  const r = await call<{ data?: { id: number; title: string; duration?: number; track_position?: number; disk_number?: number; link?: string; artist?: { name: string } }[] }>('deezer', `album/${id}/tracks`, { limit: 300 });
  return (r.data ?? []).map((t, i) => ({ title: t.title, artist: t.artist?.name, number: t.track_position ?? i + 1, disc: t.disk_number ?? null, ms: t.duration ? t.duration * 1000 : null, links: t.link ? { deezer: t.link } : {}, ext: { deezer_id: t.id } }));
}
export async function mbGroupTracks(mbid: string): Promise<SourceTrack[]> {
  const r = await call<{ releases: { id: string; status?: string; date?: string; country?: string }[] }>('mb', 'release', { 'release-group': mbid, limit: 25 });
  const rank = (x: typeof r.releases[0]) => `${x.status === 'Official' ? 0 : 1}${x.date || '9999'}${x.country === 'US' ? 0 : x.country === 'XW' ? 1 : 2}`;
  const rel = [...r.releases].sort((a, b) => rank(a).localeCompare(rank(b)))[0];
  if (!rel) return [];
  const d = await call<{ media?: { position?: number; tracks?: { position?: number; title: string; length?: number | null; recording?: { id: string } }[] }[] }>('mb', `release/${rel.id}`, { inc: 'recordings' });
  return (d.media ?? []).flatMap((m) => (m.tracks ?? []).map((t, i) => ({ title: t.title, number: t.position ?? i + 1, disc: m.position ?? null, ms: t.length ?? null, links: t.recording ? { musicbrainz: `https://musicbrainz.org/recording/${t.recording.id}` } : {}, ext: t.recording ? { mb_recording: t.recording.id } : {} })));
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


// ——— Wikipedia album pages: cover and tracklist ———
export const wikiTitleFromUrl = (url?: string | null) => { const t = url?.split('/wiki/')[1]?.split(/[?#]/)[0]; return t ? decodeURIComponent(t).replace(/_/g, ' ') : undefined; };
const wikitextCache = new Map<string, Promise<string>>();
export const wikiWikitext = (title: string) => cached(wikitextCache, title, async () => {
  const r = await call<{ parse?: { wikitext: string }; error?: { info: string } }>('wiki', 'w/api.php', { action: 'parse', page: title, prop: 'wikitext', redirects: 1, format: 'json', formatversion: 2 });
  if (!r.parse) throw new Error(r.error?.info ?? 'Wikipedia page not found');
  return r.parse.wikitext;
});
/** Split template parameters on top-level pipes (not those inside nested {{ }} or [[ ]]). */
function splitParams(body: string): string[] {
  const out: string[] = []; let depth = 0; let cur = '';
  for (let i = 0; i < body.length; i++) {
    const two = body.slice(i, i + 2);
    if (two === '{{' || two === '[[') { depth++; cur += two; i++; continue; }
    if ((two === '}}' || two === ']]') && depth > 0) { depth--; cur += two; i++; continue; }
    if (body[i] === '|' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += body[i];
  }
  out.push(cur); return out;
}
/** Every {{name …}} template in the text, with its parameters. */
function templates(wt: string, name: RegExp): Record<string, string>[] {
  const out: Record<string, string>[] = [];
  const re = new RegExp(`\\{\\{\\s*(?:${name.source})\\s*[|}\\n]`, 'gi'); let m: RegExpExecArray | null;
  while ((m = re.exec(wt))) {
    let depth = 0; let end = m.index;
    for (let i = m.index; i < wt.length - 1; i++) {
      if (wt.startsWith('{{', i)) { depth++; i++; } else if (wt.startsWith('}}', i)) { depth--; i++; if (!depth) { end = i + 1; break; } }
    }
    const params: Record<string, string> = {};
    for (const part of splitParams(wt.slice(m.index + 2, end - 2)).slice(1)) { const eq = part.indexOf('='); if (eq > 0) params[part.slice(0, eq).trim().toLowerCase()] = part.slice(eq + 1).trim(); }
    out.push(params); re.lastIndex = end;
  }
  return out;
}
/** Wikitext → plain text: links to their text, lists to "a, b", references and formatting dropped. */
const LIST_T = /\{\{\s*(?:hlist|flat ?list|unbulleted list|plain ?list|ubl|bulleted list)\s*\|([^{}]*)\}\}/gi;
/** Items of a list template or bullet list, one per entry (pipes inside [[links]] left alone). */
function listItems(s: string): string[] {
  // Links are set aside whole so "[[Cool & Dre]]" or "[[A, B|C]]" never get split
  const links: string[] = [];
  const safe = s.replace(/\[\[[^\]]*\]\]/g, (m) => `\uE000${links.push(m) - 1}\uE001`);
  const flat = safe.replace(LIST_T, (_, x: string) => x.split('|').filter((v) => !/^\s*\w+\s*=/.test(v)).join('\n* '));
  // "&" and "and" aren't separators: duos like Cool & Dre are one name
  return flat.split(/\n\s*\*|<br\s*\/?>|,|\|/i).map((x) => x.replace(/\uE000(\d+)\uE001/g, (_, i: string) => links[Number(i)]).trim()).filter(Boolean);
}
/** Drop references, comments and footnote-style templates; keep the text of nowrap/lang wrappers; list templates stay. */
function stripNoise(s: string): string {
  let t = s.replace(/<ref[^>]*\/>/gi, '').replace(/<ref[\s\S]*?<\/ref>/gi, '').replace(/<!--[\s\S]*?-->/g, '');
  for (let prev = ''; prev !== t;) {
    prev = t;
    t = t.replace(/\{\{\s*(?:nowrap|nobr|lang\|[a-z-]+)\s*\|([^{}]*)\}\}/gi, '$1')
      .replace(/\{\{\s*(?!hlist|flat ?list|unbulleted list|plain ?list|ubl\b|bulleted list)[^{}]*\}\}/gi, '');
  }
  return t;
}
export function wikiPlain(s: string): string {
  return stripNoise(s)
    .replace(/\{\{\s*(?:hlist|flat ?list|unbulleted list|plain ?list|ubl|bulleted list)\s*\|([^{}]*)\}\}/gi, (m) => listItems(m).map((x) => x.replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, '$1')).join(', '))
    .replace(/\{\{\s*(?:nowrap|nobr|small|lang\|[a-z-]+)\s*\|([^{}]*)\}\}/gi, '$1')
    .replace(/\{\{[^{}]*\}\}/g, '').replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, '$1')
    .replace(/'{2,}/g, '').replace(/<br\s*\/?>/gi, ', ').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}
const toMs = (s?: string) => { const m = s?.match(/(\d+):(\d{2})(?::(\d{2}))?/); if (!m) return null; return m[3] ? ((+m[1] * 60 + +m[2]) * 60 + +m[3]) * 1000 : (+m[1] * 60 + +m[2]) * 1000; };
/** Producer names from a tracklist cell, with surnames ("Kilhoffer") expanded from links elsewhere on the page. */
function producerNames(cell: string, fullNames: Map<string, string>): string[] {
  return listItems(stripNoise(cell)).map((p) => {
    const link = p.match(/\[\[\s*([^\]|]+?)\s*(?:\|\s*([^\]]+?)\s*)?\]\]/);
    let name = link ? (link[2] ?? link[1]) : wikiPlain(p);
    name = name.replace(/\([^)]*\)/g, '').replace(/[*^†‡#§¤¶%]+/g, '').replace(/^\s*(?:co|add|additional|misc)\.?\s+/i, '').trim();
    if (link && /\(record producer\)|\(producer\)|\(musician\)|\(rapper\)/i.test(link[1]) && !link[2]) name = link[1].replace(/\s*\([^)]*\)/, '');
    return fullNames.get(name.toLowerCase()) ?? name;
  }).filter((n) => n && n.length > 1 && !/^(uncredited|none|n\/a)$/i.test(n));
}
/** Tracklist from the album's Wikipedia page ({{Track listing}} templates). Bonus/deluxe sections are left out. */
export async function wikiTracks(url: string): Promise<SourceTrack[]> {
  const title = wikiTitleFromUrl(url); if (!title) return [];
  const wt = (await wikiWikitext(title)).replace(/<!--[\s\S]*?-->/g, '');
  const blocks = templates(wt, /track ?listing|tracklist/);
  const kind = (h: string) => (/\b(disc|cd)\b/i.test(h) ? 'disc' : /\bside\b/i.test(h) ? 'side' : /\bpart\b/i.test(h) ? 'part' : '');
  const firstKind = kind(wikiPlain(blocks[0]?.headline ?? ''));
  // Surname → full name, from every link on the page ([[Anthony Kilhoffer]] makes "Kilhoffer" usable)
  const fullNames = new Map<string, string>();
  for (const m of wt.matchAll(/\[\[([^\]|#]+)(?:\|[^\]]*)?\]\]/g)) {
    if (m[1].includes(':')) continue; // Category:, File: …
    const full = m[1].replace(/\s*\([^)]*\)/, '').trim(); const last = full.split(' ').pop()!;
    if (full.includes(' ') && !fullNames.has(last.toLowerCase())) fullNames.set(last.toLowerCase(), full);
  }
  const out: SourceTrack[] = []; let disc = 0; let pos = 0;
  for (const [i, b] of blocks.entries()) {
    const head = wikiPlain(b.headline ?? '');
    // Later blocks count only when the album is split the same way (Disc one → Disc two, Side A → Side B); others are other editions
    if (i > 0 && (!firstKind || kind(head) !== firstKind)) continue;
    if (i > 0 && /bonus|deluxe|edition|reissue|anniversary|expanded|japan|itunes|target|instrumental|remix/i.test(head)) continue;
    // "Side one / Side two" is one album split across sides; "Disc two" starts a new disc
    if (i === 0 || /\b(disc|cd)\b/i.test(head)) { disc++; pos = 0; }
    const prodCol = /produc/i.test(b.extra_column ?? '');
    const nums = Object.keys(b).map((k) => k.match(/^title(\d+)$/)?.[1]).filter(Boolean).map(Number).sort((x, y) => x - y);
    for (const n of nums) {
      pos++;
      const note = wikiPlain(b[`note${n}`] ?? ''); const feat = note.match(/^(?:featuring|feat\.?|with)\s+(.+)$/i)?.[1];
      let t = wikiPlain(b[`title${n}`]).replace(/^"|"$/g, '');
      if (feat && !/feat/i.test(t)) t += ` (feat. ${feat.replace(/\s+and\s+/g, ' & ')})`;
      out.push({ title: t, number: pos, disc: disc > 1 ? disc : null, ms: toMs(b[`length${n}`]), links: {}, ext: { wiki: true }, producers: prodCol && b[`extra${n}`] ? producerNames(b[`extra${n}`], fullNames) : undefined });
    }
  }
  if (disc > 1) for (const t of out) t.disc ??= 1;
  return out;
}
/** The album cover named in the page's infobox. */
export async function wikiCover(url: string): Promise<string | undefined> {
  const title = wikiTitleFromUrl(url); if (!title) return undefined;
  const wt = await wikiWikitext(title);
  const box = templates(wt, /infobox album|infobox mixtape|infobox ep|infobox single/)[0];
  const file = (box?.cover ?? '').replace(/^\[\[(?:File|Image):/i, '').replace(/\|.*$/s, '').replace(/\]\]$/, '').trim();
  if (!file) return undefined;
  const r = await call<{ query?: { pages: Record<string, { imageinfo?: { url: string }[] }> } }>('wiki', 'w/api.php', { action: 'query', titles: `File:${file}`, prop: 'imageinfo', iiprop: 'url', format: 'json' });
  const u = Object.values(r.query?.pages ?? {})[0]?.imageinfo?.[0]?.url;
  return u?.split('?')[0];
}
