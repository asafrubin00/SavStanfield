import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { adapter, emptyData } from './db';
import { annId, norm, now, uid } from './util';
import type { Annotation, Artist, Credit, CriticScore, DataSet, EntityType, ListItem, Release, TableName, Tables, Track } from './types';

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
  };
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
      const existing = dataRef.current[t].map((r) => r.id);
      await adapter.remove(t, existing);
      await adapter.upsert(t, d[t] as never[]);
    }
    setData(d);
  }, []);

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
    const trackIds = d.tracks.filter((t) => t.release_id === id).map((t) => t.id);
    const tset = new Set(trackIds);
    await remove('credits', d.credits.filter((c) => c.release_id === id || (c.track_id && tset.has(c.track_id))).map((c) => c.id));
    await remove('tracks', trackIds);
    await remove('critic_scores', d.critic_scores.filter((s) => s.release_id === id).map((s) => s.id));
    await remove('annotations', [annId('release', id), ...trackIds.map((t) => annId('track', t))].filter((k) => ixRef.current.ann.has(k)));
    await remove('list_items', d.list_items.filter((i) => i.entity_id === id || (i.entity_id && tset.has(i.entity_id))).map((i) => i.id));
    await remove('releases', [id]);
  }, [remove]);

  const deleteArtist = useCallback(async (id: string) => {
    const d = dataRef.current;
    await remove('credits', d.credits.filter((c) => c.artist_id === id).map((c) => c.id));
    await remove('list_items', d.list_items.filter((i) => i.entity_id === id).map((i) => i.id));
    if (ixRef.current.ann.has(annId('artist', id))) await remove('annotations', [annId('artist', id)]);
    await remove('artists', [id]);
  }, [remove]);

  const value: Store = { data, ix, loading, error, toast, say, upsert, remove, replaceAll, annotation, annotate, ensureArtist, creditArtist, addToList, deleteRelease, deleteArtist };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useStore() {
  const s = useContext(Ctx);
  if (!s) throw new Error('useStore outside provider');
  return s;
}

/** Artists credited on a release, by role, in order. */
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
