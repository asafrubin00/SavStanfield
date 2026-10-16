import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Cover, Credits, QuickRate, ReleaseTile } from '../components/ui';
import { norm, useStore } from '../lib/store';
import { RELEASE_TYPES } from '../lib/types';
import { ReleaseForm } from './ReleasePage';

const PAGE = 120;

export default function Library() {
  const { data, ix } = useStore();
  const [sp, setSp] = useSearchParams();
  const [shown, setShown] = useState(PAGE);
  const [adding, setAdding] = useState(false);
  const get = (k: string) => sp.get(k) ?? '';
  const set = (k: string, v: string | null) => { const n = new URLSearchParams(sp); if (v) n.set(k, v); else n.delete(k); setSp(n, { replace: true }); setShown(PAGE); };
  const types = get('type') ? get('type').split(',') : [];
  const view = get('view') || 'grid';
  const sort = get('sort') || 'date-desc';

  // Producers credited on each release (exec producers + track producers)
  const producersByRelease = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const c of data.credits) {
      if (c.role !== 'producer' && c.role !== 'exec_producer') continue;
      const rid = c.release_id ?? (c.track_id ? ix.tracks.get(c.track_id)?.release_id : null);
      if (!rid) continue;
      (m.get(rid) ?? m.set(rid, new Set()).get(rid)!).add(c.artist_id);
    }
    return m;
  }, [data.credits, ix]);
  const producers = useMemo(() => data.artists.filter((a) => a.is_producer).sort((a, b) => a.name.localeCompare(b.name)), [data.artists]);
  const decades = useMemo(() => [...new Set(data.releases.map((r) => r.year ? Math.floor(r.year / 10) * 10 : null).filter(Boolean) as number[])].sort(), [data.releases]);
  const presentTypes = useMemo(() => { const s = new Set(data.releases.map((r) => r.type)); return [...RELEASE_TYPES.filter((t) => s.has(t)), ...[...s].filter((t) => !RELEASE_TYPES.includes(t))]; }, [data.releases]);

  const rows = useMemo(() => {
    const q = norm(get('q'));
    const yFrom = Number(get('from')) || 0, yTo = Number(get('to')) || 9999;
    const dec = get('decade'); const rating = get('rating'); const prod = get('producer');
    const fav = get('fav') === '1', reviewed = get('reviewed') === '1', linked = get('linked');
    const today = new Date().toISOString().slice(0, 10);
    const upcoming = get('when');
    const out = data.releases.filter((r) => {
      if (q && !norm(`${r.title} ${r.artist_credit ?? ''} ${r.label ?? ''}`).includes(q)) return false;
      if (types.length && !types.includes(r.type)) return false;
      const y = r.year ?? 0;
      if (y < yFrom || y > yTo) return false;
      if (dec && Math.floor(y / 10) * 10 !== Number(dec)) return false;
      const a = ix.ann.get(`release:${r.id}`);
      if (rating === 'unrated' && a?.rating) return false;
      if (rating && rating !== 'unrated' && (a?.rating ?? 0) < Number(rating)) return false;
      if (rating === '5' && a?.rating !== 5) return false;
      if (fav && !a?.favorite) return false;
      if (reviewed && !a?.review && !a?.notes) return false;
      if (prod && !producersByRelease.get(r.id)?.has(prod)) return false;
      if (linked === 'no' && (r.links.apple || r.artwork_url)) return false;
      if (linked === 'yes' && !r.links.apple) return false;
      if (upcoming === 'upcoming' && !(r.date && r.date > today)) return false;
      if (upcoming === 'released' && r.date && r.date > today) return false;
      return true;
    });
    const rv = (id: string) => ix.ann.get(`release:${id}`)?.rating ?? 0;
    const cmp: Record<string, (a: typeof out[0], b: typeof out[0]) => number> = {
      'date-desc': (a, b) => (b.date ?? `${b.year ?? 0}`).localeCompare(a.date ?? `${a.year ?? 0}`),
      'date-asc': (a, b) => (a.date ?? `${a.year ?? 9999}`).localeCompare(b.date ?? `${b.year ?? 9999}`),
      rating: (a, b) => rv(b.id) - rv(a.id) || (b.year ?? 0) - (a.year ?? 0),
      title: (a, b) => a.title.localeCompare(b.title),
      artist: (a, b) => (a.artist_credit ?? '').localeCompare(b.artist_credit ?? '') || (a.date ?? '').localeCompare(b.date ?? ''),
      added: (a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''),
    };
    return out.sort(cmp[sort] ?? cmp['date-desc']);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.releases, ix, sp, producersByRelease]);

  const active = [...sp.keys()].filter((k) => !['view', 'sort'].includes(k)).length;

  return (
    <div>
      <div className="row" style={{ marginBottom: 20 }}>
        <h1 className="h-page">Library</h1><span className="spacer" />
        <button className="btn" onClick={() => setAdding(true)}>Add a release by hand</button>
      </div>
      <div className="lib">
        <aside className="filters panel" aria-label="Filters">
          <label><span className="label">Title, artist or label</span><input className="input" style={{ width: '100%' }} value={get('q')} onChange={(e) => set('q', e.target.value)} placeholder="Filter…" /></label>
          <div><span className="label">Type</span><div className="row" style={{ gap: 5 }}>
            {presentTypes.map((t) => <button key={t} className={`chip${types.includes(t) ? ' on' : ''}`} onClick={() => set('type', (types.includes(t) ? types.filter((x) => x !== t) : [...types, t]).join(',') || null)}>{t}</button>)}
          </div></div>
          <label><span className="label">Decade</span><select className="select" style={{ width: '100%' }} value={get('decade')} onChange={(e) => set('decade', e.target.value)}>
            <option value="">Any</option>{decades.map((d) => <option key={d} value={d}>{d}s</option>)}</select></label>
          <div><span className="label">Years</span><div className="row" style={{ flexWrap: 'nowrap' }}>
            <input className="input num" style={{ width: '100%' }} inputMode="numeric" placeholder="From" value={get('from')} onChange={(e) => set('from', e.target.value)} />
            <input className="input num" style={{ width: '100%' }} inputMode="numeric" placeholder="To" value={get('to')} onChange={(e) => set('to', e.target.value)} /></div></div>
          <label><span className="label">Your rating</span><select className="select" style={{ width: '100%' }} value={get('rating')} onChange={(e) => set('rating', e.target.value)}>
            <option value="">Any</option><option value="5">★★★★★ only</option><option value="4">★★★★ and up</option><option value="3">★★★ and up</option><option value="2">★★ and up</option><option value="1">Rated</option><option value="unrated">Not rated yet</option></select></label>
          <label><span className="label">Producer</span><select className="select" style={{ width: '100%' }} value={get('producer')} onChange={(e) => set('producer', e.target.value)}>
            <option value="">Any</option>{producers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
          <label><span className="label">Release date</span><select className="select" style={{ width: '100%' }} value={get('when')} onChange={(e) => set('when', e.target.value)}>
            <option value="">Any</option><option value="released">Out now</option><option value="upcoming">Upcoming</option></select></label>
          <label><span className="label">Links</span><select className="select" style={{ width: '100%' }} value={get('linked')} onChange={(e) => set('linked', e.target.value)}>
            <option value="">Any</option><option value="yes">Linked to Apple Music</option><option value="no">Not linked yet</option></select></label>
          <label className="row"><input type="checkbox" checked={get('fav') === '1'} onChange={(e) => set('fav', e.target.checked ? '1' : null)} /> Favourites only</label>
          <label className="row"><input type="checkbox" checked={get('reviewed') === '1'} onChange={(e) => set('reviewed', e.target.checked ? '1' : null)} /> Has a review or notes</label>
          {active > 0 && <button className="btn" onClick={() => setSp(new URLSearchParams(Object.fromEntries([...sp].filter(([k]) => k === 'view' || k === 'sort'))), { replace: true })}>Clear filters</button>}
        </aside>
        <section>
          <div className="row" style={{ marginBottom: 16 }}>
            <strong className="num">{rows.length.toLocaleString()}</strong><span className="muted">release{rows.length === 1 ? '' : 's'}</span>
            <span className="spacer" />
            <select className="select" value={sort} onChange={(e) => set('sort', e.target.value)} aria-label="Sort">
              <option value="date-desc">Newest first</option><option value="date-asc">Oldest first</option><option value="rating">Highest rated</option>
              <option value="artist">Artist A–Z</option><option value="title">Title A–Z</option><option value="added">Recently added</option></select>
            <div className="seg" role="group" aria-label="View">
              <button className={view === 'grid' ? 'on' : ''} onClick={() => set('view', null)}>Covers</button>
              <button className={view === 'table' ? 'on' : ''} onClick={() => set('view', 'table')}>Table</button></div>
          </div>
          {!rows.length ? <div className="empty">Nothing matches these filters.</div> : view === 'grid' ? (
            <div className="grid">{rows.slice(0, shown).map((r) => <ReleaseTile key={r.id} r={r} />)}</div>
          ) : (
            <div className="table-wrap"><table className="table">
              <thead><tr><th className="thumb" /><th onClick={() => set('sort', 'title')}>Title</th><th onClick={() => set('sort', 'artist')}>Artist</th><th>Type</th><th onClick={() => set('sort', sort === 'date-desc' ? 'date-asc' : null)}>Date</th><th onClick={() => set('sort', 'rating')}>Rating</th></tr></thead>
              <tbody>{rows.slice(0, shown).map((r) => (
                <tr key={r.id}><td><Link to={`/release/${r.id}`}><Cover src={r.artwork_url} title={r.title} size={36} /></Link></td>
                  <td><Link to={`/release/${r.id}`} style={{ fontWeight: 600 }}>{r.title}</Link></td>
                  <td><Credits release={r} /></td><td className="muted">{r.type}</td>
                  <td className="num muted" style={{ whiteSpace: 'nowrap' }}>{r.date ?? r.year ?? ''}</td>
                  <td><QuickRate type="release" id={r.id} /></td></tr>))}</tbody>
            </table></div>
          )}
          {rows.length > shown && <div style={{ textAlign: 'center', marginTop: 24 }}><button className="btn" onClick={() => setShown((s) => s + PAGE * 2)}>Show more ({(rows.length - shown).toLocaleString()} left)</button></div>}
        </section>
      </div>
      {adding && <ReleaseForm onClose={() => setAdding(false)} />}
    </div>
  );
}
