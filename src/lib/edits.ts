import { useCallback } from 'react';
import { autoSplit, parseArtistCredit } from './importSheet';
import { norm, useStore } from './store';
import type { Release, Track } from './types';
import { now, uid } from './util';

/** "2017", "2017-11-27", "27 Nov 2017", "Nov 2017" → { date, year }; null if it can't be read. Empty clears it. */
export function parseWhen(s: string): { date: string | null; year: number | null } | null {
  const t = s.trim();
  if (!t) return { date: null, year: null };
  if (/^\d{4}$/.test(t)) return { date: null, year: Number(t) };
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return { date: t, year: Number(t.slice(0, 4)) };
  const d = new Date(`${t} 12:00`);
  if (Number.isNaN(d.getTime())) return null;
  const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return { date: iso, year: d.getFullYear() };
}

/** Quick edits from tables: each saves straight away, the same way the full Edit forms do. */
export function useEdits() {
  const st = useStore();
  const saveRelease = useCallback((r: Release, patch: Partial<Release>) => st.upsert('releases', [{ ...st.ix.releases.get(r.id) ?? r, ...patch, updated_at: now() }]), [st]);
  const saveTrack = useCallback((t: Track, patch: Partial<Track>) => st.upsert('tracks', [{ ...st.ix.tracks.get(t.id) ?? t, ...patch, updated_at: now() }]), [st]);

  /** New artist text for a release: re-credits it (two artists or one, by the release's own choice or the usual rule). */
  const setReleaseArtist = useCallback(async (r: Release, credit: string) => {
    credit = credit.trim(); if (!credit || credit === r.artist_credit) return;
    await saveRelease(r, { artist_credit: credit });
    const oldC = (st.ix.creditsByRelease.get(r.id) ?? []).filter((c) => c.role === 'primary');
    await st.remove('credits', oldC.map((c) => c.id));
    const split = (r.ext.credit_split as boolean | undefined) ?? autoSplit(credit, r.type, (n) => st.ix.artistByName.has(norm(n)));
    const { names, group } = parseArtistCredit(credit, split);
    const ids = [...(group ? [group] : []), ...names].map((n, i) => { const id = st.ensureArtist(n).artist.id; st.creditArtist(id, { release_id: r.id }, 'primary', i); return id; });
    void st.pruneArtists(oldC.map((c) => c.artist_id).filter((id) => !ids.includes(id)), new Set(oldC.map((c) => c.id)));
  }, [st, saveRelease]);

  const setExecProducers = useCallback(async (r: Release, names: string[]) => {
    const old = (st.ix.creditsByRelease.get(r.id) ?? []).filter((c) => c.role === 'exec_producer');
    await st.remove('credits', old.map((c) => c.id));
    const ids = names.map((n, i) => { const id = st.ensureArtist(n, { is_producer: true }).artist.id; st.creditArtist(id, { release_id: r.id }, 'exec_producer', i); return id; });
    void st.pruneArtists(old.map((c) => c.artist_id).filter((id) => !ids.includes(id)), new Set(old.map((c) => c.id)));
  }, [st]);

  /** The one song on a single that has no tracklist yet, made from the single's title so it can carry credits. */
  const ensureOnlyTrack = useCallback(async (r: Release, title: string): Promise<Track> => {
    const have = st.ix.tracksByRelease.get(r.id) ?? [];
    if (have.length) return have[0];
    const t: Track = { id: uid(), release_id: r.id, disc: null, number: 1, title, artist_credit: null, duration_ms: null, links: {}, ext: { manual: true }, created_at: now(), updated_at: now() };
    await st.upsert('tracks', [t]);
    return t;
  }, [st]);

  return {
    renameRelease: (r: Release, title: string) => (title.trim() && title.trim() !== r.title ? saveRelease(r, { title: title.trim() }) : Promise.resolve()),
    setReleaseWhen: async (r: Release, s: string) => { const w = parseWhen(s); if (!w) { st.say(`Couldn't read “${s}” as a date — try 2017-11-27, 27 Nov 2017 or 2017`); return; } await saveRelease(r, w); },
    setReleaseType: (r: Release, type: string) => saveRelease(r, { type }),
    setReleaseCover: (r: Release, url: string | null) => saveRelease(r, { artwork_url: url, ext: { ...r.ext, art_manual: url ? now() : undefined } }),
    setReleaseArtist, setExecProducers, ensureOnlyTrack,
    renameTrack: (t: Track, title: string) => (title.trim() && title.trim() !== t.title ? saveTrack(t, { title: title.trim() }) : Promise.resolve()),
    setTrackArtists: async (t: Track, names: string[]) => { await st.setTrackCredits(t.id, 'primary', names); await saveTrack(t, { artist_credit: names.length ? names.join(' & ') : null }); },
    setTrackPeople: (t: Track, role: 'featured' | 'producer', names: string[]) => st.setTrackCredits(t.id, role, names),
  };
}
