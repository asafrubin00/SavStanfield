import { useEffect, useMemo, useState } from 'react';
import { Link, Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { DndContext, KeyboardSensor, PointerSensor, pointerWithin, TouchSensor, useDroppable, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { arrayMove, rectSortingStrategy, SortableContext, sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import { SortSelect, usePref } from '../components/controls';
import { Cover, QuickRate } from '../components/ui';
import PlaylistView from './Playlist';
import { CoverGrid, CoverPicker, FolderSelect, folderOfMap, groupForCovers, ListCover, orderItems, Sortable, SortableItem, useDeleteList, useMoveToFolder, useRemoveFromList, useSaveOrder } from '../components/ListBits';
import { norm, useStore, type Index } from '../lib/store';
import type { List, ListItem } from '../lib/types';
import { now, uid } from '../lib/util';

function itemView(ix: Index, it: ListItem) {
  if (it.entity_type === 'release') { const r = ix.releases.get(it.entity_id!); return r && { to: `/release/${r.id}`, title: r.title, sub: `${r.artist_credit} · ${r.year ?? ''}`, img: r.artwork_url, round: false }; }
  if (it.entity_type === 'artist') { const a = ix.artists.get(it.entity_id!); return a && { to: `/artist/${a.id}`, title: a.name, sub: 'Artist', img: a.image_url, round: true }; }
  if (it.entity_type === 'label') { const l = ix.labels.get(it.entity_id!); return l && { to: `/label/${l.id}`, title: l.name, sub: 'Label', img: l.image_url, round: false }; }
  if (it.entity_type === 'track') { const t = ix.tracks.get(it.entity_id!); const r = t?.release_id ? ix.releases.get(t.release_id) : undefined; return t && { to: `/track/${t.id}`, title: t.title, sub: `${t.artist_credit ?? r?.artist_credit ?? ''}${r ? ` · ${r.title}` : ''}`, img: r?.artwork_url, round: false }; }
  return { to: '', title: it.label ?? '', sub: 'Not in your library yet', img: null, round: false };
}

type Kind = NonNullable<List['kind']>;
const KIND_SUB = (l: List, n: number) => l.kind === 'playlist' ? `Playlist · ${n} song${n === 1 ? '' : 's'}` : l.kind === 'artists' ? `Artists · ${n}` : `${n} item${n === 1 ? '' : 's'}`;

/** A folder (or "All" / "Not in a folder") in the left column; lists can be dropped on it. */
function RailItem({ id, label, count, on, onClick, droppable }: { id: string; label: string; count: number; on: boolean; onClick: () => void; droppable: boolean }) {
  const { setNodeRef, isOver } = useDroppable({ id: `folder:${id}`, disabled: !droppable });
  return (
    <button ref={setNodeRef} type="button" className={`rail-item${on ? ' on' : ''}${isOver ? ' over' : ''}`} onClick={onClick}>
      <span className="rail-name">{label}</span><span className="rail-n num">{count}</span>
    </button>
  );
}

export function Lists() {
  const { data, ix, createList, upsert, say } = useStore();
  const nav = useNavigate();
  const [sp, setSp] = useSearchParams();
  const sel = sp.get('folder') ?? 'all';
  const select = (v: string) => { const n = new URLSearchParams(sp); if (v === 'all') n.delete('folder'); else n.set('folder', v); setSp(n, { replace: true }); };
  const move = useMoveToFolder();
  const saveOrder = useSaveOrder();
  const deleteList = useDeleteList();
  // Lists that only hold artists become artist lists (e.g. XXL Freshmen from the spreadsheet)
  useEffect(() => {
    const convert = data.lists.filter((l) => (l.kind ?? 'list') === 'list' && (ix.itemsByList.get(l.id)?.length ?? 0) > 0 && ix.itemsByList.get(l.id)!.every((i) => i.entity_type === 'artist'));
    if (convert.length) void upsert('lists', convert.map((l) => ({ ...l, kind: 'artists' as const, custom_order: true })));
  }, [data.lists, ix, upsert]);
  const [name, setName] = useState('');
  const [newFolder, setNewFolder] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [show, setShow] = usePref('lists.show', 'all');
  const [sortTop, setSortTop] = usePref('lists.sort', 'updated');
  const [sortFolder, setSortFolder] = usePref('lists.sort.folder', 'order');
  const folders = useMemo(() => data.lists.filter((l) => l.kind === 'folder').sort((a, b) => a.name.localeCompare(b.name)), [data.lists]);
  const folder = folders.find((f) => f.id === sel);
  const parent = useMemo(() => folderOfMap(ix, data.lists), [ix, data.lists]);
  const all = data.lists.filter((l) => l.kind !== 'folder');
  const sort = folder ? sortFolder : sortTop === 'order' ? 'updated' : sortTop;
  const setSort = folder ? setSortFolder : setSortTop;
  const size = (id: string) => ix.itemsByList.get(id)?.length ?? 0;
  const inFolderPos = new Map((folder ? ix.itemsByList.get(folder.id) ?? [] : []).map((i) => [i.entity_id ?? '', i]));
  const lists = all.filter((l) => (sel === 'all' || (sel === 'unfiled' ? !parent.has(l.id) : parent.get(l.id) === sel)) && (show === 'all' || (l.kind ?? 'list') === show))
    .sort(sort === 'order' ? (a, b) => (inFolderPos.get(a.id)?.position ?? 0) - (inFolderPos.get(b.id)?.position ?? 0)
      : sort === 'az' ? (a, b) => a.name.localeCompare(b.name) : sort === 'created' ? (a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? '')
        : sort === 'size' ? (a, b) => size(b.id) - size(a.id) : (a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? ''));
  const canReorder = !!folder && sort === 'order' && show === 'all';
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }), useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 6 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const onDragEnd = (e: DragEndEvent) => {
    const over = e.over ? String(e.over.id) : ''; const id = String(e.active.id);
    if (over.startsWith('folder:')) { const f = over.slice(7); if (f !== 'all') void move(id, f === 'unfiled' ? null : f); return; }
    if (canReorder && folder && over && over !== id) {
      const ids = lists.map((l) => l.id); const next = arrayMove(ids, ids.indexOf(id), ids.indexOf(over));
      void saveOrder(folder, next.map((x) => inFolderPos.get(x)!.id).filter(Boolean));
    }
  };
  const create = async (kind: Kind) => {
    const id = await createList(name, kind); setName('');
    if (folder) await move(id, folder.id, true);
    nav(`/list/${id}`);
  };
  const count = (f: string) => all.filter((l) => (f === 'all' ? true : f === 'unfiled' ? !parent.has(l.id) : parent.get(l.id) === f)).length;

  return (
    <div>
      <div className="row" style={{ marginBottom: 20 }}><h1 className="h-page">Lists</h1></div>
      <form className="row" style={{ marginBottom: 24 }} onSubmit={(e) => e.preventDefault()}>
        <input className="input" style={{ width: 300 }} placeholder="Name, e.g. Best of 2026 or Late night drive" value={name} onChange={(e) => setName(e.target.value)} />
        <button className="btn primary" disabled={!name.trim()} onClick={() => void create('playlist')}>Create playlist</button>
        <button className="btn" disabled={!name.trim()} onClick={() => void create('list')}>Create list</button>
        <button className="btn" disabled={!name.trim()} onClick={() => void create('artists')}>Create artist list</button>
        <span className="small muted">{folder ? `Goes into “${folder.name}”.` : 'Playlists are songs you can play in order. Lists can hold anything — albums, artists, songs.'}</span>
      </form>
      <DndContext sensors={sensors} collisionDetection={pointerWithin} onDragEnd={onDragEnd}>
        <div className="lists-layout">
          <nav className="rail" aria-label="Folders">
            <RailItem id="all" label="All lists" count={count('all')} on={sel === 'all'} onClick={() => select('all')} droppable={false} />
            <RailItem id="unfiled" label="Not in a folder" count={count('unfiled')} on={sel === 'unfiled'} onClick={() => select('unfiled')} droppable />
            {folders.length > 0 && <div className="rail-sep">Folders</div>}
            {folders.map((f) => <RailItem key={f.id} id={f.id} label={f.name || 'Untitled'} count={count(f.id)} on={sel === f.id} onClick={() => select(f.id)} droppable />)}
            {newFolder === null ? <button type="button" className="rail-item rail-add" onClick={() => setNewFolder('')}>+ New folder</button>
              : <form onSubmit={async (e) => { e.preventDefault(); if (!newFolder.trim()) return; const id = await createList(newFolder, 'folder'); setNewFolder(null); select(id); }}>
                <input className="input" style={{ width: '100%' }} autoFocus placeholder="Folder name" value={newFolder} onChange={(e) => setNewFolder(e.target.value)} onBlur={() => !newFolder.trim() && setNewFolder(null)} onKeyDown={(e) => e.key === 'Escape' && setNewFolder(null)} />
              </form>}
            <div className="small muted" style={{ marginTop: 10 }}>Drag a list’s ⋮⋮ handle onto a folder to file it.</div>
          </nav>
          <select className="select rail-mobile" value={sel} onChange={(e) => select(e.target.value)} aria-label="Folder">
            <option value="all">All lists ({count('all')})</option><option value="unfiled">Not in a folder ({count('unfiled')})</option>
            {folders.map((f) => <option key={f.id} value={f.id}>{f.name} ({count(f.id)})</option>)}
          </select>
          <section style={{ minWidth: 0 }}>
            {folder && <div className="hero" style={{ gridTemplateColumns: 'minmax(100px, 150px) 1fr', alignItems: 'end', marginBottom: 18 }}>
              <ListCover list={folder} onClick={() => setPicking(true)} />
              <div>
                <div className="muted" style={{ marginBottom: 6 }}>Folder</div>
                <input className="h-page" style={{ border: 0, background: 'transparent', width: '100%', padding: 0 }} value={folder.name} aria-label="Folder name" onChange={(e) => upsert('lists', [{ ...folder, name: e.target.value, updated_at: now() }])} />
                <button className="btn sm danger" style={{ marginTop: 8 }} onClick={async () => { if (confirm(`Delete the folder “${folder.name}”? The lists in it stay — they just won't be in a folder.`)) { await deleteList(folder); select('all'); say('Folder deleted'); } }}>Delete folder</button>
              </div>
            </div>}
            {picking && folder && <CoverPicker list={folder} items={[]} onClose={() => setPicking(false)} />}
            <div className="row" style={{ marginBottom: 16 }}>
              <div className="seg" role="group" aria-label="Show">{[['all', 'All'], ['list', 'Lists'], ['playlist', 'Playlists'], ['artists', 'Artists']].map(([v, t]) => <button key={v} className={show === v ? 'on' : ''} onClick={() => setShow(v)}>{t}</button>)}</div>
              <SortSelect value={sort} onChange={setSort} options={[...(folder ? [['order', 'Your order'] as [string, string]] : []), ['updated', 'Recently changed'], ['created', 'Newest'], ['az', 'A–Z'], ['size', 'Biggest']]} />
              <span className="muted">{lists.length}</span>
            </div>
            {!lists.length ? <div className="empty">{folder ? 'This folder is empty. Drag lists onto it from “All lists”, or use the Folder menu on a list’s page.' : sel === 'unfiled' ? 'Everything is in a folder.' : 'No lists yet. Make one above, or use “Add to list” on any artist, release or song.'}</div> : (
              <SortableContext items={lists.map((l) => l.id)} strategy={canReorder ? rectSortingStrategy : () => null}>
                <div className="grid">{lists.map((l) => (
                  <SortableItem key={l.id} id={l.id}>{({ ref, style, handle }) => (
                    <div ref={ref} style={style} className="tile">
                      <div className="tile-cover">
                        <Link to={`/list/${l.id}`} style={{ display: 'block' }}><ListCover list={l} /></Link>
                        <span className="tile-handle">{handle}</span>
                      </div>
                      <div className="t"><Link to={`/list/${l.id}`}>{l.name}</Link></div>
                      <div className="s">{KIND_SUB(l, size(l.id))}{sel === 'all' && parent.get(l.id) ? ` · ${ix.lists.get(parent.get(l.id)!)?.name ?? ''}` : ''}</div>
                    </div>)}</SortableItem>))}
                </div>
              </SortableContext>
            )}
          </section>
        </div>
      </DndContext>
    </div>
  );
}

export default function ListPage() {
  const { id } = useParams();
  const { data, ix, upsert, remove } = useStore();
  const nav = useNavigate();
  const l = ix.lists.get(id!);
  const l0 = ix.lists.get(id!);
  const items = useMemo(() => (l0 ? orderItems(ix, l0, ix.itemsByList.get(id!) ?? []) : []), [ix, id, l0]);
  const saveOrder = useSaveOrder();
  const deleteList = useDeleteList();
  const removeItems = useRemoveFromList();
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState('');
  const [itemSort, setItemSort] = useState('order');
  const [view, setView] = usePref(`list.view.${id}`, 'compact');
  const [picking, setPicking] = useState(false);
  const isArt = l0?.kind === 'artists';
  const results = useMemo(() => {
    const n = norm(q); if (n.length < 2) return [];
    if (isArt) return data.artists.filter((a) => norm(a.name).includes(n)).sort((a, b) => Number(norm(b.name).startsWith(n)) - Number(norm(a.name).startsWith(n)) || a.name.length - b.name.length).slice(0, 10).map((a) => ({ type: 'artist' as const, id: a.id, title: a.name, sub: ix.lastByArtist.get(a.id) ? `Latest release ${ix.lastByArtist.get(a.id)!.slice(0, 4)}` : 'Artist' }));
    return [
      ...data.artists.filter((a) => norm(a.name).includes(n)).slice(0, 4).map((a) => ({ type: 'artist' as const, id: a.id, title: a.name, sub: 'Artist' })),
      ...data.releases.filter((r) => norm(`${r.artist_credit} ${r.title}`).includes(n)).slice(0, 8).map((r) => ({ type: 'release' as const, id: r.id, title: r.title, sub: `${r.artist_credit} · ${r.year ?? ''}` })),
      ...data.tracks.filter((t) => norm(t.title).includes(n)).slice(0, 4).map((t) => ({ type: 'track' as const, id: t.id, title: t.title, sub: `Song · ${t.artist_credit ?? ''}` })),
    ];
  }, [q, data, isArt, ix]);
  if (!l) return <div className="empty">List not found. <Link to="/lists">All lists</Link></div>;
  if (l.kind === 'playlist') return <PlaylistView list={l} />;
  if (l.kind === 'folder') return <Navigate to={`/lists?folder=${l.id}`} replace />;

  const touch = () => upsert('lists', [{ ...l, updated_at: now() }]);
  const add = async (type: ListItem['entity_type'], eid: string | null, label?: string) => {
    await upsert('list_items', [{ id: uid(), list_id: l.id, entity_type: type, entity_id: eid, label: label ?? null, position: Math.max(0, ...items.map((x) => x.position)) + 1 }]); void touch(); setQ('');
  };
  const fn = norm(filter);
  const rel = (it: ListItem) => it.entity_type === 'release' ? ix.releases.get(it.entity_id!) : it.entity_type === 'track' ? ix.releases.get(ix.tracks.get(it.entity_id!)?.release_id ?? '') : undefined;
  const day = (it: ListItem) => { if (it.entity_type === 'artist') return ix.lastByArtist.get(it.entity_id ?? '') ?? ''; const r = rel(it); return r?.date ?? (r?.year ? String(r.year) : ''); };
  const rt = (it: ListItem) => it.entity_id ? ix.ann.get(`${it.entity_type}:${it.entity_id}`)?.rating ?? 0 : 0;
  const ttl = (it: ListItem) => itemView(ix, it)?.title ?? '';
  const sorted = itemSort === 'order' ? items : [...items].sort(
    itemSort === 'rating' ? (a, b) => rt(b) - rt(a) : itemSort === 'newest' ? (a, b) => day(b).localeCompare(day(a))
      : itemSort === 'oldest' ? (a, b) => (day(a) || '9999').localeCompare(day(b) || '9999') : (a, b) => ttl(a).localeCompare(ttl(b)));
  const shownItems = sorted.filter((it) => !fn || norm(`${itemView(ix, it)?.title} ${itemView(ix, it)?.sub} ${it.note ?? ''}`).includes(fn));
  const canMove = itemSort === 'order' && !fn;

  return (
    <div>
      <div className="hero" style={{ gridTemplateColumns: 'minmax(120px, 180px) 1fr', alignItems: 'end' }}>
        <ListCover list={l} items={items} onClick={() => setPicking(true)} />
        <div>
          <div className="muted" style={{ marginBottom: 6 }}>{isArt ? 'Artist list' : 'List'}</div>
          <input className="h-page" style={{ border: 0, background: 'transparent', width: '100%', padding: 0 }} value={l.name} aria-label="List name" onChange={(e) => upsert('lists', [{ ...l, name: e.target.value, updated_at: now() }])} />
          <input className="input" style={{ width: '100%', marginTop: 10, background: 'transparent' }} placeholder="Add a description" value={l.description ?? ''} onChange={(e) => upsert('lists', [{ ...l, description: e.target.value }])} />
        </div>
      </div>
      {picking && <CoverPicker list={l} items={items} onClose={() => setPicking(false)} />}
      <div className="row" style={{ margin: '16px 0 22px' }}>
        <FolderSelect list={l} />
        <label className="row"><input type="checkbox" checked={l.ranked} onChange={(e) => upsert('lists', [{ ...l, ranked: e.target.checked }])} /> Ranked</label>
        <SortSelect value={itemSort} onChange={setItemSort} options={isArt
          ? [['order', l.ranked ? 'Ranking' : l.custom_order ? 'Your order' : 'Your order (latest release first)'], ['rating', 'Your rating'], ['newest', 'Latest release'], ['title', 'A–Z']]
          : [['order', l.ranked ? 'Ranking' : l.custom_order ? 'Your order' : 'Your order (newest first)'], ['rating', 'Your rating'], ['newest', 'Newest first'], ['oldest', 'Oldest first'], ['title', 'A–Z']]} />
        <div className="seg" role="group" aria-label="View">{[['compact', 'List view'], ['covers', isArt ? 'Grid view' : 'Album view']].map(([v, t]) => <button key={v} className={(view === 'covers') === (v === 'covers') ? 'on' : ''} onClick={() => setView(v)}>{t}</button>)}</div>
        <span className="muted">{items.length} {isArt ? (items.length === 1 ? 'artist' : 'artists') : 'items'}</span>
        {items.length > 12 && <input className="input" placeholder="Filter this list" value={filter} onChange={(e) => setFilter(e.target.value)} />}
        {!canMove && items.length > 1 && <span className="small muted">{filter ? 'Clear the filter' : `Switch to “${l.ranked ? 'Ranking' : 'Your order'}”`} to drag items around</span>}
        <span className="spacer" />
        <button className="btn danger" onClick={async () => { if (confirm(`Delete the list “${l.name}”? Nothing in your library is deleted.`)) { await deleteList(l); nav('/lists'); } }}>Delete list</button>
      </div>
      <div className="search" style={{ maxWidth: 560, marginBottom: 20 }}>
        <input className="input" placeholder={isArt ? 'Add an artist — search your library' : 'Add from your library — search artists, releases, songs'} value={q} onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !results.length && q.trim()) void add('text', null, q.trim()); }} />
        {q.trim().length >= 2 && <div className="dropdown">
          {results.map((r) => <button key={r.type + r.id} className="dd-item btn ghost" style={{ width: '100%', justifyContent: 'flex-start', textAlign: 'left' }} onClick={() => add(r.type, r.id)}><span><strong>{r.title}</strong><div className="small muted">{r.sub}</div></span></button>)}
          <button className="dd-item btn ghost" style={{ width: '100%', justifyContent: 'flex-start' }} onClick={() => add('text', null, q.trim())}>Add “{q.trim()}” as a text item</button>
        </div>}
      </div>
      {!items.length ? <div className="empty">This list is empty. Search above, or use “Add to list” on any page.</div> : view === 'covers' ? (
        <CoverGrid groups={groupForCovers(ix, shownItems, l.ranked ? new Map(items.map((it, i) => [it.id, i + 1])) : undefined)} label={l.name} onReorder={canMove ? (ids) => void saveOrder(l, ids) : undefined} onRemove={(ids, title) => void removeItems(ids, title, false)} />
      ) : (
        <Sortable ids={shownItems.map((it) => it.id)} onReorder={(ids) => void saveOrder(l, ids)}><ol style={{ listStyle: 'none', padding: 0, margin: 0 }}>{shownItems.map((it) => {
          const i = items.indexOf(it); const v = itemView(ix, it);
          return (
            <SortableItem key={it.id} id={it.id} disabled={!canMove}>{({ ref, style, handle }) => (
            <li ref={ref} style={{ ...style, display: 'grid', gridTemplateColumns: `${canMove ? '24px ' : ''}${l.ranked ? '34px ' : ''}28px minmax(0, 1.4fr) minmax(0, 1fr) 190px`, gap: 10, alignItems: 'center', padding: '3px 0', borderBottom: '1px solid var(--line)', fontSize: 14, background: 'var(--bg)' }}>
              {canMove && handle}
              {l.ranked && <span className="num muted" style={{ textAlign: 'right', fontWeight: 700 }}>{i + 1}</span>}
              <Cover src={v?.img} title={v?.title ?? '?'} size={28} round={v?.round} />
              <span style={{ minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {v?.to ? <Link to={v.to} style={{ fontWeight: 600 }}>{v.title}</Link> : <strong>{v?.title ?? 'Removed from library'}</strong>}
                <span className="muted"> · {v?.sub}</span></span>
              <input className="input small" style={{ background: 'transparent', borderColor: 'transparent', padding: '2px 6px' }} placeholder="Add a note" defaultValue={it.note ?? ''}
                onBlur={(e) => e.target.value !== (it.note ?? '') && upsert('list_items', [{ ...it, note: e.target.value || null }])} />
              <div className="row" style={{ flexWrap: 'nowrap', gap: 2, justifyContent: 'flex-end' }}>
                {it.entity_type !== 'text' && it.entity_type !== 'list' && it.entity_id && <QuickRate type={it.entity_type} id={it.entity_id} />}
                <button className="btn sm ghost" aria-label="Remove" onClick={async () => { await remove('list_items', [it.id]); }}>✕</button>
              </div>
            </li>)}</SortableItem>);
        })}</ol></Sortable>
      )}
    </div>
  );
}
