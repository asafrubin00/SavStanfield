import { useRef, useState } from 'react';
import TypeSelect from './TypeSelect';
import { parseWhen, useEdits } from '../lib/edits';
import { linkQueue } from '../lib/queue';
import { releaseLabels, useStore } from '../lib/store';
import type { Release } from '../lib/types';
import { now } from '../lib/util';

type Action = '' | 'type' | 'artist' | 'when' | 'label' | 'list' | 'fav' | 'unfav' | 'links' | 'tracks' | 'delete';
const ACTIONS: [Action, string][] = [
  ['type', 'Set type'], ['artist', 'Set artist'], ['when', 'Set year or date'], ['label', 'Add a label'], ['list', 'Add to a list'],
  ['fav', 'Favourite'], ['unfav', 'Unfavourite'], ['links', 'Find links & artwork'], ['tracks', 'Get tracklists'], ['delete', 'Delete'],
];

/**
 * The bar along the bottom while releases are selected: pick an action, give it a value, Apply.
 * Every change can be undone from the message that follows (except Delete, which asks first).
 */
export default function BulkBar({ ids, total, onSelectAll, onClear }: { ids: string[]; total: number; onSelectAll: () => void; onClear: () => void }) {
  const st = useStore(); const E = useEdits();
  const live = useRef(st); live.current = st; // undo runs later, against the data as it is then
  const [action, setAction] = useState<Action>('');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const rels = () => ids.map((id) => st.ix.releases.get(id)).filter(Boolean) as Release[];
  const n = ids.length; const what = `${n} release${n === 1 ? '' : 's'}`;
  const lists = st.data.lists.filter((l) => l.kind === 'list' || l.kind === 'playlist').sort((a, b) => a.name.localeCompare(b.name));
  const needsValue = ['type', 'artist', 'when', 'label', 'list'].includes(action);

  async function apply() {
    const rs = rels(); if (!rs.length || !action) return;
    const v = value.trim();
    if (needsValue && !v && action !== 'when') return;
    setBusy(true);
    try {
      switch (action) {
        case 'type': case 'when': {
          if (action === 'when' && !parseWhen(v)) { st.say(`Couldn't read “${v}” as a date — try 2017-11-27, 27 Nov 2017 or 2017`); return; }
          const before = rs.map((r) => ({ ...r }));
          const patch = action === 'type' ? { type: v } : parseWhen(v)!;
          await st.upsert('releases', rs.map((r) => ({ ...r, ...patch, updated_at: now() })));
          st.say(`${action === 'type' ? `Type set to ${v}` : `Date set to ${v || 'none'}`} on ${what}`, { label: 'Undo', run: () => void live.current.upsert('releases', before.map((r) => ({ ...r, updated_at: now() }))) });
          break;
        }
        case 'artist': {
          const before = rs.map((r) => [r.id, r.artist_credit ?? ''] as const);
          for (const r of rs) await E.setReleaseArtist(r, v);
          st.say(`Artist set to ${v} on ${what}`, { label: 'Undo', run: () => void (async () => { for (const [id, old] of before) { const r = live.current.ix.releases.get(id); if (r && old) await E.setReleaseArtist(r, old); } })() });
          break;
        }
        case 'label': {
          const before = rs.map((r) => [r.id, releaseLabels(st.ix, r.id).map((l) => l.name)] as const);
          for (const [id, names] of before) if (!names.some((x) => x.toLowerCase() === v.toLowerCase())) await st.setReleaseLabels(id, [...names, v]);
          st.say(`Added label ${v} to ${what}`, { label: 'Undo', run: () => void (async () => { for (const [id, names] of before) await live.current.setReleaseLabels(id, names); })() });
          break;
        }
        case 'list': {
          const list = st.ix.lists.get(v); if (!list) return;
          const had = new Set(st.data.list_items.filter((i) => i.list_id === v).map((i) => i.entity_id));
          const add = rs.filter((r) => !had.has(r.id));
          for (const r of add) await st.addToList(v, 'release', r.id);
          const added = new Set(add.map((r) => r.id));
          st.say(add.length ? `Added ${add.length} to ${list.name}` : `All already on ${list.name}`, add.length ? { label: 'Undo', run: () => void live.current.remove('list_items', live.current.data.list_items.filter((i) => i.list_id === v && i.entity_id && added.has(i.entity_id)).map((i) => i.id)) } : undefined);
          break;
        }
        case 'fav': case 'unfav': {
          const on = action === 'fav';
          const before = rs.map((r) => [r.id, !!st.annotation('release', r.id)?.favorite] as const).filter(([, f]) => f !== on);
          for (const [id] of before) await st.annotate('release', id, { favorite: on });
          st.say(`${on ? 'Favourited' : 'Unfavourited'} ${before.length} release${before.length === 1 ? '' : 's'}`, before.length ? { label: 'Undo', run: () => void (async () => { for (const [id, f] of before) await live.current.annotate('release', id, { favorite: f }); })() } : undefined);
          break;
        }
        case 'links': linkQueue.add('release', rs.map((r) => r.id)); st.say(`Finding links & artwork for ${what} in the background`); break;
        case 'tracks': linkQueue.add('tracks', rs.map((r) => r.id)); st.say(`Getting tracklists for ${what} in the background`); break;
        case 'delete': {
          if (!confirm(`Delete ${what} from your library? Their songs, ratings, reviews and list entries go too. This can't be undone.`)) return;
          for (const r of rs) await st.deleteRelease(r.id);
          onClear(); st.say(`Deleted ${what}`);
          break;
        }
      }
      setValue('');
    } catch (e) { st.say((e as Error).message); } finally { setBusy(false); }
  }

  return (
    <div className="bulk-bar" role="toolbar" aria-label="Bulk edit">
      <strong className="num">{n}</strong><span className="muted">selected</span>
      {n < total && <button type="button" className="btn sm ghost" onClick={onSelectAll}>Select all {total.toLocaleString()}</button>}
      <button type="button" className="btn sm ghost" onClick={onClear} disabled={!n}>Clear</button>
      <span className="bulk-sep" />
      <select className="select" aria-label="Action" value={action} onChange={(e) => { setAction(e.target.value as Action); setValue(''); }}>
        <option value="">Choose what to do…</option>{ACTIONS.map(([k, t]) => <option key={k} value={k}>{t}</option>)}
      </select>
      {action === 'type' && <TypeSelect value={value || ''} onChange={setValue} />}
      {(action === 'artist' || action === 'label') && <input className="input" autoFocus placeholder={action === 'artist' ? 'Artist, e.g. Rich Gang, Young Thug & Rich Homie Quan' : 'Label name'} value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void apply(); }} style={{ minWidth: 260 }} />}
      {action === 'when' && <input className="input" autoFocus placeholder="2017, 2017-11-27 or 27 Nov 2017" value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void apply(); }} />}
      {action === 'list' && <select className="select" value={value} onChange={(e) => setValue(e.target.value)} aria-label="List"><option value="">Pick a list…</option>{lists.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select>}
      {action && <button type="button" className={`btn sm ${action === 'delete' ? 'danger' : 'primary'}`} disabled={!n || busy || (needsValue && !value.trim() && action !== 'when')} onClick={() => void apply()}>{busy ? 'Working…' : action === 'delete' ? `Delete ${n}` : 'Apply'}</button>}
    </div>
  );
}
