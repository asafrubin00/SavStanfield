import { mergeLinks } from './links';
import {
  appleAlbumLabel, appleFindAlbum, appleSearchArtists, deezerAlbumLabel, mbGroupLabels, soundcloudSearch, ARTIST_OK, artistMatch, bestMatch, caaCover, deezerAlbum, deezerArtist, deezerSearchAlbums,
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
  const g = mb?.find((x) => (x.score ?? 0) >= 85 && titleScore(x.title, rel.title) >= 0.8 && artistMatch(x.artist, artistName));
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
      if (s?.album && titleScore(s.album.name, rel.title) >= 0.8) { links = mergeLinks(links, { genius: s.album.url }); found.push('Genius'); }
    }
  }
  if (opts.wiki !== false && !links.wikipedia) {
    const pages = await safe(wikiSearch(`${rel.title} ${artistName} album`), errors, 'Wikipedia');
    const p = pages?.find((x) => titleScore(x.title.replace(/\s*\(.*\)$/, ''), rel.title) >= 0.99 && /(album|mixtape|ep\b|extended play)/i.test(x.description) && (x.description.toLowerCase().includes(norm(artistName).split(' ')[0]) || /\(.*album\)/i.test(x.title)));
    if (p) { links = mergeLinks(links, { wikipedia: p.url }); found.push('Wikipedia'); }
  }
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
