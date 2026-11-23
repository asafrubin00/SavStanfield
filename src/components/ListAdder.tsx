import { useEffect, useMemo, useRef, useState } from 'react';
import { Cover } from './ui';
import { adapter } from '../lib/db';
import { norm, useStore } from '../lib/store';
import type { List, ListItem, Release, Track } from '../lib/types';
import { now, uid } from '../lib/util';

/*
 * The "add from your library" box on a list, artist list or playlist, built for adding lots at once:
 * - it stays open after adding, with what's already on the list marked "On list" (click one to take it off)
 * - tick several (shift-click for a range), then "Add N", or "Add all"
 * - click an artist to see their releases by type, with "Tick all"
 * - anything already on the list is skipped; Undo takes the lot back out
 */
type Kind = 'release' | 'track' | 'artist';
interface Row { kind: Kind; id: string; title: string; sub: string; img?: string | null }
const rowKey = (r: { kind: string; id: string }) => `${r.kind}:${r.id}`;
const TYPE_ORDER = ['Album', 'Collaboration', 'Mixtape', 'EP', 'Deluxe', 'Compilation', 'Soundtrack', 'Live', 'Single', 'Leak', 'Leak Compilation', 'Guest Appearance'];

export default function ListAdder({ list, items }: { list: List; items: ListItem[] }) {
  const st = useStore(); const { data, ix } = st;
  const live = useRef(st); live.current = st;
  const mode: 'list' | 'artists' | 'playlist' = list.kind === 'artists' ? 'artists' : list.kind === 'playlist' ? 'playlist' : 'list';
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [drill, setDrill] = useState<string | null>(null); // an artist whose releases are shown
  const [ticked, setTicked] = useState<Map<string, Row>>(new Map());
  const [songs, setSongs] = useState<Track[]>([]);
  const [busy, setBusy] = useState(false);
  const last = useRef<string | null>(null);
  const box = useRef<HTMLDivElement>(null);

  // Songs come from the server (only some are loaded in the browser)
  useEffect(() => {
    if (mode === 'artists' || q.trim().length < 2) { setSongs([]); return; }
    const t = window.setTimeout(() => { void st.searchTracks(q.trim(), 20).then(setSongs).catch(() => setSongs([])); }, 250);
    return () => window.clearTimeout(t);
  }, [q, mode]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { if (drill) setDrill(null); else setOpen(false); } };
    document.addEventListener('mousedown', close); document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); };
  }, [open, drill]);

  const onList = useMemo(() => new Map(items.filter((i) => i.entity_id).map((i) => [`${i.entity_type}:${i.entity_id}`, i])), [items]);
  const relRow = (r: Release): Row => ({ kind: 'release', id: r.id, title: r.title, sub: `${r.artist_credit ?? ''} · ${r.type}${r.year ? ` · ${r.year}` : ''}`, img: r.artwork_url });

  // What the dropdown shows, in groups
  const groups = useMemo((): { label: string; rows: Row[]; tickAll?: boolean }[] => {
    if (drill) {
      const a = ix.artists.get(drill); if (!a) return [];
      const rels = [...new Set((ix.creditsByArtist.get(drill) ?? []).filter((c) => c.role === 'primary' && c.release_id).map((c) => c.release_id!))]
        .map((id) => ix.releases.get(id)).filter(Boolean) as Release[];
      const byType = new Map<string, Release[]>();
      for (const r of rels) (byType.get(r.type) ?? byType.set(r.type, []).get(r.type)!).push(r);
      const types = [...byType.keys()].sort((x, y) => ((TYPE_ORDER.indexOf(x) + 1) || 99) - ((TYPE_ORDER.indexOf(y) + 1) || 99) || x.localeCompare(y));
      return types.map((t) => ({ label: t, tickAll: true, rows: byType.get(t)!.sort((x, y) => (y.date ?? `${y.year ?? ''}`).localeCompare(x.date ?? `${x.year ?? ''}`)).map(relRow) }));
    }
    const n = norm(q); if (n.length < 2) return [];
    const artists = data.artists.filter((a) => norm(a.name).includes(n) || a.aliases.some((x) => norm(x).includes(n)))
      .sort((a, b) => Number(norm(b.name).startsWith(n)) - Number(norm(a.name).startsWith(n)) || a.name.length - b.name.length)
      .slice(0, mode === 'artists' ? 30 : 6)
      .map((a): Row => ({ kind: 'artist', id: a.id, title: a.name, sub: ix.lastByArtist.get(a.id) ? `Latest release ${ix.lastByArtist.get(a.id)!.slice(0, 4)}` : 'Artist', img: a.image_url }));
    if (mode === 'artists') return [{ label: 'Artists', rows: artists }];
    const releases = data.releases.filter((r) => norm(`${r.artist_credit} ${r.title}`).includes(n))
      .sort((a, b) => Number(norm(b.title).startsWith(n)) - Number(norm(a.title).startsWith(n)) || (b.year ?? 0) - (a.year ?? 0)).slice(0, 30).map(relRow);
    const songRows = songs.map((t): Row => { const r = t.release_id ? ix.releases.get(t.release_id) : undefined; return { kind: 'track', id: t.id, title: t.title, sub: `Song · ${t.artist_credit ?? r?.artist_credit ?? ''}${r ? ` · ${r.title}` : ''}`, img: r?.artwork_url }; });
    return [
      ...(artists.length ? [{ label: 'Artists — click to see their releases', rows: artists }] : []),
      ...(songRows.length ? [{ label: 'Songs', rows: songRows }] : []),
      ...(releases.length ? [{ label: mode === 'playlist' ? 'Albums — adds their songs' : 'Releases', rows: releases }] : []),
    ];
  }, [drill, q, data.artists, data.releases, songs, ix, mode]);

  const pickable = (r: Row) => !(r.kind === 'artist' && mode !== 'artists'); // in an album list, an artist row opens their releases
  const flat = groups.flatMap((g) => g.rows).filter(pickable);
  const addable = flat.filter((r) => !onList.has(rowKey(r)));

  function tick(r: Row, range: boolean) {
    const next = new Map(ticked); const k = rowKey(r); const on = !ticked.has(k);
    const i = flat.findIndex((x) => rowKey(x) === k); const j = last.current ? flat.findIndex((x) => rowKey(x) === last.current) : -1;
    const span = range && i >= 0 && j >= 0 ? flat.slice(Math.min(i, j), Math.max(i, j) + 1) : [r];
    for (const x of span) { if (onList.has(rowKey(x))) continue; if (on) next.set(rowKey(x), x); else next.delete(rowKey(x)); }
    last.current = k; setTicked(next);
  }

  async function add(rows: Row[]) {
    if (!rows.length) return;
    setBusy(true);
    try {
      let entries: { type: ListItem['entity_type']; id: string }[] = rows.map((r) => ({ type: r.kind, id: r.id }));
      if (mode === 'playlist') {
        // A playlist holds songs: an album brings its tracklist, in order
        const relIds = rows.filter((r) => r.kind === 'release').map((r) => r.id);
        const tr = relIds.length ? await adapter.tracksForReleases(relIds) : [];
        const byRel = new Map<string, Track[]>(); for (const t of tr) if (t.release_id) (byRel.get(t.release_id) ?? byRel.set(t.release_id, []).get(t.release_id)!).push(t);
        const noTracks = relIds.filter((id) => !byRel.has(id)).length;
        if (noTracks) st.say(`${noTracks} album${noTracks === 1 ? ' has' : 's have'} no tracklist yet — open it and use “Get tracklist”`);
        entries = rows.flatMap((r) => (r.kind === 'release' ? (byRel.get(r.id) ?? []).sort((a, b) => (a.disc ?? 1) - (b.disc ?? 1) || (a.number ?? 0) - (b.number ?? 0)).map((t) => ({ type: 'track' as const, id: t.id })) : [{ type: r.kind, id: r.id }]));
      }
      const seen = new Set(onList.keys());
      let pos = Math.max(0, ...items.map((x) => x.position));
      const add = entries.filter((e) => { const k = `${e.type}:${e.id}`; if (seen.has(k)) return false; seen.add(k); return true; })
        .map((e) => ({ id: uid(), list_id: list.id, entity_type: e.type, entity_id: e.id, label: null, position: ++pos }));
      const skipped = entries.length - add.length;
      if (!add.length) { st.say(skipped ? 'Already on the list' : 'Nothing to add'); return; }
      await st.upsert('list_items', add as ListItem[]);
      await st.upsert('lists', [{ ...list, updated_at: now() }]);
      setTicked(new Map());
      st.say(`Added ${add.length}${skipped ? ` (${skipped} already there)` : ''}`, { label: 'Undo', run: () => void live.current.remove('list_items', add.map((a) => a.id)) });
    } finally { setBusy(false); }
  }
  async function takeOff(r: Row) {
    const it = onList.get(rowKey(r)); if (!it) return;
    await st.remove('list_items', [it.id]);
    st.say(`Took ${r.title} off the list`, { label: 'Undo', run: () => void live.current.upsert('list_items', [it]) });
  }
  async function addText() {
    const label = q.trim(); if (!label) return;
    await st.upsert('list_items', [{ id: uid(), list_id: list.id, entity_type: 'text', entity_id: null, label, position: Math.max(0, ...items.map((x) => x.position)) + 1 } as ListItem]);
    setQ('');
  }

  const showing = open && (drill || q.trim().length >= 2);
  const drillArtist = drill ? ix.artists.get(drill) : undefined;
  const placeholder = mode === 'artists' ? 'Add artists — search your library' : mode === 'playlist' ? 'Add songs — search songs, albums or an artist' : 'Add from your library — search artists, releases, songs';
  return (
    <div ref={box} className="search list-adder" style={{ maxWidth: 680, marginBottom: 20 }}>
      <input className="input" placeholder={placeholder} value={q} aria-label={placeholder}
        onChange={(e) => { setQ(e.target.value); setDrill(null); setOpen(true); }} onFocus={() => setOpen(true)}
        onKeyDown={(e) => { if (e.key === 'Enter' && mode === 'list' && !flat.length && q.trim()) void addText(); }} />
      {showing && <div className="dropdown adder-dd">
        {drillArtist && <div className="adder-drill"><button type="button" className="btn sm ghost" onClick={() => setDrill(null)}>← Results</button><strong>{drillArtist.name}</strong><span className="muted small">{flat.length} releases</span></div>}
        <div className="adder-rows">
          {groups.map((g) => {
            const free = g.rows.filter((r) => pickable(r) && !onList.has(rowKey(r)));
            const allOn = free.length > 0 && free.every((r) => ticked.has(rowKey(r)));
            return (
              <div key={g.label}>
                <div className="dd-group adder-group"><span>{g.label}</span>
                  {g.tickAll && free.length > 0 && <button type="button" className="btn sm ghost" onClick={() => { const next = new Map(ticked); for (const r of free) { if (allOn) next.delete(rowKey(r)); else next.set(rowKey(r), r); } setTicked(next); }}>{allOn ? 'Untick all' : `Tick all ${free.length}`}</button>}
                </div>
                {g.rows.map((r) => {
                  const k = rowKey(r); const there = onList.has(k); const on = ticked.has(k);
                  if (!pickable(r)) return (
                    <button key={k} type="button" className="dd-item btn ghost adder-row" onClick={() => setDrill(r.id)}>
                      <span className="adder-check" /><Cover src={r.img} title={r.title} size={30} round />
                      <span className="adder-text"><strong>{r.title}</strong><span className="small muted">{r.sub}</span></span><span className="muted">›</span>
                    </button>);
                  return (
                    <button key={k} type="button" className={`dd-item btn ghost adder-row${on ? ' on' : ''}${there ? ' there' : ''}`} aria-pressed={on}
                      title={there ? 'Already on the list — click to take it off' : undefined}
                      onClick={(e) => (there ? void takeOff(r) : tick(r, e.shiftKey))}>
                      <span className="adder-check"><input type="checkbox" tabIndex={-1} readOnly checked={on || there} disabled={there} /></span>
                      <Cover src={r.img} title={r.title} size={30} round={r.kind === 'artist'} />
                      <span className="adder-text"><strong>{r.title}</strong><span className="small muted">{r.sub}</span></span>
                      {there && <span className="adder-on">✓ On list</span>}
                    </button>);
                })}
              </div>);
          })}
          {!groups.length && <div className="small muted" style={{ padding: 10 }}>{mode === 'playlist' ? 'Nothing found. Songs appear once their album has a tracklist.' : 'Nothing found.'}</div>}
        </div>
        <div className="adder-foot">
          <button type="button" className="btn sm primary" disabled={!ticked.size || busy} onClick={() => void add([...ticked.values()])}>{busy ? 'Adding…' : `Add ${ticked.size || ''}`.trim()}</button>
          <button type="button" className="btn sm" disabled={!addable.length || busy} onClick={() => void add(addable)}>Add all {addable.length || ''}</button>
          {ticked.size > 0 && <button type="button" className="btn sm ghost" onClick={() => setTicked(new Map())}>Clear ticks</button>}
          <span className="spacer" />
          {mode === 'list' && q.trim() && !drill && <button type="button" className="btn sm ghost" onClick={() => void addText()}>Add “{q.trim()}” as text</button>}
          <button type="button" className="btn sm ghost" onClick={() => setOpen(false)}>Close</button>
        </div>
      </div>}
    </div>
  );
}

/** Duplicates on a list (the same album or song twice). Keeps the first copy, taking a later copy's note if the first has none. */
export function useDuplicates(items: ListItem[]) {
  const st = useStore();
  const live = useRef(st); live.current = st;
  const seen = new Map<string, ListItem>(); const dups: ListItem[] = [];
  for (const it of items) {
    if (!it.entity_id) continue;
    const k = `${it.entity_type}:${it.entity_id}`;
    if (seen.has(k)) dups.push(it); else seen.set(k, it);
  }
  const run = async () => {
    if (!dups.length) return;
    const keepers: ListItem[] = [];
    for (const d of dups) {
      const keep = seen.get(`${d.entity_type}:${d.entity_id}`)!;
      if (!keep.note && d.note && !keepers.some((k) => k.id === keep.id)) keepers.push({ ...keep, note: d.note });
    }
    const before = keepers.map((k) => seen.get(`${k.entity_type}:${k.entity_id}`)!);
    if (keepers.length) await st.upsert('list_items', keepers);
    await st.remove('list_items', dups.map((d) => d.id));
    st.say(`Removed ${dups.length} duplicate${dups.length === 1 ? '' : 's'}`, { label: 'Undo', run: () => void (async () => { await live.current.upsert('list_items', dups); if (before.length) await live.current.upsert('list_items', before); })() });
  };
  return { count: dups.length, run };
}
