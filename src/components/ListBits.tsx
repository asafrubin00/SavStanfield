import { useState, type CSSProperties, type ReactNode } from 'react';
import { closestCenter, DndContext, KeyboardSensor, PointerSensor, TouchSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { arrayMove, rectSortingStrategy, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Link } from 'react-router-dom';
import { player } from '../lib/player';
import { missingColumns } from '../lib/db';
import { useStore, type Index } from '../lib/store';
import type { List, ListItem, Release } from '../lib/types';
import { now } from '../lib/util';
import { Cover, Credits, Modal, TileRate } from './ui';

/** Cover images for a list: the custom cover if set, otherwise up to four covers from what's in it. */
export function listImages(ix: Index, items: ListItem[]): string[] {
  const out: string[] = [];
  for (const it of items) {
    const id = it.entity_id ?? '';
    const img = it.entity_type === 'release' ? ix.releases.get(id)?.artwork_url
      : it.entity_type === 'track' ? ix.releases.get(ix.tracks.get(id)?.release_id ?? '')?.artwork_url
        : it.entity_type === 'artist' ? ix.artists.get(id)?.image_url : it.entity_type === 'label' ? ix.labels.get(id)?.image_url : null;
    if (img && !out.includes(img)) out.push(img);
    if (out.length === 4) break;
  }
  return out;
}

export function ListCover({ list, items, onClick }: { list: List; items: ListItem[]; onClick?: () => void }) {
  const { ix } = useStore();
  const imgs = list.cover_url ? [] : listImages(ix, items);
  const body = list.cover_url ? <img src={list.cover_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
    : imgs.length === 4 ? <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', width: '100%', height: '100%' }}>{imgs.map((s, i) => <img key={i} src={s} alt="" loading="lazy" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />)}</div>
      : <Cover src={imgs[0]} title={list.name} />;
  return onClick
    ? <button type="button" className="cover list-cover" onClick={onClick} title="Change cover" style={{ padding: 0, border: 0, cursor: 'pointer', display: 'block', width: '100%' }}>{body}<span className="list-cover-edit">Change cover</span></button>
    : <div className="cover">{body}</div>;
}

/** Shrink an image to a square-ish JPEG data URL so it can be stored with the list. */
async function shrink(file: Blob, max = 700): Promise<string> {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas'); c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
  c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.85);
}

export function CoverPicker({ list, items, onClose }: { list: List; items: ListItem[]; onClose: () => void }) {
  const { ix, upsert, say } = useStore();
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const needsSql = missingColumns.has('lists.cover_url');
  const choices = [...new Set(items.flatMap((it) => {
    const id = it.entity_id ?? '';
    const r = it.entity_type === 'release' ? ix.releases.get(id) : it.entity_type === 'track' ? ix.releases.get(ix.tracks.get(id)?.release_id ?? '') : undefined;
    return r?.artwork_url ? [r.artwork_url] : it.entity_type === 'artist' && ix.artists.get(id)?.image_url ? [ix.artists.get(id)!.image_url!] : [];
  }))].slice(0, 24);
  const set = async (cover_url: string | null) => { await upsert('lists', [{ ...list, cover_url, updated_at: now() }]); say(cover_url ? 'Cover updated' : 'Back to the automatic cover'); onClose(); };
  const fromFile = async (f?: Blob | null) => { if (!f) return; setBusy(true); try { await set(await shrink(f)); } catch { say('Couldn’t read that image'); } finally { setBusy(false); } };
  return (
    <Modal title="Cover" onClose={onClose}>
      <div onPaste={(e) => { const f = [...e.clipboardData.items].find((i) => i.type.startsWith('image/'))?.getAsFile(); if (f) { e.preventDefault(); void fromFile(f); } }}>
        {needsSql && <div className="panel" style={{ marginBottom: 12, borderColor: 'var(--accent)' }}>Custom covers need a one-time database update: run <code>supabase/005-list-order.sql</code> in Supabase’s SQL Editor, then reload.</div>}
        <div className="row" style={{ marginBottom: 12 }}>
          <label className="btn primary">Upload an image<input type="file" accept="image/*" hidden onChange={(e) => void fromFile(e.target.files?.[0])} /></label>
          <span className="small muted">or paste an image here (⌘V)</span>
        </div>
        <form className="row" style={{ marginBottom: 16, flexWrap: 'nowrap' }} onSubmit={(e) => { e.preventDefault(); if (/^https?:\/\//.test(url.trim())) void set(url.trim()); }}>
          <input className="input" style={{ flex: 1 }} placeholder="…or an image URL" value={url} onChange={(e) => setUrl(e.target.value)} />
          <button className="btn" disabled={!/^https?:\/\//.test(url.trim())}>Use</button>
        </form>
        {choices.length > 0 && <>
          <div className="label">Or pick one from this list</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(72px, 1fr))', gap: 6, marginBottom: 16 }}>
            {choices.map((c) => <button key={c} type="button" style={{ padding: 0, border: 0, background: 'none', cursor: 'pointer', aspectRatio: '1' }} onClick={() => void set(c)}><img src={c} alt="" loading="lazy" style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: 4 }} /></button>)}
          </div>
        </>}
        <div className="row"><span className="spacer" />{busy && <span className="small muted">Saving…</span>}{list.cover_url && <button className="btn" onClick={() => void set(null)}>Use automatic cover</button>}<button className="btn" onClick={onClose}>Close</button></div>
      </div>
    </Modal>
  );
}

/** One tile in the covers view: an album (with the songs from it), an artist, a label or a text entry. */
type Group = { key: string; itemIds: string[]; rank?: number; release?: Release; trackIds: string[]; to?: string; title: string; sub: string; img?: string | null; round?: boolean; rate?: { type: 'release' | 'artist' | 'label' | 'track'; id: string } };

/** Group list items into cover tiles, keeping the order they're given in. Songs from the same album share a tile. */
export function groupForCovers(ix: Index, items: ListItem[], ranks?: Map<string, number>): Group[] {
  const groups = new Map<string, Group>();
  for (const it of items) {
    const id = it.entity_id ?? '';
    const rank = ranks?.get(it.id);
    if (it.entity_type === 'track' || it.entity_type === 'release') {
      const t = it.entity_type === 'track' ? ix.tracks.get(id) : undefined;
      const r = it.entity_type === 'release' ? ix.releases.get(id) : t?.release_id ? ix.releases.get(t.release_id) : undefined;
      const key = r ? `r${r.id}` : `t${id}`;
      const g = groups.get(key) ?? { key, itemIds: [] as string[], rank, release: r, trackIds: [], to: r ? `/release/${r.id}` : t ? `/track/${t.id}` : undefined, title: r?.title ?? t?.title ?? 'Loading…', sub: r ? `${r.artist_credit ?? ''}${r.year ? ` · ${r.year}` : ''}` : t?.artist_credit ?? '', img: r?.artwork_url, rate: r ? { type: 'release' as const, id: r.id } : t ? { type: 'track' as const, id: t.id } : undefined };
      if (t) g.trackIds.push(t.id);
      g.itemIds.push(it.id);
      groups.set(key, g);
    } else if (it.entity_type === 'artist') {
      const a = ix.artists.get(id); groups.set(`a${id}`, { key: `a${id}`, itemIds: [it.id], rank, trackIds: [], to: a ? `/artist/${id}` : undefined, title: a?.name ?? 'Removed', sub: 'Artist', img: a?.image_url, round: true, rate: a ? { type: 'artist', id } : undefined });
    } else if (it.entity_type === 'label') {
      const l = ix.labels.get(id); groups.set(`l${id}`, { key: `l${id}`, itemIds: [it.id], rank, trackIds: [], to: l ? `/label/${id}` : undefined, title: l?.name ?? 'Removed', sub: 'Label', img: l?.image_url });
    } else groups.set(`x${it.id}`, { key: `x${it.id}`, itemIds: [it.id], rank, trackIds: [], title: it.label ?? '', sub: 'Not in your library yet' });
  }
  return [...groups.values()];
}

export function CoverGrid({ groups, label, extra, onReorder }: { groups: Group[]; label: string; extra?: (g: Group) => ReactNode; onReorder?: (itemIds: string[]) => void }) {
  const ids = groups.map((g) => g.key);
  const grid = (
    <div className="grid">{groups.map((g) => (
      <SortableItem key={g.key} id={g.key} disabled={!onReorder}>{({ ref, style, handle }) => (
      <div ref={ref} style={style} className="tile">
        <div className="tile-cover">
          {onReorder && <span className="tile-handle">{handle}</span>}
          {g.to ? <Link to={g.to} style={{ display: 'block' }}><Cover src={g.img} title={g.title} round={g.round} /></Link> : <Cover src={g.img} title={g.title} />}
          {g.rate && !g.round && <TileRate type={g.rate.type} id={g.rate.id} />}
          {g.rank && <span className="tile-rank">{g.rank}</span>}
          {g.trackIds.length > 0 && <button type="button" className="tile-play" aria-label={`Play ${g.title}`} title={`Play ${g.trackIds.length > 1 ? `these ${g.trackIds.length} songs` : 'this song'}`} onClick={() => player.play(g.trackIds, 0, label)}>▶</button>}
        </div>
        <div className="t">{g.to ? <Link to={g.to}>{g.title}</Link> : g.title}{g.release && g.release.type !== 'Album' ? <span className="muted" style={{ fontWeight: 400 }}> – {g.release.type}</span> : null}</div>
        <div className="s">{g.release ? <><Credits release={g.release} />{g.release.year ? ` · ${g.release.year}` : ''}</> : g.sub}</div>
        {g.round && g.rate && <TileRate type={g.rate.type} id={g.rate.id} inline />}
        {(g.trackIds.length > 1 || extra) && <div className="meta">{g.trackIds.length > 1 && <span>{g.trackIds.length} songs</span>}{extra?.(g)}</div>}
      </div>)}</SortableItem>))}
    </div>
  );
  if (!onReorder) return grid;
  // Moving a tile moves every item in it (an album's songs travel together)
  return <Sortable ids={ids} grid onReorder={(keys) => onReorder(keys.flatMap((k) => groups.find((g) => g.key === k)!.itemIds))}>{grid}</Sortable>;
}

// ——— Drag and drop ———
/** Wraps a list (or grid) whose children are SortableItems; reports the new order of ids when something is dropped. */
export function Sortable({ ids, onReorder, grid, children }: { ids: string[]; onReorder: (ids: string[]) => void; grid?: boolean; children: ReactNode }) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    const from = ids.indexOf(String(e.active.id)); const to = ids.indexOf(String(e.over.id));
    if (from >= 0 && to >= 0) onReorder(arrayMove(ids, from, to));
  };
  return <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}><SortableContext items={ids} strategy={grid ? rectSortingStrategy : verticalListSortingStrategy}>{children}</SortableContext></DndContext>;
}

/** One draggable row or tile. Render-prop gives the ref and style for the element, and the grip handle to place in it. */
export function SortableItem({ id, disabled, children }: { id: string; disabled?: boolean; children: (p: { ref: (el: HTMLElement | null) => void; style: CSSProperties; handle: ReactNode; dragging: boolean }) => ReactNode }) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id, disabled });
  const style: CSSProperties = { transform: CSS.Translate.toString(transform), transition, position: 'relative', zIndex: isDragging ? 5 : undefined, opacity: isDragging ? 0.85 : undefined, boxShadow: isDragging ? '0 6px 20px rgba(0,0,0,.25)' : undefined };
  const handle = disabled ? null : <button type="button" ref={setActivatorNodeRef} className="drag-handle" aria-label="Drag to reorder" title="Drag to reorder" {...attributes} {...listeners}>⋮⋮</button>;
  return <>{children({ ref: setNodeRef, style, handle, dragging: isDragging })}</>;
}

/** The order a list is shown in by default: yours once you've dragged anything (or it's ranked), otherwise newest release first. */
export function orderItems(ix: Index, list: List, items: ListItem[]): ListItem[] {
  const byPos = [...items].sort((a, b) => a.position - b.position);
  if (list.custom_order || list.ranked) return byPos;
  const day = (it: ListItem) => {
    const id = it.entity_id ?? '';
    const r = it.entity_type === 'release' ? ix.releases.get(id) : it.entity_type === 'track' ? ix.releases.get(ix.tracks.get(id)?.release_id ?? '') : undefined;
    return r?.date ?? (r?.year ? String(r.year) : '');
  };
  return byPos.map((it, i) => ({ it, i, d: day(it) })).sort((a, b) => (b.d && a.d ? b.d.localeCompare(a.d) : a.d ? -1 : b.d ? 1 : 0) || a.i - b.i).map((x) => x.it);
}

/** Save a new hand-made order: positions follow the given ids, and the list remembers it's been ordered by hand. */
export function useSaveOrder() {
  const { upsert, ix } = useStore();
  return async (list: List, orderedIds: string[]) => {
    const all = ix.itemsByList.get(list.id) ?? [];
    const rest = all.filter((it) => !orderedIds.includes(it.id)).sort((a, b) => a.position - b.position).map((it) => it.id);
    const pos = new Map([...orderedIds, ...rest].map((id, i) => [id, i + 1]));
    await upsert('list_items', all.filter((it) => it.position !== pos.get(it.id)).map((it) => ({ ...it, position: pos.get(it.id)! })));
    if (!list.custom_order) await upsert('lists', [{ ...list, custom_order: true, updated_at: now() }]);
  };
}
