import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { SortSelect, usePref } from '../components/controls';
import { Cover, QuickRate } from '../components/ui';
import PlaylistView from './Playlist';
import { norm, useStore, type Index } from '../lib/store';
import type { ListItem } from '../lib/types';
import { now, uid } from '../lib/util';

function itemView(ix: Index, it: ListItem) {
  if (it.entity_type === 'release') { const r = ix.releases.get(it.entity_id!); return r && { to: `/release/${r.id}`, title: r.title, sub: `${r.artist_credit} · ${r.year ?? ''}`, img: r.artwork_url, round: false }; }
  if (it.entity_type === 'artist') { const a = ix.artists.get(it.entity_id!); return a && { to: `/artist/${a.id}`, title: a.name, sub: 'Artist', img: a.image_url, round: true }; }
  if (it.entity_type === 'label') { const l = ix.labels.get(it.entity_id!); return l && { to: `/label/${l.id}`, title: l.name, sub: 'Label', img: l.image_url, round: false }; }
  if (it.entity_type === 'track') { const t = ix.tracks.get(it.entity_id!); const r = t?.release_id ? ix.releases.get(t.release_id) : undefined; return t && { to: `/track/${t.id}`, title: t.title, sub: `${t.artist_credit ?? r?.artist_credit ?? ''}${r ? ` · ${r.title}` : ''}`, img: r?.artwork_url, round: false }; }
  return { to: '', title: it.label ?? '', sub: 'Not in your library yet', img: null, round: false };
}

export function Lists() {
  const { data, ix, createList } = useStore();
  const nav = useNavigate();
  const [name, setName] = useState('');
  const [show, setShow] = usePref('lists.show', 'all');
  const [sort, setSort] = usePref('lists.sort', 'updated');
  const size = (id: string) => ix.itemsByList.get(id)?.length ?? 0;
  const lists = data.lists.filter((l) => show === 'all' || (l.kind ?? 'list') === show).sort(sort === 'az' ? (a, b) => a.name.localeCompare(b.name) : sort === 'created' ? (a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? '')
    : sort === 'size' ? (a, b) => size(b.id) - size(a.id) : (a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? ''));
  return (
    <div>
      <div className="row" style={{ marginBottom: 20 }}><h1 className="h-page">Lists</h1><span className="spacer" />
        <div className="seg" role="group" aria-label="Show">{[['all', 'All'], ['list', 'Lists'], ['playlist', 'Playlists']].map(([v, t]) => <button key={v} className={show === v ? 'on' : ''} onClick={() => setShow(v)}>{t}</button>)}</div>
        <SortSelect value={sort} onChange={setSort} options={[['updated', 'Recently changed'], ['created', 'Newest'], ['az', 'A–Z'], ['size', 'Biggest']]} /></div>
      <form className="row" style={{ marginBottom: 24 }} onSubmit={(e) => e.preventDefault()}>
        <input className="input" style={{ width: 300 }} placeholder="Name, e.g. Best of 2026 or Late night drive" value={name} onChange={(e) => setName(e.target.value)} />
        <button className="btn primary" disabled={!name.trim()} onClick={async () => { const id = await createList(name, 'playlist'); setName(''); nav(`/list/${id}`); }}>Create playlist</button>
        <button className="btn" disabled={!name.trim()} onClick={async () => { const id = await createList(name, 'list'); setName(''); nav(`/list/${id}`); }}>Create list</button>
        <span className="small muted">Playlists are songs you can play in order. Lists can hold anything — albums, artists, songs.</span>
      </form>
      {!lists.length ? <div className="empty">No lists yet. Make one above, or use “Add to list” on any artist, release or song.</div> : (
        <div className="grid">{lists.map((l) => {
          const items = [...(ix.itemsByList.get(l.id) ?? [])].sort((a, b) => a.position - b.position);
          const imgs = items.map((i) => itemView(ix, i)?.img).filter(Boolean).slice(0, 4) as string[];
          return (
            <Link key={l.id} to={`/list/${l.id}`} className="tile" style={{ textDecoration: 'none' }}>
              <div className="cover" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr' }}>
                {imgs.length === 4 ? imgs.map((s, i) => <img key={i} src={s} alt="" loading="lazy" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />) : <Cover src={imgs[0]} title={l.name} />}
              </div>
              <div className="t">{l.name}</div><div className="s">{l.kind === 'playlist' ? `Playlist · ${items.length} song${items.length === 1 ? '' : 's'}` : `${items.length} item${items.length === 1 ? '' : 's'}`}</div>
            </Link>);
        })}</div>
      )}
    </div>
  );
}

export default function ListPage() {
  const { id } = useParams();
  const { data, ix, upsert, remove } = useStore();
  const nav = useNavigate();
  const l = ix.lists.get(id!);
  const items = useMemo(() => [...(ix.itemsByList.get(id!) ?? [])].sort((a, b) => a.position - b.position), [ix, id]);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState('');
  const [itemSort, setItemSort] = useState('order');
  const [compact, setCompact] = usePref('list.compact', false);
  const results = useMemo(() => {
    const n = norm(q); if (n.length < 2) return [];
    return [
      ...data.artists.filter((a) => norm(a.name).includes(n)).slice(0, 4).map((a) => ({ type: 'artist' as const, id: a.id, title: a.name, sub: 'Artist' })),
      ...data.releases.filter((r) => norm(`${r.artist_credit} ${r.title}`).includes(n)).slice(0, 8).map((r) => ({ type: 'release' as const, id: r.id, title: r.title, sub: `${r.artist_credit} · ${r.year ?? ''}` })),
      ...data.tracks.filter((t) => norm(t.title).includes(n)).slice(0, 4).map((t) => ({ type: 'track' as const, id: t.id, title: t.title, sub: `Song · ${t.artist_credit ?? ''}` })),
    ];
  }, [q, data]);
  if (!l) return <div className="empty">List not found. <Link to="/lists">All lists</Link></div>;
  if (l.kind === 'playlist') return <PlaylistView list={l} />;

  const renumber = (arr: ListItem[]) => upsert('list_items', arr.map((it, i) => ({ ...it, position: i + 1 })));
  const move = (i: number, d: number) => { const a = [...items]; const j = i + d; if (j < 0 || j >= a.length) return; [a[i], a[j]] = [a[j], a[i]]; void renumber(a); };
  const touch = () => upsert('lists', [{ ...l, updated_at: now() }]);
  const add = async (type: ListItem['entity_type'], eid: string | null, label?: string) => {
    await upsert('list_items', [{ id: uid(), list_id: l.id, entity_type: type, entity_id: eid, label: label ?? null, position: (items.at(-1)?.position ?? 0) + 1 }]); void touch(); setQ('');
  };
  const fn = norm(filter);
  const rel = (it: ListItem) => it.entity_type === 'release' ? ix.releases.get(it.entity_id!) : it.entity_type === 'track' ? ix.releases.get(ix.tracks.get(it.entity_id!)?.release_id ?? '') : undefined;
  const day = (it: ListItem) => { const r = rel(it); return r?.date ?? (r?.year ? String(r.year) : ''); };
  const rt = (it: ListItem) => it.entity_id ? ix.ann.get(`${it.entity_type}:${it.entity_id}`)?.rating ?? 0 : 0;
  const ttl = (it: ListItem) => itemView(ix, it)?.title ?? '';
  const sorted = itemSort === 'order' ? items : [...items].sort(
    itemSort === 'rating' ? (a, b) => rt(b) - rt(a) : itemSort === 'newest' ? (a, b) => day(b).localeCompare(day(a))
      : itemSort === 'oldest' ? (a, b) => (day(a) || '9999').localeCompare(day(b) || '9999') : (a, b) => ttl(a).localeCompare(ttl(b)));
  const shownItems = sorted.filter((it) => !fn || norm(`${itemView(ix, it)?.title} ${itemView(ix, it)?.sub} ${it.note ?? ''}`).includes(fn));
  const canMove = itemSort === 'order' && !fn;

  return (
    <div>
      <input className="h-page" style={{ border: 0, background: 'transparent', width: '100%', padding: 0 }} value={l.name} aria-label="List name" onChange={(e) => upsert('lists', [{ ...l, name: e.target.value, updated_at: now() }])} />
      <input className="input" style={{ width: '100%', marginTop: 10, background: 'transparent' }} placeholder="Add a description" value={l.description ?? ''} onChange={(e) => upsert('lists', [{ ...l, description: e.target.value }])} />
      <div className="row" style={{ margin: '16px 0 22px' }}>
        <label className="row"><input type="checkbox" checked={l.ranked} onChange={(e) => upsert('lists', [{ ...l, ranked: e.target.checked }])} /> Ranked</label>
        <SortSelect value={itemSort} onChange={setItemSort} options={[['order', l.ranked ? 'Ranking' : 'List order'], ['rating', 'Your rating'], ['newest', 'Newest first'], ['oldest', 'Oldest first'], ['title', 'A–Z']]} />
        <div className="seg" role="group" aria-label="View"><button className={!compact ? 'on' : ''} onClick={() => setCompact(false)}>Roomy</button><button className={compact ? 'on' : ''} onClick={() => setCompact(true)}>Compact</button></div>
        <span className="muted">{items.length} items</span>
        {items.length > 12 && <input className="input" placeholder="Filter this list" value={filter} onChange={(e) => setFilter(e.target.value)} />}
        <span className="spacer" />
        <button className="btn danger" onClick={async () => { if (confirm(`Delete the list “${l.name}”? Nothing in your library is deleted.`)) { await remove('list_items', items.map((i) => i.id)); await remove('lists', [l.id]); nav('/lists'); } }}>Delete list</button>
      </div>
      <div className="search" style={{ maxWidth: 560, marginBottom: 20 }}>
        <input className="input" placeholder="Add from your library — search artists, releases, songs" value={q} onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !results.length && q.trim()) void add('text', null, q.trim()); }} />
        {q.trim().length >= 2 && <div className="dropdown">
          {results.map((r) => <button key={r.type + r.id} className="dd-item btn ghost" style={{ width: '100%', justifyContent: 'flex-start', textAlign: 'left' }} onClick={() => add(r.type, r.id)}><span><strong>{r.title}</strong><div className="small muted">{r.sub}</div></span></button>)}
          <button className="dd-item btn ghost" style={{ width: '100%', justifyContent: 'flex-start' }} onClick={() => add('text', null, q.trim())}>Add “{q.trim()}” as a text item</button>
        </div>}
      </div>
      {!items.length ? <div className="empty">This list is empty. Search above, or use “Add to list” on any page.</div> : (
        <ol style={{ listStyle: 'none', padding: 0, margin: 0 }}>{shownItems.map((it) => {
          const i = items.indexOf(it); const v = itemView(ix, it);
          return (
            compact ? (
            <li key={it.id} style={{ display: 'grid', gridTemplateColumns: `${l.ranked ? '34px ' : ''}28px minmax(0, 1.4fr) minmax(0, 1fr) 190px`, gap: 10, alignItems: 'center', padding: '3px 0', borderBottom: '1px solid var(--line)', fontSize: 14 }}>
              {l.ranked && <span className="num muted" style={{ textAlign: 'right', fontWeight: 700 }}>{i + 1}</span>}
              <Cover src={v?.img} title={v?.title ?? '?'} size={28} round={v?.round} />
              <span style={{ minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {v?.to ? <Link to={v.to} style={{ fontWeight: 600 }}>{v.title}</Link> : <strong>{v?.title ?? 'Removed from library'}</strong>}
                <span className="muted"> · {v?.sub}</span></span>
              <input className="input small" style={{ background: 'transparent', borderColor: 'transparent', padding: '2px 6px' }} placeholder="Add a note" defaultValue={it.note ?? ''}
                onBlur={(e) => e.target.value !== (it.note ?? '') && upsert('list_items', [{ ...it, note: e.target.value || null }])} />
              <div className="row" style={{ flexWrap: 'nowrap', gap: 2, justifyContent: 'flex-end' }}>
                {it.entity_type !== 'text' && it.entity_id && <QuickRate type={it.entity_type} id={it.entity_id} />}
                {l.ranked && <><button className="btn sm ghost" aria-label="Move up" disabled={i === 0 || !canMove} onClick={() => move(i, -1)}>↑</button><button className="btn sm ghost" aria-label="Move down" disabled={i === items.length - 1 || !canMove} onClick={() => move(i, 1)}>↓</button></>}
                <button className="btn sm ghost" aria-label="Remove" onClick={async () => { await remove('list_items', [it.id]); }}>✕</button>
              </div>
            </li>) : (
            <li key={it.id} style={{ display: 'grid', gridTemplateColumns: `${l.ranked ? '44px ' : ''}56px 1fr auto`, gap: 14, alignItems: 'center', padding: '10px 0', borderBottom: '1px solid var(--line)' }}>
              {l.ranked && <span className="num" style={{ fontSize: 26, fontWeight: 800, fontVariationSettings: "'wdth' 70", textAlign: 'right', color: 'var(--muted)' }}>{i + 1}</span>}
              <Cover src={v?.img} title={v?.title ?? '?'} size={56} round={v?.round} />
              <div style={{ minWidth: 0 }}>
                {v?.to ? <Link to={v.to} style={{ fontWeight: 700 }}>{v.title}</Link> : <strong>{v?.title ?? 'Removed from library'}</strong>}
                <div className="small muted">{v?.sub}{it.entity_type === 'text' && <> · <Link to={`/find?q=${encodeURIComponent((it.label ?? '').replace(/\s*\(\d{4}\)$/, '').replace(' — ', ' '))}`}>find it</Link></>}</div>
                <input className="input small" style={{ width: '100%', marginTop: 4, background: 'transparent', borderColor: 'transparent' }} placeholder="Add a note" defaultValue={it.note ?? ''}
                  onBlur={(e) => e.target.value !== (it.note ?? '') && upsert('list_items', [{ ...it, note: e.target.value || null }])} />
              </div>
              <div className="row" style={{ flexWrap: 'nowrap', gap: 4 }}>
                {it.entity_type !== 'text' && it.entity_id && <QuickRate type={it.entity_type} id={it.entity_id} />}
                {l.ranked && <><button className="btn sm ghost" aria-label="Move up" disabled={i === 0 || !canMove} onClick={() => move(i, -1)}>Up</button><button className="btn sm ghost" aria-label="Move down" disabled={i === items.length - 1 || !canMove} onClick={() => move(i, 1)}>Down</button></>}
                <button className="btn sm ghost" onClick={async () => { await remove('list_items', [it.id]); }}>Remove</button>
              </div>
            </li>));
        })}</ol>
      )}
    </div>
  );
}
