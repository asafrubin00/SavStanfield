import type { LinkKey, Links } from './types';

export const LINK_META: { key: LinkKey; label: string }[] = [
  { key: 'apple', label: 'Apple Music' },
  { key: 'genius', label: 'Genius' },
  { key: 'youtube', label: 'YouTube' },
  { key: 'soundcloud', label: 'SoundCloud' },
  { key: 'wikipedia', label: 'Wikipedia' },
  { key: 'rym', label: 'RYM' },
  { key: 'aoty', label: 'AOTY' },
  { key: 'pitchfork', label: 'Pitchfork' },
  { key: 'metacritic', label: 'Metacritic' },
  { key: 'spotify', label: 'Spotify' },
  { key: 'discogs', label: 'Discogs' },
  { key: 'musicbrainz', label: 'MusicBrainz' },
  { key: 'deezer', label: 'Deezer' },
  { key: 'instagram', label: 'Instagram' },
  { key: 'website', label: 'Website' },
];

const e = encodeURIComponent;

/** Search pages for any link we haven't pinned to an exact page yet. */
export function searchLinks(kind: 'artist' | 'release' | 'track' | 'label', name: string, artist?: string): Partial<Record<LinkKey, string>> {
  const both = artist ? `${artist} ${name}` : name;
  if (kind === 'label') return {
    wikipedia: `https://en.wikipedia.org/w/index.php?search=${e(`${name} record label`)}`,
    discogs: `https://www.discogs.com/search/?q=${e(name)}&type=label`,
    musicbrainz: `https://musicbrainz.org/search?query=${e(name)}&type=label`,
    rym: `https://rateyourmusic.com/search?searchterm=${e(name)}&searchtype=b`,
    instagram: `https://www.instagram.com/explore/search/keyword/?q=${e(name)}`,
  };
  return {
    apple: `https://music.apple.com/gb/search?term=${e(both)}`,
    genius: `https://genius.com/search?q=${e(both)}`,
    youtube: `https://www.youtube.com/results?search_query=${e(both)}`,
    wikipedia: `https://en.wikipedia.org/w/index.php?search=${e(kind === 'artist' ? `${name} rapper` : `${name} ${artist ?? ''} ${kind === 'release' ? 'album' : 'song'}`)}`,
    rym: `https://rateyourmusic.com/search?searchterm=${e(both)}&searchtype=${kind === 'artist' ? 'a' : kind === 'release' ? 'l' : 'z'}`,
    aoty: `https://www.albumoftheyear.org/search/?q=${e(both)}`,
    pitchfork: `https://pitchfork.com/search/?q=${e(both)}`,
    metacritic: `https://www.metacritic.com/search/${e(both)}/?category=10`,
    spotify: `https://open.spotify.com/search/${e(both)}`,
    soundcloud: `https://soundcloud.com/search${kind === 'artist' ? '/people' : kind === 'release' ? '/albums' : '/sounds'}?q=${e(both)}`,
    discogs: `https://www.discogs.com/search/?q=${e(both)}&type=all`,
    musicbrainz: `https://musicbrainz.org/search?query=${e(name)}&type=${kind === 'artist' ? 'artist' : kind === 'release' ? 'release_group' : 'recording'}`,
  };
}

export const fantanoSearch = (title: string, artist: string) =>
  `https://www.youtube.com/results?search_query=${e(`theneedledrop ${artist} ${title} review`)}`;

/** Merge links without overwriting ones you've already set. */
export function mergeLinks(cur: Links, found: Links): Links {
  const out = { ...cur };
  for (const [k, v] of Object.entries(found) as [LinkKey, string][]) if (v && !out[k]) out[k] = v;
  return out;
}
