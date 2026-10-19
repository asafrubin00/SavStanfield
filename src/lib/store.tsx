import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { adapter, emptyData } from './db';
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
  toast: string | null; say(msg: string): void;
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
  createList(name: string, kind: 'list' | 'playlist'): Promise<string>;
  addTracksToList(listId: string, trackIds: string[]): Promise<number>;
}

const Ctx = createContext<Store | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<DataSet>(emptyData);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const dataRef = useRef(data);
  dataRef.current = data;
  const timer = useRef<number>();

  const say = useCallback((msg: string) => {
    setToast(msg);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setToast(null), 3200);
  }, []);

  useEffect(() => {
    adapter.loadAll().then(setData).catch((e) => setError(String(e.message ?? e))).finally(() => setLoading(false));
  }, []);

  const ix = useMemo(() => buildIndex(data), [data]);
  const ixRef = useRef(ix);
  ixRef.current = ix;

  const upsert = useCallback(async <T extends TableName>(table: T, rows: Tables[T][]) => {
    if (!rows.length) return;
    setData((d) => {
      const list = [...(d[table] as { id: string }[])];
      const pos = new Map(list.map((r, i) => [r.id, i]));
      for (const r of rows as { id: string }[]) {
        const i = pos.get(r.id);
        if (i === undefined) { pos.set(r.id, list.length); list.push(r); } else list[i] = r;
      }
      return { ...d, [table]: list };
    });
    try { await adapter.upsert(table, rows); } catch (e) { say(`Not saved: ${(e as Error).message}`); throw e; }
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
  const saveTracksQuiet = useCallback(async (rows: Track[]) => {
    await adapter.upsert('tracks', rows);
    mergeLocal('tracks', rows.filter((t) => t.release_id && loadedReleases.current.has(t.release_id)));
  }, [mergeLocal]);
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

  const createList = useCallback(async (name: string, kind: 'list' | 'playlist') => {
    const id = uid();
    await upsert('lists', [{ id, name: name.trim(), ranked: kind === 'list', kind, created_at: now(), updated_at: now() }]);
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

  const value: Store = { data, ix, loading, error, toast, say, upsert, remove, replaceAll, annotation, annotate, ensureArtist, creditArtist, addToList, deleteRelease, deleteArtist, ensureLabel, setReleaseLabels, setArtistLabels, deleteLabel, loadReleaseTracks, loadTracks, saveTracksQuiet, searchTracks, createList, addTracksToList };
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
