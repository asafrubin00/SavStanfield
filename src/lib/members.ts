import { mbArtistMembers, mbSearchArtists } from './sources';
import { norm, type Index } from './store';
import type { Artist } from './types';

/** A group's member, as stored on the group: linked to an artist in the library when there is one. */
export interface Member { id?: string; name: string; begin?: string; end?: string; mbid?: string }

export const groupMembers = (a: Artist) => ((a.ext.members as Member[] | undefined) ?? []);

/** The groups an artist belongs to (worked out from every group's member list). */
export function groupsOf(ix: Index, artistId: string): { group: Artist; m: Member }[] {
  const me = ix.artists.get(artistId); if (!me) return [];
  const names = new Set([me.name, ...me.aliases].map(norm));
  const out: { group: Artist; m: Member }[] = [];
  for (const g of ix.artists.values()) {
    if (g.id === artistId) continue;
    // Also catch members saved before this artist was in the library (matched by MusicBrainz ID or name)
    const m = groupMembers(g).find((x) => x.id === artistId || (!x.id && ((x.mbid && x.mbid === me.ext.mbid) || names.has(norm(x.name)))));
    if (m) out.push({ group: g, m });
  }
  return out;
}

export const years = (m: Member) => (m.begin || m.end ? `${m.begin?.slice(0, 4) ?? '?'}–${m.end ? m.end.slice(0, 4) : ''}` : '');

/** Point each member at a library artist: by MusicBrainz ID first, then by name or other name. */
export function linkMembers(ix: Index, members: Member[]): Member[] {
  const byMbid = new Map<string, Artist>();
  for (const a of ix.artists.values()) if (a.ext.mbid) byMbid.set(a.ext.mbid as string, a);
  return members.map((m) => {
    const a = (m.mbid && byMbid.get(m.mbid)) || ix.artistByName.get(norm(m.name)) || ix.artistByName.get(norm(m.name).replace(/^the /, ''));
    return a ? { ...m, id: a.id } : { ...m, id: undefined };
  });
}

/**
 * Look a group's members up on MusicBrainz. Returns null when the artist isn't a group (or can't be found),
 * along with the MusicBrainz ID/type so we don't have to ask again.
 */
export async function fetchMembers(ix: Index, a: Artist): Promise<{ members: Member[] | null; mbid?: string; type?: string }> {
  let mbid = a.ext.mbid as string | undefined;
  if (!mbid) {
    const hits = await mbSearchArtists(a.name);
    const hit = hits.find((h) => norm(h.name) === norm(a.name) && h.type === 'Group' && h.score >= 90);
    if (!hit) return { members: null };
    mbid = hit.id;
  }
  const r = await mbArtistMembers(mbid);
  if (r.type !== 'Group' || !r.members.length) return { members: null, mbid, type: r.type };
  const sorted = r.members.sort((x, y) => Number(!!x.end) - Number(!!y.end) || (x.begin ?? '9').localeCompare(y.begin ?? '9') || x.name.localeCompare(y.name));
  return { members: linkMembers(ix, sorted.map((m) => ({ name: m.name, mbid: m.mbid, begin: m.begin, end: m.ended ? m.end ?? '?' : undefined }))), mbid, type: r.type };
}
