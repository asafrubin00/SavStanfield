import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { adapter, emptyData } from './db';
import { findReleaseLabels, findTracklist } from './enrich';
import { songFeatures } from './features';
import type { SourceTrack } from './sources';
import { annId, labelKey, norm, now, uid } from './util';
import type { Annotation, Artist, Credit, CriticScore, DataSet, EntityType, Label, ListItem, Release, TableName, Tables, Track } from './types';

function groupBy<T>(rows: T[], key: (r: T) => string | null | undefined) {
  const m = new Map<string, T[]>();
  for (const r of rows) { const k = key(r); if (!k) continue; const a = m.get(k); if (a) a.push(r); else m.set(k, [r]); }
  return m;
}
const byId = <T extends { id: string }>(rows: T[]) => new Map(rows.map((r) => [r.id, r]));

function buildIndex(d: DataSet) {
  return {
    artists: byId(d.artists),
    releases: byId(d.releases),
    tracks: byId(d.tracks),
    lists: byId(d.lists),
    ann: new Map(d.annotations.map((a) => [a.id, a])),
    creditsByRelease: groupBy(d.credits, (c) => c.release_id),
    creditsByTrack: groupBy(d.credits, (c) => c.track_id),
    creditsByArtist: groupBy(d.credits, (c) => c.artist_id),
    tracksByRelease: groupBy(d.tracks, (t) => t.release_id),
    scoresByRelease: groupBy(d.critic_scores, (s) => s.release_id),
    itemsByList: groupBy(d.list_items, (i) => i.list_id),
    artistByName: new Map(d.artists.flatMap((a) => [a.name, ...a.aliases].map((n) => [norm(n), a] as const))),
    labels: byId(d.labels),
    labelByName: new Map(d.labels.flatMap((l) => [l.name, ...l.aliases].map((n) => [labelKey(n), l] as const))),
    releaseLabelsByRelease: groupBy(d.release_labels, (x) => x.release_id),
    releaseLabelsByLabel: groupBy(d.release_labels, (x) => x.label_id),
    artistLabelsByArtist: groupBy(d.artist_labels, (x) => x.artist_id),
    artistLabelsByLabel: groupBy(d.artist_labels, (x) => x.label_id),
    ...recency(d),
  };
}

const releaseDay = (r: Release) => r.date ?? (r.year ? `${r.year}-01-01` : '');
/** Most recent (already out) release date per artist and per label — for "recently released" sorting. */
function recency(d: DataSet) {
  const today = new Date().toISOString().slice(0, 10);
  const rel = new Map(d.releases.map((r) => [r.id, releaseDay(r)]));
  const lastByArtist = new Map<string, string>(); const lastProducedByArtist = new Map<string, string>();
  const trackRel = new Map(d.tracks.map((t) => [t.id, t.release_id]));
  for (const c of d.credits) {
    const rid = c.release_id ?? (c.track_id ? trackRel.get(c.track_id) : null); if (!rid) continue;
    const day = rel.get(rid); if (!day || day > today) continue;
    const m = c.role === 'primary' ? lastByArtist : c.role === 'producer' || c.role === 'exec_producer' ? lastProducedByArtist : null;
    if (m && (m.get(c.artist_id) ?? '') < day) m.set(c.artist_id, day);
  }
  const lastByLabel = new Map<string, string>();
  for (const x of d.release_labels) { const day = rel.get(x.release_id); if (day && day <= today && (lastByLabel.get(x.label_id) ?? '') < day) lastByLabel.set(x.label_id, day); }
  return { lastByArtist, lastProducedByArtist, lastByLabel };
}
export type Index = ReturnType<typeof buildIndex>;
export { norm, annId };


interface Store {
  data: DataSet; ix: Index; loading: boolean; error: string | null;
  toast: string | null; toastAction: { label: string; run: () => void } | null; say(msg: string, action?: { label: string; run: () => void }): void;
  upsert<T extends TableName>(table: T, rows: Tables[T][]): Promise<void>;
  remove(table: TableName, ids: string[]): Promise<void>;
  replaceAll(d: DataSet): Promise<void>;
  annotation(t: EntityType, id: string): Annotation | undefined;
  annotate(t: EntityType, id: string, patch: Partial<Annotation>): Promise<void>;
  ensureArtist(name: string, patch?: Partial<Artist>): { artist: Artist; created: boolean };
  creditArtist(artistId: string, target: { release_id?: string; track_id?: string }, role: Credit['role'], position?: number): Credit | null;
  addToList(listId: string, entity_type: ListItem['entity_type'], entity_id: string): Promise<void>;
  deleteRelease(id: string): Promise<void>;
  deleteArtist(id: string): Promise<void>;
  ensureLabel(name: string): Label;
  setReleaseLabels(releaseId: string, names: string[]): Promise<void>;
  setArtistLabels(artistId: string, names: string[]): Promise<void>;
  deleteLabel(id: string): Promise<void>;
  loadReleaseTracks(releaseIds: string[]): Promise<void>;
  loadTracks(ids: string[]): Promise<void>;
  saveTracksQuiet(rows: Track[]): Promise<void>;
  searchTracks(q: string, limit?: number): Promise<Track[]>;
  createList(name: string, kind: 'list' | 'playlist' | 'artists' | 'folder'): Promise<string>;
  /** Swap a release's tracklist for the one from its current sources. Songs you've rated, credited or put on a list are kept. */
  /** Replace the tracklist from the best source, or a chosen one (tracks already fetched can be passed in). */
  replaceTracklist(release: Release, from?: { source: string; tracks: SourceTrack[] }): Promise<{ added: number; kept: number; source: string | null; producers: number }>;
  /** Re-read labels from the release's current sources and replace the ones found automatically. */
  refreshLabels(release: Release): Promise<string[]>;
  /** Set a song's producers or featured artists to exactly these names (in order). Artists left with nothing are removed. */
  setTrackCredits(trackId: string, role: 'producer' | 'featured' | 'primary', names: string[], opts?: { prune?: boolean }): Promise<string[]>;
  /** Delete these artists if nothing (credits, ratings, notes, lists, labels) refers to them any more. */
  pruneArtists(ids: string[], removedCredits?: Set<string>): Promise<number>;
  /** Move everything credited to `from` onto `into`; `from`'s name becomes one of `into`'s other names. */
  mergeArtists(from: Artist, into: Artist): Promise<void>;
  /** Replace a stuck-together artist ("A & B") with the separate artists on every credit. */
  splitArtist(combo: Artist, parts: Artist[]): Promise<void>;
  /** Turn "(feat. …)" in song titles into featured credits for artists already in the library. Returns credits added. */
  linkFeatures(tracks: Track[], onlyArtistId?: string, extra?: Artist): Promise<number>;
  /** Search every song title for this artist's name (and aliases) and credit their features. */
  findFeaturesFor(artist: Artist): Promise<number>;
  addTracksToList(listId: string, trackIds: string[]): Promise<number>;
}

const Ctx = createContext<Store | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<DataSet>(emptyData);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [toastAction, setToastAction] = useState<{ label: string; run: () => void } | null>(null);
  const dataRef = useRef(data);
  dataRef.current = data;
  const timer = useRef<number>();

  const say = useCallback((msg: string, action?: { label: string; run: () => void }) => {
    setToast(msg); setToastAction(action ?? null);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => { setToast(null); setToastAction(null); }, action ? 6000 : 3200);
  }, []);

  useEffect(() => {
    adapter.loadAll().then(setData).catch((e) => setError(String(e.message ?? e))).finally(() => setLoading(false));
  }, []);

  const ix = useMemo(() => buildIndex(data), [data]);
  const ixRef = useRef(ix);
  ixRef.current = ix;

  const upsert = useCallback(async <T extends TableName>(table: T, rows: Tables[T][]) => {
    if (!rows.length) return;
    const before = dataRef.current[table];
    setData((d) => {
      const list = [...(d[table] as { id: string }[])];
      const pos = new Map(list.map((r, i) => [r.id, i]));
      for (const r of rows as { id: string }[]) {
        const i = pos.get(r.id);
        if (i === undefined) { pos.set(r.id, list.length); list.push(r); } else list[i] = r;
      }
      return { ...d, [table]: list };
    });
    try { await adapter.upsert(table, rows); }
    catch (e) {
      // Don't show changes the database didn't keep
      setData((d) => ({ ...d, [table]: before }));
      say(`Not saved: ${(e as Error).message}`, { label: 'OK', run: () => undefined }); throw e;
    }
  }, [say]);

  const remove = useCallback(async (table: TableName, ids: string[]) => {
    if (!ids.length) return;
    const drop = new Set(ids);
    setData((d) => ({ ...d, [table]: (d[table] as { id: string }[]).filter((r) => !drop.has(r.id)) }));
    try { await adapter.remove(table, ids); } catch (e) { say(`Not deleted: ${(e as Error).message}`); throw e; }
  }, [say]);

  const replaceAll = useCallback(async (d: DataSet) => {
    for (const t of Object.keys(d) as TableName[]) {
      await adapter.clear(t);
      await adapter.upsert(t, d[t] as never[]);
    }
    loadedReleases.current.clear();
    setData(d);
  }, []);

  /** Merge rows into memory without saving (they came from the database). */
  const mergeLocal = useCallback(<T extends TableName>(table: T, rows: Tables[T][]) => {
    if (!rows.length) return;
    setData((d) => {
      const list = [...(d[table] as { id: string }[])];
      const pos = new Map(list.map((r, i) => [r.id, i]));
      for (const r of rows as { id: string }[]) { const i = pos.get(r.id); if (i === undefined) { pos.set(r.id, list.length); list.push(r); } else list[i] = r; }
      return { ...d, [table]: list };
    });
  }, []);
  const loadedReleases = useRef(new Set<string>());
  const loadReleaseTracks = useCallback(async (releaseIds: string[]) => {
    const want = releaseIds.filter((id) => !loadedReleases.current.has(id));
    if (!want.length) return;
    want.forEach((id) => loadedReleases.current.add(id));
    try { mergeLocal('tracks', await adapter.tracksForReleases(want)); }
    catch (e) { want.forEach((id) => loadedReleases.current.delete(id)); say(`Couldn't load tracks: ${(e as Error).message}`); }
  }, [mergeLocal, say]);
  const loadTracks = useCallback(async (ids: string[]) => {
    const want = ids.filter((id) => !ixRef.current.tracks.has(id));
    if (want.length) mergeLocal('tracks', await adapter.tracksByIds(want));
  }, [mergeLocal]);
  /** Save tracks from a background job; only keep them in memory if their album is open/loaded. */
  const linkFeatures = useCallback(async (tracks: Track[], onlyArtistId?: string, extra?: Artist) => {
    const ix0 = ixRef.current;
    const extraNames = new Set(extra ? [extra.name, ...extra.aliases].map(norm) : []);
    const lookup = (n: string) => (extraNames.has(norm(n)) ? extra : undefined) ?? ix0.artistByName.get(norm(n)) ?? ix0.artistByName.get(norm(n).replace(/^the /, ''));
    const rows: Credit[] = []; const touched: Track[] = [];
    for (const t of tracks) {
      if (t.ext.feats_manual) continue; // you've set this song's features by hand
      const { matched } = songFeatures(t.title, t.artist_credit, lookup);
      if (!matched.length) continue;
      const leads = new Set(t.release_id ? (ix0.creditsByRelease.get(t.release_id) ?? []).filter((c) => c.role === 'primary').map((c) => c.artist_id) : []);
      const have = (ix0.creditsByTrack.get(t.id) ?? []).filter((c) => c.role === 'featured');
      let pos = have.length; let added = false;
      for (const a of matched) {
        if (leads.has(a.id) || (onlyArtistId && a.id !== onlyArtistId) || have.some((c) => c.artist_id === a.id) || rows.some((c) => c.track_id === t.id && c.artist_id === a.id)) continue;
        rows.push({ id: uid(), artist_id: a.id, release_id: null, track_id: t.id, role: 'featured', position: pos++ }); added = true;
      }
      if (added) touched.push(t);
    }
    if (rows.length) { await upsert('credits', rows); mergeLocal('tracks', touched); }
    return rows.length;
  }, [upsert, mergeLocal]);

  const findFeaturesFor = useCallback(async (artist: Artist) => {
    const found = new Map<string, Track>();
    for (const n of [artist.name, ...artist.aliases]) if (n.trim().length >= 2) for (const t of await adapter.tracksFeaturing(n.trim())) found.set(t.id, t);
    return linkFeatures([...found.values()], artist.id, artist);
  }, [linkFeatures]);

  const saveTracksQuiet = useCallback(async (rows: Track[]) => {
    await adapter.upsert('tracks', rows);
    mergeLocal('tracks', rows.filter((t) => t.release_id && loadedReleases.current.has(t.release_id)));
    await linkFeatures(rows);
  }, [mergeLocal, linkFeatures]);
  const searchTracks = useCallback(async (q: string, limit?: number) => {
    const found = await adapter.searchTracks(q, limit);
    mergeLocal('tracks', found);
    return found;
  }, [mergeLocal]);

  const annotation = useCallback((t: EntityType, id: string) => ixRef.current.ann.get(annId(t, id)), []);

  const annotate = useCallback(async (t: EntityType, id: string, patch: Partial<Annotation>) => {
    const key = annId(t, id);
    const cur = ixRef.current.ann.get(key) ?? { id: key, entity_type: t, entity_id: id, favorite: false };
    await upsert('annotations', [{ ...cur, ...patch, updated_at: now() }]);
  }, [upsert]);

  // Pending (not yet committed) artists created during a batch, so repeated names resolve to one record.
  const pendingArtists = useRef(new Map<string, Artist>());
  const ensureArtist = useCallback((name: string, patch: Partial<Artist> = {}) => {
    const k = norm(name);
    const found = ixRef.current.artistByName.get(k) ?? pendingArtists.current.get(k);
    if (found) return { artist: found, created: false };
    const artist: Artist = { id: uid(), name: name.trim(), is_producer: false, aliases: [], links: {}, ext: {}, created_at: now(), updated_at: now(), ...patch };
    pendingArtists.current.set(k, artist);
    void upsert('artists', [artist]).finally(() => pendingArtists.current.delete(k));
    return { artist, created: true };
  }, [upsert]);

  const creditArtist = useCallback((artistId: string, target: { release_id?: string; track_id?: string }, role: Credit['role'], position = 0) => {
    const existing = target.release_id ? ixRef.current.creditsByRelease.get(target.release_id) : ixRef.current.creditsByTrack.get(target.track_id!);
    if (existing?.some((c) => c.artist_id === artistId && c.role === role)) return null;
    const c: Credit = { id: uid(), artist_id: artistId, release_id: target.release_id ?? null, track_id: target.track_id ?? null, role, position };
    void upsert('credits', [c]);
    if (role === 'producer' || role === 'exec_producer') {
      const a = ixRef.current.artists.get(artistId);
      if (a && !a.is_producer) void upsert('artists', [{ ...a, is_producer: true, updated_at: now() }]);
    }
    return c;
  }, [upsert]);

  const addToList = useCallback(async (listId: string, entity_type: ListItem['entity_type'], entity_id: string) => {
    const items = ixRef.current.itemsByList.get(listId) ?? [];
    if (items.some((i) => i.entity_id === entity_id)) { say('Already on that list'); return; }
    const position = items.reduce((m, i) => Math.max(m, i.position), 0) + 1;
    await upsert('list_items', [{ id: uid(), list_id: listId, entity_type, entity_id, position }]);
    say(`Added to ${ixRef.current.lists.get(listId)?.name ?? 'list'}`);
  }, [upsert, say]);

  const deleteRelease = useCallback(async (id: string) => {
    const d = dataRef.current;
    const trackIds = [...new Set([...d.tracks.filter((t) => t.release_id === id).map((t) => t.id), ...(await adapter.tracksForReleases([id])).map((t) => t.id)])];
    const tset = new Set(trackIds);
    await remove('credits', d.credits.filter((c) => c.release_id === id || (c.track_id && tset.has(c.track_id))).map((c) => c.id));
    await remove('tracks', trackIds);
    await remove('critic_scores', d.critic_scores.filter((s) => s.release_id === id).map((s) => s.id));
    await remove('annotations', [annId('release', id), ...trackIds.map((t) => annId('track', t))].filter((k) => ixRef.current.ann.has(k)));
    await remove('list_items', d.list_items.filter((i) => i.entity_id === id || (i.entity_id && tset.has(i.entity_id))).map((i) => i.id));
    await remove('release_labels', d.release_labels.filter((x) => x.release_id === id).map((x) => x.id)).catch(() => undefined);
    await remove('releases', [id]);
  }, [remove]);

  const deleteArtist = useCallback(async (id: string) => {
    const d = dataRef.current;
    await remove('credits', d.credits.filter((c) => c.artist_id === id).map((c) => c.id));
    await remove('list_items', d.list_items.filter((i) => i.entity_id === id).map((i) => i.id));
    if (ixRef.current.ann.has(annId('artist', id))) await remove('annotations', [annId('artist', id)]);
    await remove('artist_labels', d.artist_labels.filter((x) => x.artist_id === id).map((x) => x.id)).catch(() => undefined);
    await remove('artists', [id]);
  }, [remove]);

  const pendingLabels = useRef(new Map<string, Label>());
  const ensureLabel = useCallback((name: string) => {
    const k = labelKey(name);
    const found = ixRef.current.labelByName.get(k) ?? pendingLabels.current.get(k);
    if (found) return found;
    const l: Label = { id: uid(), name: name.trim(), aliases: [], links: {}, ext: {}, created_at: now(), updated_at: now() };
    pendingLabels.current.set(k, l);
    void upsert('labels', [l]).finally(() => pendingLabels.current.delete(k));
    return l;
  }, [upsert]);

  const setReleaseLabels = useCallback(async (releaseId: string, names: string[]) => {
    const want = [...new Set(names.map((n) => n.trim()).filter(Boolean))].map((n) => ensureLabel(n));
    const cur = ixRef.current.releaseLabelsByRelease.get(releaseId) ?? [];
    await remove('release_labels', cur.filter((x) => !want.some((l) => l.id === x.label_id)).map((x) => x.id));
    await upsert('release_labels', want.filter((l) => !cur.some((x) => x.label_id === l.id)).map((l) => ({ id: uid(), release_id: releaseId, label_id: l.id })));
  }, [ensureLabel, remove, upsert]);

  const setArtistLabels = useCallback(async (artistId: string, names: string[]) => {
    const want = [...new Set(names.map((n) => n.trim()).filter(Boolean))].map((n) => ensureLabel(n));
    const cur = ixRef.current.artistLabelsByArtist.get(artistId) ?? [];
    await remove('artist_labels', cur.filter((x) => !want.some((l) => l.id === x.label_id)).map((x) => x.id));
    await upsert('artist_labels', want.filter((l) => !cur.some((x) => x.label_id === l.id)).map((l) => ({ id: uid(), artist_id: artistId, label_id: l.id })));
  }, [ensureLabel, remove, upsert]);

  const deleteLabel = useCallback(async (id: string) => {
    const d = dataRef.current;
    await remove('release_labels', d.release_labels.filter((x) => x.label_id === id).map((x) => x.id));
    await remove('artist_labels', d.artist_labels.filter((x) => x.label_id === id).map((x) => x.id));
    await remove('list_items', d.list_items.filter((i) => i.entity_id === id).map((i) => i.id));
    if (ixRef.current.ann.has(annId('label', id))) await remove('annotations', [annId('label', id)]);
    await remove('labels', [id]);
  }, [remove]);

  const replaceTracklist = useCallback(async (release: Release, from?: { source: string; tracks: SourceTrack[] }) => {
    const res = from ?? await findTracklist(release);
    if (!res.tracks.length) return { added: 0, kept: 0, source: null, producers: 0 };
    const existing = await adapter.tracksForReleases([release.id]);
    const d = dataRef.current;
    const used = new Set<string>([
      ...d.annotations.filter((a) => a.entity_type === 'track').map((a) => a.entity_id),
      ...d.list_items.filter((i) => i.entity_type === 'track' && i.entity_id).map((i) => i.entity_id!),
      ...d.credits.filter((c) => c.track_id).map((c) => c.track_id!),
    ]);
    const keep = existing.filter((t) => used.has(t.id));
    const keepByTitle = new Map(keep.map((t) => [norm(t.title), t]));
    const albumArtist = norm(release.artist_credit ?? '');
    const fresh: Track[] = []; const updated: Track[] = []; const prod: [string, string[]][] = [];
    for (const t of res.tracks) {
      const k = keepByTitle.get(norm(t.title));
      if (t.producers?.length) prod.push([k?.id ?? '', t.producers]);
      const base = { disc: t.disc, number: t.number, duration_ms: t.ms, artist_credit: t.artist && norm(t.artist) !== albumArtist ? t.artist : null, updated_at: now() };
      if (k) { updated.push({ ...k, ...base, links: { ...k.links, ...t.links }, ext: { ...k.ext, ...t.ext, stale: undefined } }); keepByTitle.delete(norm(t.title)); }
      else { fresh.push({ id: uid(), release_id: release.id, title: t.title, ...base, links: t.links, ext: t.ext, created_at: now() }); if (t.producers?.length) prod[prod.length - 1][0] = fresh[fresh.length - 1].id; }
    }
    // Songs you'd rated that aren't on the right tracklist stay, marked so you can tidy them
    for (const k of keepByTitle.values()) updated.push({ ...k, ext: { ...k.ext, stale: true }, updated_at: now() });
    const drop = existing.filter((t) => !used.has(t.id)).map((t) => t.id);
    if (drop.length) { await adapter.remove('tracks', drop); setData((x) => ({ ...x, tracks: x.tracks.filter((t) => !drop.includes(t.id)) })); }
    await adapter.upsert('tracks', [...updated, ...fresh]);
    if (loadedReleases.current.has(release.id)) mergeLocal('tracks', [...updated, ...fresh]);
    const cur = ixRef.current.releases.get(release.id) ?? release;
    await upsert('releases', [{ ...cur, ext: { ...cur.ext, tracks_at: now(), track_count: res.tracks.length, tracks_src: res.source ?? undefined }, updated_at: now() }]);
    // Producer credits that came with the tracklist (Wikipedia lists them per song)
    let producers = 0;
    for (const [trackId, names] of prod) {
      if (!trackId || (ixRef.current.creditsByTrack.get(trackId) ?? []).some((c) => c.role === 'producer')) continue;
      names.forEach((n, i) => { const { artist } = ensureArtist(n, { is_producer: true }); if (creditArtist(artist.id, { track_id: trackId }, 'producer', i)) producers++; });
    }
    await linkFeatures([...updated, ...fresh]);
    return { added: fresh.length, kept: keep.length, source: res.source, producers };
  }, [mergeLocal, upsert, ensureArtist, creditArtist, linkFeatures]);

  const mergeArtists = useCallback(async (from: Artist, into: Artist) => {
    const d = dataRef.current; const i0 = ixRef.current;
    const have = new Set((i0.creditsByArtist.get(into.id) ?? []).map((c) => `${c.role}|${c.release_id ?? ''}|${c.track_id ?? ''}`));
    const mine = i0.creditsByArtist.get(from.id) ?? [];
    const dup = mine.filter((c) => have.has(`${c.role}|${c.release_id ?? ''}|${c.track_id ?? ''}`));
    await upsert('credits', mine.filter((c) => !dup.includes(c)).map((c) => ({ ...c, artist_id: into.id })));
    if (dup.length) await remove('credits', dup.map((c) => c.id));
    await upsert('artists', [{ ...into, aliases: [...new Set([...into.aliases, from.name, ...from.aliases])].filter((n) => norm(n) !== norm(into.name)), is_producer: into.is_producer || from.is_producer, links: { ...from.links, ...into.links }, image_url: into.image_url ?? from.image_url, bio: into.bio ?? from.bio, ext: { ...from.ext, ...into.ext }, updated_at: now() }]);
    const ann = i0.ann.get(annId('artist', from.id));
    if (ann && !i0.ann.get(annId('artist', into.id))) await upsert('annotations', [{ ...ann, id: annId('artist', into.id), entity_id: into.id }]);
    await upsert('list_items', d.list_items.filter((x) => x.entity_type === 'artist' && x.entity_id === from.id).map((x) => ({ ...x, entity_id: into.id })));
    await upsert('concerts', d.concerts.filter((c) => c.artist_id === from.id).map((c) => ({ ...c, artist_id: into.id })));
    await upsert('artist_labels', d.artist_labels.filter((x) => x.artist_id === from.id).map((x) => ({ ...x, artist_id: into.id }))).catch(() => undefined);
    // Groups that listed the old entry as a member now point at the one we kept
    const groups = d.artists.filter((g) => ((g.ext.members as { id?: string }[] | undefined) ?? []).some((m) => m.id === from.id));
    if (groups.length) await upsert('artists', groups.map((g) => ({ ...g, ext: { ...g.ext, members: (g.ext.members as { id?: string }[]).map((m) => (m.id === from.id ? { ...m, id: into.id } : m)) }, updated_at: now() })));
    if (ann) await remove('annotations', [ann.id]);
    await remove('artists', [from.id]);
  }, [upsert, remove]);

  const splitArtist = useCallback(async (combo: Artist, parts: Artist[]) => {
    const i0 = ixRef.current;
    const rows: Credit[] = [];
    for (const c of i0.creditsByArtist.get(combo.id) ?? []) {
      const target = c.release_id ? i0.creditsByRelease.get(c.release_id) : i0.creditsByTrack.get(c.track_id ?? '');
      parts.forEach((p, n) => {
        if (target?.some((x) => x.artist_id === p.id && x.role === c.role) || rows.some((x) => x.artist_id === p.id && x.role === c.role && x.release_id === c.release_id && x.track_id === c.track_id)) return;
        rows.push({ id: uid(), artist_id: p.id, release_id: c.release_id ?? null, track_id: c.track_id ?? null, role: c.role, position: c.position + n });
      });
    }
    await upsert('credits', rows);
    await deleteArtist(combo.id);
  }, [upsert, deleteArtist]);

  const pruneArtists = useCallback(async (ids: string[], removedCredits: Set<string> = new Set()) => {
    await new Promise((r) => setTimeout(r, 50)); // let the latest saves reach the in-memory data
    const d = dataRef.current; let n = 0;
    for (const id of new Set(ids)) {
      const used = d.credits.some((c) => c.artist_id === id && !removedCredits.has(c.id)) || ixRef.current.ann.has(annId('artist', id))
        || d.list_items.some((i) => i.entity_id === id) || d.artist_labels.some((x) => x.artist_id === id);
      if (!used && ixRef.current.artists.has(id)) { await deleteArtist(id); n++; }
    }
    return n;
  }, [deleteArtist]);

  const setTrackCredits = useCallback(async (trackId: string, role: 'producer' | 'featured' | 'primary', names: string[], opts: { prune?: boolean } = {}) => {
    const cur = (ixRef.current.creditsByTrack.get(trackId) ?? []).filter((c) => c.role === role);
    const want = [...new Map(names.map((n) => n.trim()).filter(Boolean).map((n) => [norm(n), n])).values()];
    const ids = want.map((n) => ensureArtist(n, role === 'producer' ? { is_producer: true } : {}).artist.id);
    const drop = cur.filter((c) => !ids.includes(c.artist_id));
    if (drop.length) await remove('credits', drop.map((c) => c.id));
    const rows: Credit[] = ids.map((artist_id, position) => ({ ...(cur.find((c) => c.artist_id === artist_id) ?? { id: uid(), artist_id, release_id: null, track_id: trackId, role }), position }));
    await upsert('credits', rows);
    if (role === 'featured') { const t = ixRef.current.tracks.get(trackId); if (t && !t.ext.feats_manual) await upsert('tracks', [{ ...t, ext: { ...t.ext, feats_manual: true }, updated_at: now() }]); }
    if (role === 'producer') for (const id of ids) { const a = ixRef.current.artists.get(id); if (a && !a.is_producer) await upsert('artists', [{ ...a, is_producer: true, updated_at: now() }]); }
    // Tidy up: an artist with nothing else pointing at them only existed because of the removed credit
    const gone = drop.map((c) => c.artist_id).filter((id) => !ids.includes(id));
    if (opts.prune !== false && gone.length) await pruneArtists(gone, new Set(drop.map((c) => c.id)));
    return gone;
  }, [ensureArtist, remove, upsert, pruneArtists]);

  const refreshLabels = useCallback(async (release: Release) => {
    const res = await findReleaseLabels(release);
    if (res.names.length) await setReleaseLabels(release.id, res.names);
    return res.names;
  }, [setReleaseLabels]);

  const createList = useCallback(async (name: string, kind: 'list' | 'playlist' | 'artists' | 'folder') => {
    const id = uid();
    await upsert('lists', [{ id, name: name.trim(), ranked: false, kind, created_at: now(), updated_at: now() }]);
    return id;
  }, [upsert]);
  const addTracksToList = useCallback(async (listId: string, trackIds: string[]) => {
    const items = ixRef.current.itemsByList.get(listId) ?? [];
    const have = new Set(items.map((i) => i.entity_id));
    let pos = items.reduce((m, i) => Math.max(m, i.position), 0);
    const add = [...new Set(trackIds)].filter((t) => !have.has(t)).map((t) => ({ id: uid(), list_id: listId, entity_type: 'track' as const, entity_id: t, position: ++pos }));
    await upsert('list_items', add);
    const l = ixRef.current.lists.get(listId);
    if (l) await upsert('lists', [{ ...l, updated_at: now() }]);
    say(add.length ? `Added ${add.length === 1 ? '1 song' : `${add.length} songs`} to ${l?.name ?? 'playlist'}` : 'Already on that playlist');
    return add.length;
  }, [upsert, say]);

  const value: Store = { data, ix, loading, error, toast, toastAction, say, upsert, remove, replaceAll, annotation, annotate, ensureArtist, creditArtist, addToList, deleteRelease, deleteArtist, ensureLabel, setReleaseLabels, setArtistLabels, deleteLabel, loadReleaseTracks, loadTracks, saveTracksQuiet, searchTracks, createList, addTracksToList, replaceTracklist, refreshLabels, setTrackCredits, pruneArtists, mergeArtists, splitArtist, linkFeatures, findFeaturesFor };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useStore() {
  const s = useContext(Ctx);
  if (!s) throw new Error('useStore outside provider');
  return s;
}

/** Artists credited on a release, by role, in order. */
export function releaseLabels(ix: Index, releaseId: string): Label[] {
  return (ix.releaseLabelsByRelease.get(releaseId) ?? []).map((x) => ix.labels.get(x.label_id)).filter(Boolean) as Label[];
}
/** An artist's labels: ones you've set on the artist, then ones from their releases (most releases first). */
export function artistLabels(ix: Index, artistId: string): { label: Label; manual: boolean; n: number }[] {
  const out = new Map<string, { label: Label; manual: boolean; n: number }>();
  for (const x of ix.artistLabelsByArtist.get(artistId) ?? []) { const l = ix.labels.get(x.label_id); if (l) out.set(l.id, { label: l, manual: true, n: 0 }); }
  for (const c of ix.creditsByArtist.get(artistId) ?? []) {
    if (c.role !== 'primary' || !c.release_id) continue;
    for (const x of ix.releaseLabelsByRelease.get(c.release_id) ?? []) {
      const l = ix.labels.get(x.label_id); if (!l) continue;
      const e = out.get(l.id) ?? { label: l, manual: false, n: 0 }; e.n++; out.set(l.id, e);
    }
  }
  return [...out.values()].sort((a, b) => Number(b.manual) - Number(a.manual) || b.n - a.n);
}
export function releaseArtists(ix: Index, releaseId: string, role: Credit['role'] = 'primary'): Artist[] {
  return (ix.creditsByRelease.get(releaseId) ?? [])
    .filter((c) => c.role === role).sort((a, b) => a.position - b.position)
    .map((c) => ix.artists.get(c.artist_id)).filter(Boolean) as Artist[];
}
export function trackArtists(ix: Index, trackId: string, role: Credit['role']): Artist[] {
  return (ix.creditsByTrack.get(trackId) ?? [])
    .filter((c) => c.role === role).sort((a, b) => a.position - b.position)
    .map((c) => ix.artists.get(c.artist_id)).filter(Boolean) as Artist[];
}
export type { Release, Track, CriticScore };

/** Whether an artist appears on the Artists page: your setting if you've made one, otherwise only if they have a release of their own. */
export function shownInArtists(ix: Index, a: Artist): boolean {
  const pick = a.ext.show_in_artists as 'always' | 'never' | undefined;
  if (pick) return pick === 'always';
  return (ix.creditsByArtist.get(a.id) ?? []).some((c) => c.role === 'primary' && !!c.release_id);
}
