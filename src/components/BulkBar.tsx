import { useEffect, useRef, useState } from 'react';
import TypeSelect from './TypeSelect';
import PeopleInput from './PeopleInput';
import { useSelection, type Item } from './Select';
import { parseWhen, useEdits } from '../lib/edits';
import { linkQueue } from '../lib/queue';
import { adapter } from '../lib/db';
import { norm, releaseLabels, trackArtists, useStore } from '../lib/store';
import type { List, Release, Track } from '../lib/types';
import { now, uid } from '../lib/util';

type Action = '' | 'type' | 'artist' | 'when' | 'label' | 'fav' | 'unfav' | 'links' | 'tracks' | 'delete'
  | 'feat-add' | 'feat-remove' | 'prod-add' | 'prod-remove' | 'track-artist';
const RELEASE_ACTIONS: [Action, string][] = [
  ['type', 'Set type'], ['artist', 'Set artist'], ['when', 'Set year or date'], ['label', 'Add a label'],
  ['links', 'Find links & artwork'], ['tracks', 'Get tracklists'], ['delete', 'Delete'],
];
const TRACK_ACTIONS: [Action, string][] = [
  ['feat-add', 'Add a feature'], ['feat-remove', 'Remove a feature'], ['prod-add', 'Add a producer'], ['prod-remove', 'Remove a producer'], ['track-artist', 'Set artist'],
];
const SHARED: [Action, string][] = [['fav', 'Favourite'], ['unfav', 'Unfavourite']];
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

/**
 * The bar along the bottom while things are selected. "Add to list" is always first; the other actions depend on
 * what's selected (albums, songs, or both). Every change can be undone from the message that follows, except Delete.
 */
export default function BulkBar() {
  const s = useSelection();
  const st = useStore(); const E = useEdits();
  const live = useRef(st); live.current = st; // undo runs later, against the data as it is then
  const [action, setAction] = useState<Action>('');
  const [value, setValue] = useState('');
  const [names, setNames] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  if (!s?.selecting) return null;

  const items = s.items;
  const relIds = items.filter((x) => x.type === 'release').map((x) => x.id);
  const trackIds = items.filter((x) => x.type === 'track').map((x) => x.id);
  const n = items.length;
  const what = relIds.length && trackIds.length ? `${plural(relIds.length, 'release')} and ${plural(trackIds.length, 'song')}` : relIds.length ? plural(relIds.length, 'release') : plural(trackIds.length, 'song');
  const actions = [...(relIds.length && !trackIds.length ? RELEASE_ACTIONS : []), ...(trackIds.length && !relIds.length ? TRACK_ACTIONS : []), ...SHARED];
  const needsValue = ['type', 'artist', 'when', 'label'].includes(action);
  const needsNames = ['feat-add', 'feat-remove', 'prod-add', 'prod-remove', 'track-artist'].includes(action);
  const rels = () => relIds.map((id) => st.ix.releases.get(id)).filter(Boolean) as Release[];
  const tracks = () => trackIds.map((id) => st.ix.tracks.get(id)).filter(Boolean) as Track[];
  const reset = () => { setValue(''); setNames([]); };

  async function apply() {
    if (!action || !n) return;
    const v = value.trim();
    if (needsValue && !v && action !== 'when') return;
    if (needsNames && !names.length) return;
    setBusy(true);
    try {
      switch (action) {
        case 'type': case 'when': {
          if (action === 'when' && !parseWhen(v)) { st.say(`Couldn't read “${v}” as a date — try 2017-11-27, 27 Nov 2017 or 2017`); return; }
          const rs = rels(); const before = rs.map((r) => ({ ...r }));
          const patch = action === 'type' ? { type: v } : parseWhen(v)!;
          await st.upsert('releases', rs.map((r) => ({ ...r, ...patch, updated_at: now() })));
          st.say(`${action === 'type' ? `Type set to ${v}` : `Date set to ${v || 'none'}`} on ${what}`, { label: 'Undo', run: () => void live.current.upsert('releases', before.map((r) => ({ ...r, updated_at: now() }))) });
          break;
        }
        case 'artist': {
          const rs = rels(); const before = rs.map((r) => [r.id, r.artist_credit ?? ''] as const);
          for (const r of rs) await E.setReleaseArtist(r, v);
          st.say(`Artist set to ${v} on ${what}`, { label: 'Undo', run: () => void (async () => { for (const [id, old] of before) { const r = live.current.ix.releases.get(id); if (r && old) await E.setReleaseArtist(r, old); } })() });
          break;
        }
        case 'label': {
          const before = rels().map((r) => [r.id, releaseLabels(st.ix, r.id).map((l) => l.name)] as const);
          for (const [id, ls] of before) if (!ls.some((x) => norm(x) === norm(v))) await st.setReleaseLabels(id, [...ls, v]);
          st.say(`Added label ${v} to ${what}`, { label: 'Undo', run: () => void (async () => { for (const [id, ls] of before) await live.current.setReleaseLabels(id, ls); })() });
          break;
        }
        case 'feat-add': case 'feat-remove': case 'prod-add': case 'prod-remove': {
          const role = action.startsWith('feat') ? 'featured' : 'producer';
          const adding = action.endsWith('add');
          const before = tracks().map((t) => [t.id, trackArtists(st.ix, t.id, role).map((a) => a.name)] as const);
          const want = new Set(names.map(norm));
          let changed = 0;
          for (const [id, cur] of before) {
            const next = adding ? [...cur, ...names.filter((x) => !cur.some((c) => norm(c) === norm(x)))] : cur.filter((c) => !want.has(norm(c)));
            if (next.length !== cur.length) { await st.setTrackCredits(id, role, next); changed++; }
          }
          const who = names.join(', ');
          st.say(changed ? `${adding ? 'Added' : 'Removed'} ${who} ${adding ? 'to' : 'from'} ${plural(changed, 'song')} as ${role === 'featured' ? 'a feature' : 'producer'}` : `No change — ${adding ? 'already credited' : 'not credited'} on ${n === 1 ? 'that song' : 'those songs'}`,
            changed ? { label: 'Undo', run: () => void (async () => { for (const [id, cur] of before) await live.current.setTrackCredits(id, role, cur); })() } : undefined);
          break;
        }
        case 'track-artist': {
          const ts = tracks();
          const before = ts.map((t) => [t, trackArtists(st.ix, t.id, 'primary').map((a) => a.name), t.artist_credit] as const);
          for (const t of ts) await E.setTrackArtists(t, names);
          st.say(`Artist set to ${names.join(' & ')} on ${plural(ts.length, 'song')}`, { label: 'Undo', run: () => void (async () => {
            for (const [t, old, credit] of before) { await live.current.setTrackCredits(t.id, 'primary', old); await live.current.upsert('tracks', [{ ...(live.current.ix.tracks.get(t.id) ?? t), artist_credit: credit, updated_at: now() }]); }
          })() });
          break;
        }
        case 'fav': case 'unfav': {
          const on = action === 'fav';
          const before = items.map((x) => [x, !!st.annotation(x.type, x.id)?.favorite] as const).filter(([, f]) => f !== on);
          for (const [x] of before) await st.annotate(x.type, x.id, { favorite: on });
          st.say(`${on ? 'Favourited' : 'Unfavourited'} ${before.length}`, before.length ? { label: 'Undo', run: () => void (async () => { for (const [x, f] of before) await live.current.annotate(x.type, x.id, { favorite: f }); })() } : undefined);
          break;
        }
        case 'links': linkQueue.add('release', relIds); st.say(`Finding links & artwork for ${what} in the background`); break;
        case 'tracks': linkQueue.add('tracks', relIds); st.say(`Getting tracklists for ${what} in the background`); break;
        case 'delete': {
          if (!confirm(`Delete ${what} from your library? Their songs, ratings, reviews and list entries go too. This can't be undone.`)) return;
          for (const id of relIds) await st.deleteRelease(id);
          s!.clear(); st.say(`Deleted ${what}`);
          break;
        }
      }
      reset();
    } catch (e) { st.say((e as Error).message); } finally { setBusy(false); }
  }

  return (<>
    <div style={{ height: 120 }} aria-hidden />
    <div className="bulk-bar" role="toolbar" aria-label="Selected items">
      <strong className="num">{n.toLocaleString()}</strong><span className="muted">selected</span>
      {n < s.all.length && <button type="button" className="btn sm ghost" onClick={() => s.set(s.all)}>Select all {s.all.length.toLocaleString()}</button>}
      <button type="button" className="btn sm ghost" onClick={s.clear} disabled={!n}>Clear</button>
      <span className="bulk-sep" />
      <div style={{ position: 'relative' }}>
        <button type="button" className="btn sm primary" disabled={!n} aria-haspopup="dialog" aria-expanded={picking} onClick={() => setPicking(!picking)}>Add to list…</button>
        {picking && <ListPicker items={items} onDone={() => setPicking(false)} />}
      </div>
      {s.removeFromHere && <button type="button" className="btn sm" disabled={!n} onClick={async () => { await s.removeFromHere!.run(items); s.clear(); }}>{s.removeFromHere.label}</button>}
      <select className="select" aria-label="More actions" value={action} onChange={(e) => { setAction(e.target.value as Action); reset(); }}>
        <option value="">More…</option>{actions.map(([k, t]) => <option key={k} value={k}>{t}</option>)}
      </select>
      {action === 'type' && <TypeSelect value={value || ''} onChange={setValue} />}
      {(action === 'artist' || action === 'label') && <input className="input" autoFocus placeholder={action === 'artist' ? 'Artist, e.g. Rich Gang, Young Thug & Rich Homie Quan' : 'Label name'} value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void apply(); }} style={{ minWidth: 260 }} />}
      {action === 'when' && <input className="input" autoFocus placeholder="2017, 2017-11-27 or 27 Nov 2017" value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void apply(); }} />}
      {needsNames && <div className="bulk-names"><PeopleInput value={names} onChange={setNames} placeholder={action === 'track-artist' ? 'Artist(s)' : action.endsWith('remove') ? 'Who to remove' : 'Who to add'} /></div>}
      {action && <button type="button" className={`btn sm ${action === 'delete' ? 'danger' : ''}`} disabled={!n || busy || (needsValue && !value.trim() && action !== 'when') || (needsNames && !names.length)} onClick={() => void apply()}>{busy ? 'Working…' : action === 'delete' ? `Delete ${n}` : 'Apply'}</button>}
      <button type="button" className="btn sm ghost" onClick={() => s.setSelecting(false)} title="Stop selecting (Esc)">Done</button>
    </div>
  </>);
}

/**
 * Pick a list or playlist (searchable, newest-used first) or make a new one. Albums go in as albums; into a playlist,
 * an album adds its songs. Anything already there is skipped. Undo takes them all back out.
 */
function ListPicker({ items, onDone }: { items: Item[]; onDone: () => void }) {
  const st = useStore();
  const live = useRef(st); live.current = st;
  const [q, setQ] = useState('');
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) onDone(); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onDone(); };
    document.addEventListener('mousedown', close); document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); };
  }, [onDone]);
  const hasTracks = items.some((x) => x.type === 'track');
  const lists = st.data.lists.filter((l) => l.kind === 'list' || l.kind === 'playlist')
    .filter((l) => !q || norm(l.name).includes(norm(q)))
    .sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? ''));

  async function addTo(list: List) {
    onDone();
    let entries: Item[] = items;
    if (list.kind === 'playlist') {
      // A playlist holds songs: an album brings its tracklist
      const relIds = items.filter((x) => x.type === 'release').map((x) => x.id);
      const loaded = relIds.length ? await adapter.tracksForReleases(relIds) : [];
      const byRel = new Map<string, Track[]>(); for (const t of loaded) if (t.release_id) (byRel.get(t.release_id) ?? byRel.set(t.release_id, []).get(t.release_id)!).push(t);
      const order = (ts: Track[]) => ts.sort((a, b) => (a.disc ?? 1) - (b.disc ?? 1) || (a.number ?? 0) - (b.number ?? 0));
      entries = items.flatMap((x) => (x.type === 'track' ? [x] : order(byRel.get(x.id) ?? []).map((t) => ({ type: 'track' as const, id: t.id }))));
    }
    const cur = st.ix.itemsByList.get(list.id) ?? [];
    const have = new Set(cur.map((i) => `${i.entity_type}:${i.entity_id}`));
    let pos = cur.reduce((m, i) => Math.max(m, i.position), 0);
    const add = entries.filter((x, i, a) => !have.has(`${x.type}:${x.id}`) && a.findIndex((y) => y.type === x.type && y.id === x.id) === i)
      .map((x) => ({ id: uid(), list_id: list.id, entity_type: x.type, entity_id: x.id, position: ++pos }));
    if (!add.length) { st.say(`All already on ${list.name}`); return; }
    await st.upsert('list_items', add);
    await st.upsert('lists', [{ ...list, updated_at: now() }]);
    const skipped = entries.length - add.length;
    st.say(`Added ${add.length} to ${list.name}${skipped ? ` (${skipped} already there)` : ''}`, { label: 'Undo', run: () => void live.current.remove('list_items', add.map((a) => a.id)) });
  }
  async function create() {
    const name = q.trim(); if (!name) return;
    const kind = hasTracks && items.every((x) => x.type === 'track') ? 'playlist' : 'list';
    const id = await st.createList(name, kind);
    await addTo({ id, name, kind, ranked: false, created_at: now(), updated_at: now() } as List);
  }
  return (
    <div ref={box} className="list-picker" role="dialog" aria-label="Add to list">
      <input className="input" autoFocus placeholder="Find a list, or name a new one" value={q} onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); if (lists.length === 1) void addTo(lists[0]); else void create(); } }} />
      <div className="list-picker-items">
        {q.trim() && !lists.some((l) => norm(l.name) === norm(q)) && <button type="button" className="dd-item btn ghost" onClick={() => void create()}>+ New {items.every((x) => x.type === 'track') ? 'playlist' : 'list'} “{q.trim()}”</button>}
        {lists.map((l) => <button key={l.id} type="button" className="dd-item btn ghost" onClick={() => void addTo(l)}>{l.name}<span className="muted small">{l.kind === 'playlist' ? 'playlist' : 'list'}</span></button>)}
        {!lists.length && !q && <div className="small muted" style={{ padding: 8 }}>No lists yet — type a name to make one.</div>}
      </div>
    </div>
  );
}
