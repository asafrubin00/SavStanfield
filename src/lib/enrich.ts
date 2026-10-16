import { mergeLinks } from './links';
import {
  appleFindAlbum, appleSearchArtists, artistMatch, deezerAlbum, deezerArtist, geniusSearch, geniusSong,
  mbLinks, mbSearchArtists, mbSearchGroups, titleScore, wikiSearch, wikiSummary, wikidataToWikipedia,
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
