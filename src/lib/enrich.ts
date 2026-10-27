import { mergeLinks } from './links';
import {
  appleAlbumById, appleAlbumLabel, isCleanApple, wikiCover, wikiTracks, appleAlbumTracks, appleFindAlbum, appleIdFromUrl, deezerAlbumInfo, deezerIdFromUrl, mbGroupInfo, mbidFromUrl, deezerAlbumTracks, mbGroupTracks, type SourceTrack, appleSearchArtists, deezerAlbumLabel, mbGroupLabels, soundcloudSearch, ARTIST_OK, artistMatch, bestMatch, caaCover, deezerAlbum, deezerArtist, deezerSearchAlbums,
  fuzzy, fuzzyArtist, geniusSearch, geniusSong, mbLinks, mbSearchArtists, mbSearchGroups, mbSearchGroupsLoose, TITLE_OK,
  titleScore, wikiSearch, wikiSummary, wikidataToWikipedia,
} from './sources';
import { norm, now } from './util';
import type { Artist, Release } from './types';

const safe = async <T,>(p: Promise<T>, errs: string[], label: string): Promise<T | null> => {
  try { return await p; } catch (e) { errs.push(`${label}: ${(e as Error).message}`); return null; }
};

export interface EnrichResult<T> { patch: Partial<T>; found: string[]; errors: string[] }

/** Find exact pages for a release across sources. Only accepts confident matches; never overwrites links you set. */
export async function autoLinkRelease(rel: Release, artistName: string, opts: { genius?: boolean; wiki?: boolean } = {}): Promise<EnrichResult<Release>> {
  const errors: string[] = []; const found: string[] = [];
  let links = { ...rel.links }; const ext = { ...rel.ext };
  let artwork = rel.artwork_url ?? null; let date = rel.date ?? null;

  const [a, mb] = await Promise.all([
    rel.links.apple && rel.artwork_url ? null : safe(appleFindAlbum(rel.title, artistName), errors, 'Apple'),
    rel.ext.mbid ? null : safe(mbSearchGroups(rel.title, artistName), errors, 'MusicBrainz'),
  ]);

  if (a) {
    links = mergeLinks(links, { apple: a.url });
    artwork ??= a.artwork ?? null; ext.apple_id ??= a.id;
    if (!date && a.date) date = a.date;
    found.push('Apple Music');
  }
  const g = mb?.find((x) => (x.score ?? 0) >= 85 && titleScore(x.title, rel.title) >= 0.85 && artistMatch(x.artist, artistName));
  if (g) {
    ext.mbid = g.id; found.push('MusicBrainz');
    const ml = await safe(mbLinks('release-group', g.id), errors, 'MusicBrainz links');
    if (ml) {
      const { wikidata, ...rest } = ml;
      if (!rest.wikipedia && wikidata) rest.wikipedia = (await safe(wikidataToWikipedia(wikidata), errors, 'Wikidata')) ?? undefined;
      links = mergeLinks(links, rest);
      if (rest.wikipedia) found.push('Wikipedia');
    }
  }
  if (!artwork) {
    const d = await safe(deezerAlbum(rel.title, artistName), errors, 'Deezer');
    if (d) { artwork = d.cover_xl; links = mergeLinks(links, { deezer: d.link }); ext.deezer_id = d.id; found.push('Deezer cover'); }
  }
  if (opts.genius !== false && !links.genius) {
    const hits = await safe(geniusSearch(`${artistName} ${rel.title}`), errors, 'Genius');
    const hit = hits?.find((h) => artistMatch(h.artist, artistName));
    if (hit) {
      const s = await safe(geniusSong(hit.id), errors, 'Genius song');
      if (s?.album && titleScore(s.album.name, rel.title) >= 0.85) { links = mergeLinks(links, { genius: s.album.url }); found.push('Genius'); }
    }
  }
  if (opts.wiki !== false && !links.wikipedia) {
    const pages = await safe(wikiSearch(`${rel.title} ${artistName} album`), errors, 'Wikipedia');
    const p = pages?.find((x) => titleScore(x.title.replace(/\s*\(.*\)$/, ''), rel.title) >= 0.99 && /(album|mixtape|ep\b|extended play)/i.test(x.description) && (x.description.toLowerCase().includes(norm(artistName).split(' ')[0]) || /\(.*album\)/i.test(x.title)));
    if (p) { links = mergeLinks(links, { wikipedia: p.url }); found.push('Wikipedia'); }
  }
  if (!artwork && links.wikipedia) { const c = await safe(wikiCover(links.wikipedia), errors, 'Wikipedia cover'); if (c) { artwork = c; found.push('Wikipedia cover'); } }
  ext.linked_at = now();
  const year = date ? Number(date.slice(0, 4)) : rel.year;
  return { patch: { links, ext, artwork_url: artwork, date, year, updated_at: now() }, found, errors };
}

export async function autoLinkArtist(artist: Artist): Promise<EnrichResult<Artist>> {
  const errors: string[] = []; const found: string[] = [];
  let links = { ...artist.links }; const ext = { ...artist.ext };
  let image = artist.image_url ?? null; let bio = artist.bio ?? null;

  const [apple, dz, mb, gen] = await Promise.all([
    links.apple ? null : safe(appleSearchArtists(artist.name, 5), errors, 'Apple'),
    image ? null : safe(deezerArtist(artist.name), errors, 'Deezer'),
    ext.mbid ? null : safe(mbSearchArtists(artist.name), errors, 'MusicBrainz'),
    links.genius ? null : safe(geniusSearch(artist.name), errors, 'Genius'),
  ]);
  const ap = apple?.find((x) => norm(x.name) === norm(artist.name));
  if (ap) { links = mergeLinks(links, { apple: ap.url }); ext.apple_id = ap.id; found.push('Apple Music'); }
  if (dz) { image = dz.picture_xl; links = mergeLinks(links, { deezer: dz.link }); ext.deezer_id = dz.id; found.push('Deezer photo'); }
  const gh = gen?.find((h) => norm(h.artist) === norm(artist.name));
  if (gh) {
    links = mergeLinks(links, { genius: gh.artistUrl }); ext.genius_id = gh.artistId; found.push('Genius');
    if (!image && gh.artistImage && !/default_avatar/.test(gh.artistImage)) image = gh.artistImage;
  }
  // Only take a MusicBrainz artist when there's a single clear exact match (lots of rappers share names).
  const exact = mb?.filter((x) => norm(x.name) === norm(artist.name) && x.score >= 90) ?? [];
  if (exact.length === 1) {
    ext.mbid = exact[0].id; found.push('MusicBrainz');
    const ml = await safe(mbLinks('artist', exact[0].id), errors, 'MusicBrainz links');
    if (ml) {
      const { wikidata, ...rest } = ml;
      if (!rest.wikipedia && wikidata) rest.wikipedia = (await safe(wikidataToWikipedia(wikidata), errors, 'Wikidata')) ?? undefined;
      links = mergeLinks(links, rest);
    }
  }
  if (links.wikipedia && !bio) {
    const s = await safe(wikiSummary(links.wikipedia), errors, 'Wikipedia summary');
    if (s) { bio = s.extract; if (!image && s.image) image = s.image; found.push('Wikipedia'); }
  }
  ext.linked_at = now();
  return { patch: { links, ext, image_url: image, bio, updated_at: now() }, found, errors };
}

/**
 * Second pass for releases the first pass couldn't cover. Looser, fuzzy matching:
 * Cover Art Archive (via MusicBrainz), Deezer, MusicBrainz re-search, then Genius album art.
 * Fills only what's missing and never overwrites links you set.
 */
export async function secondPassRelease(rel: Release, artistName: string): Promise<EnrichResult<Release>> {
  const errors: string[] = []; const found: string[] = [];
  let links = { ...rel.links }; const ext = { ...rel.ext };
  let artwork = rel.artwork_url ?? null; let date = rel.date ?? null;
  const credit = rel.artist_credit || artistName;

  // 1. Already matched on MusicBrainz → Cover Art Archive
  if (!artwork && ext.mbid) {
    const c = await caaCover(ext.mbid as string);
    if (c) { artwork = c; found.push('Cover Art Archive'); }
  }
  // 2. Deezer, fuzzy
  if (!artwork || !links.deezer) {
    let list = await safe(deezerSearchAlbums(`${artistName} ${rel.title}`), errors, 'Deezer') ?? [];
    let m = bestMatch(list, rel.title, credit, (d) => ({ title: d.title, artist: d.artist.name }));
    if (!m) {
      list = await safe(deezerSearchAlbums(rel.title), errors, 'Deezer') ?? [];
      m = bestMatch(list, rel.title, credit, (d) => ({ title: d.title, artist: d.artist.name }));
    }
    if (m) {
      links = mergeLinks(links, { deezer: m.item.link }); ext.deezer_id ??= m.item.id;
      if (!artwork) { artwork = m.item.cover_xl; found.push('Deezer cover'); } else found.push('Deezer');
    }
  }
  // 3. MusicBrainz re-search, fuzzy → links + Cover Art Archive
  if (!ext.mbid) {
    const groups = await safe(mbSearchGroupsLoose(rel.title, artistName), errors, 'MusicBrainz') ?? [];
    const m = bestMatch(groups, rel.title, credit, (g) => ({ title: g.title, artist: g.artist }));
    if (m) {
      ext.mbid = m.item.id; found.push('MusicBrainz');
      if (!date && m.item.date && m.item.date.length === 10) date = m.item.date;
      const ml = await safe(mbLinks('release-group', m.item.id), errors, 'MusicBrainz links');
      if (ml) {
        const { wikidata, ...rest } = ml;
        if (!rest.wikipedia && wikidata) rest.wikipedia = (await safe(wikidataToWikipedia(wikidata), errors, 'Wikidata')) ?? undefined;
        links = mergeLinks(links, rest);
      }
      if (!artwork) { const c = await caaCover(m.item.id); if (c) { artwork = c; found.push('Cover Art Archive'); } }
    }
  }
  // 4. Genius album art (and the album page)
  if (!artwork || !links.genius) {
    const hits = (await safe(geniusSearch(`${artistName} ${rel.title}`), errors, 'Genius') ?? []).filter((h) => fuzzyArtist(credit, h.artist) >= ARTIST_OK).slice(0, 2);
    for (const h of hits) {
      const s = await safe(geniusSong(h.id), errors, 'Genius song');
      if (s?.album && fuzzy(s.album.name, rel.title) >= TITLE_OK) {
        links = mergeLinks(links, { genius: s.album.url });
        if (!artwork && s.album.cover_art_url && !/default_cover/.test(s.album.cover_art_url)) { artwork = s.album.cover_art_url; found.push('Genius cover'); } else found.push('Genius');
        break;
      }
    }
  }
  // 5. Last resort: the cover in the album's Wikipedia infobox
  if (!artwork && links.wikipedia) { const c = await safe(wikiCover(links.wikipedia), errors, 'Wikipedia'); if (c) { artwork = c; found.push('Wikipedia cover'); } }
  ext.pass2_at = now();
  const year = date ? Number(date.slice(0, 4)) : rel.year;
  return { patch: { links, ext, artwork_url: artwork, date, year, updated_at: now() }, found, errors };
}

/** Labels for a release from Deezer, then MusicBrainz, then Apple's copyright line. */
export async function findReleaseLabels(rel: Release): Promise<{ names: string[]; source: string | null; errors: string[] }> {
  const errors: string[] = [];
  const tries: [string, () => Promise<string[]>][] = [];
  const dz: [string, () => Promise<string[]>] | null = rel.ext.deezer_id ? ['Deezer', () => deezerAlbumLabel(rel.ext.deezer_id as number)] : null;
  const mb: [string, () => Promise<string[]>] | null = rel.ext.mbid ? ['MusicBrainz', () => mbGroupLabels(rel.ext.mbid as string)] : null;
  // Streaming services list today's rights holder (often a reissue label), so for older records MusicBrainz's original pressing goes first
  const old = (rel.year ?? 9999) < 2008;
  for (const t of old ? [mb, dz] : [dz, mb]) if (t) tries.push(t);
  if (rel.ext.apple_id) tries.push(['Apple Music', () => appleAlbumLabel(rel.ext.apple_id as number)]);
  for (const [source, fn] of tries) {
    const names = await safe(fn(), errors, source);
    if (names?.length) return { names, source, errors };
  }
  return { names: [], source: null, errors };
}

/** SoundCloud pass: albums/playlists (and tracks for singles) for releases still without a cover. */
export async function soundcloudPassRelease(rel: Release, artistName: string): Promise<EnrichResult<Release>> {
  const errors: string[] = []; const found: string[] = [];
  const credit = rel.artist_credit || artistName;
  const kinds: ('playlist' | 'track')[] = /single|guest/i.test(rel.type) ? ['track', 'playlist'] : ['playlist'];
  const list = await safe(soundcloudSearch(`${artistName} ${rel.title}`, kinds), errors, 'SoundCloud') ?? [];
  const m = bestMatch(list, rel.title, credit, (x) => ({ title: x.title, artist: x.artist }));
  // Only mark as done if SoundCloud actually answered (so a missing key or outage can be retried)
  const patch: Partial<Release> = { ext: errors.length ? { ...rel.ext } : { ...rel.ext, sc_at: now() }, updated_at: now() };
  if (m) {
    patch.links = mergeLinks(rel.links, { soundcloud: m.item.url });
    if (!rel.artwork_url && m.item.artwork) { patch.artwork_url = m.item.artwork; found.push('SoundCloud cover'); } else found.push('SoundCloud');
  }
  return { patch, found, errors };
}

/** Tracklist from Apple (gives playable song links), else Deezer, else MusicBrainz. */
/** Where a tracklist can come from for this release, in order of preference. */
export function tracklistSources(rel: Release): [string, () => Promise<SourceTrack[]>][] {
  const tries: [string, () => Promise<SourceTrack[]>][] = [];
  if (rel.ext.apple_id) tries.push(['Apple Music', async () => (await appleAlbumTracks(rel.ext.apple_id as number)).map((t) => ({ title: t.title, artist: t.artist, number: t.number, disc: t.disc, ms: t.ms, links: t.url ? { apple: t.url } : {}, ext: { apple_id: t.id } }))]);
  if (rel.ext.deezer_id) tries.push(['Deezer', () => deezerAlbumTracks(rel.ext.deezer_id as number)]);
  if (rel.ext.mbid) tries.push(['MusicBrainz', () => mbGroupTracks(rel.ext.mbid as string)]);
  if (rel.links.wikipedia) tries.push(['Wikipedia', () => wikiTracks(rel.links.wikipedia!)]);
  return tries;
}
export async function findTracklist(rel: Release): Promise<{ tracks: SourceTrack[]; source: string | null; errors: string[] }> {
  const errors: string[] = [];
  for (const [source, fn] of tracklistSources(rel)) {
    const tracks = await safe(fn(), errors, source);
    if (tracks?.length) return { tracks, source, errors };
  }
  return { tracks: [], source: null, errors };
}

const fromApple = (u?: string | null) => !!u && /mzstatic\.com/.test(u);
const fromDeezer = (u?: string | null) => !!u && /dzcdn\.net|deezer\.com/.test(u);
const fromCAA = (u?: string | null) => !!u && /coverartarchive\.org|archive\.org/.test(u);

/**
 * You set an Apple / Deezer / MusicBrainz link by hand: follow it. Pull that source's ID and cover so the
 * artwork, tracklist and labels come from the album you chose, not the old match.
 */
export async function followLinks(rel: Release, links: Release['links']): Promise<{ patch: Partial<Release>; changed: string[] }> {
  const ext = { ...rel.ext }; let artwork = rel.artwork_url ?? null; let date = rel.date ?? null;
  const changed: string[] = []; let newArt: string | undefined;
  if (links.apple !== rel.links.apple) {
    changed.push('Apple Music');
    const id = appleIdFromUrl(links.apple);
    if (id) { ext.apple_id = id; const a = await appleAlbumById(id).catch(() => undefined); if (a) { newArt ??= a.artwork; if (!date && a.date) date = a.date; } }
    else delete ext.apple_id;
  }
  if (links.deezer !== rel.links.deezer) {
    changed.push('Deezer');
    const id = deezerIdFromUrl(links.deezer);
    if (id) { ext.deezer_id = id; const d = await deezerAlbumInfo(id).catch(() => null); if (d?.cover) newArt ??= d.cover; }
    else delete ext.deezer_id;
  }
  if (links.musicbrainz !== rel.links.musicbrainz) {
    const id = mbidFromUrl(links.musicbrainz);
    if (id !== ext.mbid) {
      changed.push('MusicBrainz');
      if (id) { ext.mbid = id; const c = await caaCover(id); if (c) newArt ??= c; } else delete ext.mbid;
    }
  }
  if (newArt) artwork = newArt;
  if (changed.length) ext.links_manual = now(); // set by hand — the repair job leaves it alone
  return { patch: { links, ext, artwork_url: artwork, date, year: date ? Number(date.slice(0, 4)) : rel.year, updated_at: now() }, changed };
}

/**
 * Repair check for one release: is each automatic match really this album? Wrong matches are re-matched
 * with the stricter rules or dropped, and their cover goes with them.
 */
export async function recheckRelease(rel: Release, artistName: string): Promise<{ patch: Partial<Release>; changed: string[]; errors: string[] }> {
  const errors: string[] = []; const changed: string[] = [];
  const links = { ...rel.links }; const ext = { ...rel.ext }; let artwork = rel.artwork_url ?? null;
  const credit = rel.artist_credit || artistName;
  const ok = (t: string, a: string) => titleScore(t, rel.title) >= 0.85 && (artistMatch(a, artistName) || fuzzyArtist(credit, a) >= ARTIST_OK);

  if (links.apple) {
    const id = (ext.apple_id as number | undefined) ?? appleIdFromUrl(links.apple);
    const cur = id ? await safe(appleAlbumById(id), errors, 'Apple') : null;
    if (cur && (!ok(cur.title, cur.artist) || isCleanApple(cur))) {
      changed.push('Apple Music');
      const better = await safe(appleFindAlbum(rel.title, artistName), errors, 'Apple');
      if (better) { links.apple = better.url; ext.apple_id = better.id; if (fromApple(artwork)) artwork = better.artwork ?? null; }
      else { delete links.apple; delete ext.apple_id; if (fromApple(artwork)) artwork = null; }
    }
  }
  if (ext.deezer_id) {
    const cur = await safe(deezerAlbumInfo(ext.deezer_id as number), errors, 'Deezer');
    if (cur && (!ok(cur.title, cur.artist) || cur.clean)) { changed.push('Deezer'); delete links.deezer; delete ext.deezer_id; if (fromDeezer(artwork)) artwork = null; }
  }
  if (ext.mbid && fromCAA(artwork)) {
    const cur = await safe(mbGroupInfo(ext.mbid as string), errors, 'MusicBrainz');
    if (cur && !ok(cur.title, cur.artist)) { changed.push('MusicBrainz'); delete links.musicbrainz; delete ext.mbid; artwork = null; }
  }
  if (!errors.length) { ext.recheck_at = now(); ext.recheck_v = RECHECK_V; } // retried next run if a source was down
  let patch: Partial<Release> = { links, ext, artwork_url: artwork, updated_at: now() };
  // Lost the cover? Try the (now stricter) second pass to find the right one
  if (!artwork && changed.length) {
    const sp = await secondPassRelease({ ...rel, ...patch } as Release, artistName);
    patch = { ...patch, ...sp.patch, ext: { ...sp.patch.ext, recheck_at: errors.length ? undefined : now(), recheck_v: errors.length ? undefined : RECHECK_V } };
  }
  return { patch, changed, errors };
}

const slugify = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
/** Apple link whose album name (in the URL) isn't simply this release's title — worth checking. */
export function suspectApple(r: Release) {
  const m = r.links.apple?.match(/\/album\/([^/]+)\/\d+/);
  return !!m && m[1] !== slugify(r.title);
}
/** Bumped when the matching rules change, so the repair job looks again. 2 = whole-name artist check; 3 = no clean versions. */
export const RECHECK_V = 3;
/** Releases the repair job should look at. */
export function needsRecheck(r: Release) {
  return !r.ext.links_manual && r.ext.recheck_v !== RECHECK_V && (!!r.links.apple || !!r.ext.deezer_id || (!!r.ext.mbid && fromCAA(r.artwork_url)));
}
