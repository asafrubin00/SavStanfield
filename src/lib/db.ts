import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { get, set } from 'idb-keyval';
import { TABLES, type DataSet, type TableName, type Tables } from './types';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const supabase: SupabaseClient | null = url && key ? createClient(url, key) : null;
export const mode: 'cloud' | 'local' = supabase ? 'cloud' : 'local';

export function emptyData(): DataSet {
  return Object.fromEntries(TABLES.map((t) => [t, []])) as unknown as DataSet;
}

export interface Adapter {
  loadAll(): Promise<DataSet>;
  upsert<T extends TableName>(table: T, rows: Tables[T][]): Promise<void>;
  remove(table: TableName, ids: string[]): Promise<void>;
}

const CHUNK = 500;

/** Strip the owner column Supabase returns; the app never needs it. */
function clean<T>(row: T & { owner?: string }): T {
  const { owner: _o, ...rest } = row;
  void _o;
  return rest as T;
}

const cloudAdapter: Adapter = {
  async loadAll() {
    const out = emptyData();
    await Promise.all(TABLES.map(async (t) => {
      const rows: unknown[] = [];
      for (let from = 0; ; from += 1000) {
        const { data, error } = await supabase!.from(t).select('*').range(from, from + 999);
        if (error) throw new Error(`Loading ${t}: ${error.message}`);
        rows.push(...data.map(clean));
        if (data.length < 1000) break;
      }
      (out as Record<string, unknown[]>)[t] = rows;
    }));
    return out;
  },
  async upsert(table, rows) {
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
};

export const adapter: Adapter = supabase ? cloudAdapter : localAdapter;

export { uid, now } from './util';
