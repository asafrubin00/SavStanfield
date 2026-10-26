import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { get, set } from 'idb-keyval';
import { TABLES, type DataSet, type TableName, type Tables, type Track } from './types';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const supabase: SupabaseClient | null = url && key ? createClient(url, key) : null;
export const mode: 'cloud' | 'local' = supabase ? 'cloud' : 'local';

export function emptyData(): DataSet {
  return Object.fromEntries(TABLES.map((t) => [t, []])) as unknown as DataSet;
}

export interface Adapter {
  /** Everything except the bulk of the tracks (only tracks referenced elsewhere are loaded up front). */
  loadAll(): Promise<DataSet>;
  upsert<T extends TableName>(table: T, rows: Tables[T][]): Promise<void>;
  remove(table: TableName, ids: string[]): Promise<void>;
  /** Delete every row of a table (used when restoring a backup). */
  clear(table: TableName): Promise<void>;
  tracksForReleases(releaseIds: string[]): Promise<Track[]>;
  tracksByIds(ids: string[]): Promise<Track[]>;
  searchTracks(q: string, limit?: number): Promise<Track[]>;
  allTracks(): Promise<Track[]>;
  /** Songs whose title has "feat./ft./with …name…", or whose own artist credit names them. */
  tracksFeaturing(name: string): Promise<Track[]>;
  /** Ask the database directly: how many reviews it holds, and which of these annotation ids have a review. */
  reviewCheck(ids?: string[]): Promise<{ total: number; found: number }>;
}

const CHUNK = 500;
const OPTIONAL: TableName[] = ['labels', 'release_labels', 'artist_labels'];
/** Tables the database doesn't have yet (their setup SQL hasn't been run). */
export const missingTables = new Set<TableName>();
/** Columns added in later updates that the database doesn't have yet. */
export const missingColumns = new Set<string>();

/** Strip the owner column Supabase returns; the app never needs it. */
function clean<T>(row: T & { owner?: string }): T {
  const { owner: _o, ...rest } = row;
  void _o;
  return rest as T;
}

async function pageAll<T>(build: (from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build(from, from + 999);
    if (error) throw new Error(error.message);
    rows.push(...(data ?? []).map((r) => clean(r as T & { owner?: string })));
    if ((data ?? []).length < 1000) break;
  }
  return rows;
}
async function inChunks<T>(ids: string[], size: number, fn: (chunk: string[]) => Promise<T[]>): Promise<T[]> {
  const parts: Promise<T[]>[] = [];
  for (let i = 0; i < ids.length; i += size) parts.push(fn(ids.slice(i, i + size)));
  return (await Promise.all(parts)).flat();
}
const cloudTracks = (q: (b: ReturnType<NonNullable<typeof supabase>['from']>) => ReturnType<ReturnType<NonNullable<typeof supabase>['from']>['select']>) => q(supabase!.from('tracks'));

const cloudAdapter: Adapter = {
  async loadAll() {
    const out = emptyData();
    const { error: kindErr } = await supabase!.from('lists').select('kind').limit(1);
    if (kindErr) missingColumns.add('lists.kind');
    const { error: coverErr } = await supabase!.from('lists').select('cover_url').limit(1);
    if (coverErr) missingColumns.add('lists.cover_url');
    const { error: orderErr } = await supabase!.from('lists').select('custom_order').limit(1);
    if (orderErr) missingColumns.add('lists.custom_order');
    await Promise.all(TABLES.filter((t) => t !== 'tracks').map(async (t) => {
      const rows: unknown[] = [];
      for (let from = 0; ; from += 1000) {
        // A fixed order matters: without it, pages can overlap or skip rows once rows have changed
        const { data, error } = await supabase!.from(t).select('*').order('id').range(from, from + 999);
        if (error) {
          // Tables added in later updates may not exist yet until their SQL is run
          if (OPTIONAL.includes(t) && /does not exist|schema cache|PGRST205|42P01/i.test(`${error.code} ${error.message}`)) { missingTables.add(t); break; }
          throw new Error(`Loading ${t}: ${error.message}`);
        }
        rows.push(...data.map(clean));
        if (data.length < 1000) break;
      }
      (out as Record<string, unknown[]>)[t] = rows;
    }));
    // Only tracks something points at (ratings, credits, lists) load up front; the rest load per album
    const ref = new Set<string>();
    for (const c of out.credits) if (c.track_id) ref.add(c.track_id);
    for (const a of out.annotations) if (a.entity_type === 'track') ref.add(a.entity_id);
    for (const i of out.list_items) if (i.entity_type === 'track' && i.entity_id) ref.add(i.entity_id);
    out.tracks = await this.tracksByIds([...ref]);
    return out;
  },
  async tracksForReleases(releaseIds) {
    return inChunks(releaseIds, 100, (c) => pageAll<Track>((f, t) => cloudTracks((b) => b.select('*')).in('release_id', c).order('id').range(f, t)));
  },
  async tracksByIds(ids) {
    return inChunks(ids, 150, (c) => pageAll<Track>((f, t) => cloudTracks((b) => b.select('*')).in('id', c).order('id').range(f, t)));
  },
  async searchTracks(q, limit = 12) {
    const term = q.replace(/[%_,()]/g, ' ').trim();
    if (term.length < 2) return [];
    const { data, error } = await supabase!.from('tracks').select('*').ilike('title', `%${term}%`).limit(limit);
    if (error) throw new Error(error.message);
    return (data ?? []).map((r) => clean(r as Track & { owner?: string }));
  },
  async allTracks() {
    return pageAll<Track>((f, t) => cloudTracks((b) => b.select('*')).order('id').range(f, t));
  },
  async tracksFeaturing(name) {
    const n = name.replace(/[%_,()*"\\]/g, ' ').trim();
    if (n.length < 2) return [];
    const or = [`title.ilike."*feat*${n}*"`, `title.ilike."*ft*${n}*"`, `title.ilike."*with*${n}*"`, `artist_credit.ilike."*${n}*"`].join(',');
    return pageAll<Track>((f, t) => cloudTracks((b) => b.select('*')).or(or).order('id').range(f, t));
  },
  async reviewCheck(ids = []) {
    const { count, error } = await supabase!.from('annotations').select('id', { count: 'exact', head: true }).not('review', 'is', null).neq('review', '');
    if (error) throw new Error(error.message);
    let found = 0;
    for (let i = 0; i < ids.length; i += 150) {
      const { data, error: e2 } = await supabase!.from('annotations').select('id, review').in('id', ids.slice(i, i + 150));
      if (e2) throw new Error(e2.message);
      found += (data ?? []).filter((r) => (r as { review?: string }).review).length;
    }
    return { total: count ?? 0, found };
  },
  async clear(table) {
    const { error } = await supabase!.from(table).delete().neq('id', '');
    if (error) throw new Error(`Clearing ${table}: ${error.message}`);
  },
  async upsert(table, rows) {
    if (table === 'lists' && missingColumns.has('lists.kind')) rows = rows.map((r) => { const { kind: _k, ...rest } = r as Tables['lists']; void _k; return rest; }) as typeof rows;
    if (table === 'lists' && missingColumns.has('lists.custom_order')) rows = rows.map((r) => { const { custom_order: _o, ...rest } = r as Tables['lists']; void _o; return rest; }) as typeof rows;
    if (table === 'lists' && missingColumns.has('lists.cover_url')) rows = rows.map((r) => { const { cover_url: _c, ...rest } = r as Tables['lists']; void _c; return rest; }) as typeof rows;
    if (missingTables.has(table)) throw new Error('Labels aren’t set up in Supabase yet — run supabase/002-labels.sql');
    // The database rejects a whole batch if it touches the same row twice — keep only the last version of each
    rows = [...new Map((rows as { id: string }[]).map((r) => [r.id, r])).values()] as typeof rows;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const { error } = await supabase!.from(table).upsert(rows.slice(i, i + CHUNK) as never[], { onConflict: 'owner,id' });
      if (error) throw new Error(`Saving ${table}: ${error.message}`);
    }
  },
  async remove(table, ids) {
    for (let i = 0; i < ids.length; i += CHUNK) {
      const { error } = await supabase!.from(table).delete().in('id', ids.slice(i, i + CHUNK));
      if (error) throw new Error(`Deleting from ${table}: ${error.message}`);
    }
  },
};

/** Browser-only storage (IndexedDB). Used when Supabase isn't configured. */
const LOCAL_KEY = 'music-hub-data-v1';
let localCache: DataSet | null = null;
async function persistLocal() { if (localCache) await set(LOCAL_KEY, localCache); }

const localAdapter: Adapter = {
  async loadAll() {
    localCache = (await get(LOCAL_KEY)) ?? emptyData();
    for (const t of TABLES) if (!localCache![t]) (localCache as Record<string, unknown[]>)[t] = [];
    return structuredClone(localCache!);
  },
  async upsert(table, rows) {
    const list = localCache![table] as { id: string }[];
    const idx = new Map(list.map((r, i) => [r.id, i]));
    for (const r of rows as { id: string }[]) {
      const i = idx.get(r.id);
      if (i === undefined) { idx.set(r.id, list.length); list.push(r); } else list[i] = r;
    }
    await persistLocal();
  },
  async remove(table, ids) {
    const drop = new Set(ids);
    (localCache as Record<string, { id: string }[]>)[table] = (localCache![table] as { id: string }[]).filter((r) => !drop.has(r.id));
    await persistLocal();
  },
  async clear(table) { (localCache as Record<string, unknown[]>)[table] = []; await persistLocal(); },
  async tracksForReleases(ids) { const s = new Set(ids); return localCache!.tracks.filter((t) => t.release_id && s.has(t.release_id)); },
  async tracksByIds(ids) { const s = new Set(ids); return localCache!.tracks.filter((t) => s.has(t.id)); },
  async searchTracks(q, limit = 12) { const n = q.toLowerCase(); return localCache!.tracks.filter((t) => t.title.toLowerCase().includes(n)).slice(0, limit); },
  async allTracks() { return [...localCache!.tracks]; },
  async reviewCheck(ids = []) { const has = new Set(localCache!.annotations.filter((a) => a.review).map((a) => a.id)); return { total: has.size, found: ids.filter((i) => has.has(i)).length }; },
  async tracksFeaturing(name) {
    const n = name.toLowerCase();
    return localCache!.tracks.filter((t) => { const s = t.title.toLowerCase(); const i = s.search(/\b(feat|ft|with)\b/); return (i >= 0 && s.indexOf(n, i) > i) || (t.artist_credit ?? '').toLowerCase().includes(n); });
  },
};

export const adapter: Adapter = supabase ? cloudAdapter : localAdapter;

export { uid, now } from './util';
