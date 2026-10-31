import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { MultiSelect, RatingSelect, ratingMatches, SortSelect } from '../components/controls';
import { Cover, Credits, fmtDate, QuickRate, ReleaseTile } from '../components/ui';
import EditCell from '../components/EditCell';
import { ImagePicker } from '../components/ListBits';
import { useEdits } from '../lib/edits';
import { norm, useStore } from '../lib/store';
import { RELEASE_TYPES } from '../lib/types';
import { ReleaseForm } from './ReleasePage';
import { usePageState } from '../lib/nav';

const PAGE = 120;

export default function Library() {
  const { data, ix } = useStore();
  const [sp, setSp] = useSearchParams();
  const [shown, setShown] = usePageState('shown', PAGE);
  const [adding, setAdding] = useState(false);
  const [coverFor, setCoverFor] = useState<import('../lib/types').Release | null>(null);
  const E = useEdits(); const { say } = useStore();
  const get = (k: string) => sp.get(k) ?? '';
  const set = (k: string, v: string | null) => { const n = new URLSearchParams(sp); if (v) n.set(k, v); else n.delete(k); setSp(n, { replace: true }); setShown(PAGE); };
  const types = get('type') ? get('type').split(',') : [];
  const view = get('view') || 'grid';
  const sort = get('sort') || 'date-desc';
  const rev = get('rev') === '1';
  /** Click a column header to sort by it; click again to flip. */
  const sortBy = (k: string) => { const n = new URLSearchParams(sp); if (sort === k) { if (rev) n.delete('rev'); else n.set('rev', '1'); } else { if (k === 'date-desc') n.delete('sort'); else n.set('sort', k); n.delete('rev'); } setSp(n, { replace: true }); };
  const arrow = (k: string, up: boolean) => (sort === k ? ((up !== rev) ? ' ↑' : ' ↓') : '');

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
  const labels = useMemo(() => [...data.labels].sort((a, b) => a.name.localeCompare(b.name)), [data.labels]);
  const typeCounts = useMemo(() => { const c: Record<string, number> = {}; for (const r of data.releases) c[r.type] = (c[r.type] ?? 0) + 1; return c; }, [data.releases]);
  const presentTypes = useMemo(() => { const s = new Set(data.releases.map((r) => r.type)); return [...RELEASE_TYPES.filter((t) => s.has(t)), ...[...s].filter((t) => !RELEASE_TYPES.includes(t))]; }, [data.releases]);

  const rows = useMemo(() => {
    const q = norm(get('q'));
    const yFrom = Number(get('from')) || 0, yTo = Number(get('to')) || 9999;
    const dec = get('decade'); const rating = get('rating'); const prod = get('producer'); const label = get('label');
    const fav = get('fav') === '1', reviewed = get('reviewed') === '1', linked = get('linked');
    const today = new Date().toISOString().slice(0, 10);
    const when = get('when') || 'released';
    const thisYear = new Date().getFullYear();
    const isUpcoming = (r: typeof data.releases[0]) => (r.date ? r.date > today : !!r.year && r.year > thisYear);
    const out = data.releases.filter((r) => {
      if (q && !norm(`${r.title} ${r.artist_credit ?? ''} ${r.label ?? ''}`).includes(q)) return false;
      if (types.length && !types.includes(r.type)) return false;
      const y = r.year ?? 0;
      if (y < yFrom || y > yTo) return false;
      if (dec && Math.floor(y / 10) * 10 !== Number(dec)) return false;
      const a = ix.ann.get(`release:${r.id}`);
      if (!ratingMatches(rating, a?.rating)) return false;
      if (label && !ix.releaseLabelsByRelease.get(r.id)?.some((x) => x.label_id === label)) return false;
      if (fav && !a?.favorite) return false;
      if (reviewed && !a?.review && !a?.notes) return false;
      if (prod && !producersByRelease.get(r.id)?.has(prod)) return false;
      if (linked === 'no' && (r.links.apple || r.artwork_url)) return false;
      if (linked === 'yes' && !r.links.apple) return false;
      if (when === 'upcoming' && !isUpcoming(r)) return false;
      if (when === 'released' && isUpcoming(r)) return false;
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
      type: (a, b) => a.type.localeCompare(b.type) || (b.date ?? `${b.year ?? 0}`).localeCompare(a.date ?? `${a.year ?? 0}`),
    };
    out.sort(cmp[sort] ?? cmp['date-desc']);
    if (!rev) return out;
    const has = (r: typeof out[0]) => (sort === 'rating' ? rv(r.id) > 0 : sort.startsWith('date') ? !!(r.date || r.year) : true);
    return [...out.filter(has).reverse(), ...out.filter((r) => !has(r))];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.releases, ix, sp, producersByRelease]);

  const active = [...sp.keys()].filter((k) => !['view', 'sort', 'when'].includes(k)).length;

  return (
    <div>
      <div className="row" style={{ marginBottom: 20 }}>
        <h1 className="h-page">Library</h1><span className="spacer" />
        <button className="btn" onClick={() => setAdding(true)}>Add a release by hand</button>
      </div>
      <div>
        <section>
          <div className="row" style={{ marginBottom: 16 }}>
            <strong className="num">{rows.length.toLocaleString()}</strong><span className="muted">release{rows.length === 1 ? '' : 's'}</span>
            <div className="seg" role="group" aria-label="Release date">{[['', 'Released'], ['upcoming', 'Upcoming'], ['all', 'All']].map(([v, t]) => <button key={t} className={get('when') === v ? 'on' : ''} onClick={() => set('when', v || null)}>{t}</button>)}</div>
            <span className="spacer" />
            <SortSelect value={sort} onChange={(v) => { const n = new URLSearchParams(sp); if (v === 'date-desc') n.delete('sort'); else n.set('sort', v); n.delete('rev'); setSp(n, { replace: true }); }} rev={rev} onRev={(r) => set('rev', r ? '1' : null)}
              options={[['date-desc', 'Release date'], ['rating', 'Your rating'], ['artist', 'Artist A–Z'], ['title', 'Title A–Z'], ['added', 'Recently added']]} />
            <div className="seg" role="group" aria-label="View">
              <button className={view === 'grid' ? 'on' : ''} onClick={() => set('view', null)}>Covers</button>
              <button className={view === 'table' ? 'on' : ''} onClick={() => set('view', 'table')}>Table</button></div>
          </div>
          <div className="filter-bar panel" aria-label="Filters">
            <label><span className="label">Title, artist or label</span><input className="input" style={{ width: '100%' }} value={get('q')} onChange={(e) => set('q', e.target.value)} placeholder="Filter…" /></label>
            <div><span className="label">Type</span>
              <MultiSelect label="Types" options={presentTypes} value={types} counts={typeCounts} onChange={(v) => set('type', v.join(',') || null)} /></div>
            <label><span className="label">Decade</span><select className="select" style={{ width: '100%' }} value={get('decade')} onChange={(e) => set('decade', e.target.value)}>
              <option value="">Any</option>{decades.map((d) => <option key={d} value={d}>{d}s</option>)}</select></label>
            <div><span className="label">Years</span><div className="row" style={{ flexWrap: 'nowrap' }}>
              <input className="input num" style={{ width: '100%' }} inputMode="numeric" placeholder="From" value={get('from')} onChange={(e) => set('from', e.target.value)} />
              <input className="input num" style={{ width: '100%' }} inputMode="numeric" placeholder="To" value={get('to')} onChange={(e) => set('to', e.target.value)} /></div></div>
            <label className="full-select"><span className="label">Your rating</span><RatingSelect value={get('rating')} onChange={(v) => set('rating', v)} /></label>
            <label><span className="label">Producer</span><select className="select" style={{ width: '100%' }} value={get('producer')} onChange={(e) => set('producer', e.target.value)}>
              <option value="">Any</option>{producers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
            {labels.length > 0 && <label><span className="label">Label</span><select className="select" style={{ width: '100%' }} value={get('label')} onChange={(e) => set('label', e.target.value)}>
              <option value="">Any</option>{labels.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></label>}
            <label><span className="label">Links</span><select className="select" style={{ width: '100%' }} value={get('linked')} onChange={(e) => set('linked', e.target.value)}>
              <option value="">Any</option><option value="yes">Linked to Apple Music</option><option value="no">Not linked yet</option></select></label>
            <div className="fb-checks"><label className="row"><input type="checkbox" checked={get('fav') === '1'} onChange={(e) => set('fav', e.target.checked ? '1' : null)} /> Favourites only</label>
            <label className="row"><input type="checkbox" checked={get('reviewed') === '1'} onChange={(e) => set('reviewed', e.target.checked ? '1' : null)} /> Has a review or notes</label></div>
            {active > 0 && <button className="btn" onClick={() => setSp(new URLSearchParams(Object.fromEntries([...sp].filter(([k]) => k === 'view' || k === 'sort' || k === 'when'))), { replace: true })}>Clear filters</button>}
          </div>
          {!rows.length ? <div className="empty">Nothing matches these filters.</div> : view === 'grid' ? (
            <div className="grid">{rows.slice(0, shown).map((r) => <ReleaseTile key={r.id} r={r} />)}</div>
          ) : (
            <div className="table-wrap"><table className="table">
              <thead><tr><th className="thumb" /><th style={{ cursor: 'pointer' }} onClick={() => sortBy('title')}>Title{arrow('title', true)}</th><th style={{ cursor: 'pointer' }} onClick={() => sortBy('artist')}>Artist{arrow('artist', true)}</th><th style={{ cursor: 'pointer' }} onClick={() => sortBy('type')}>Type{arrow('type', true)}</th><th style={{ cursor: 'pointer' }} onClick={() => sortBy('date-desc')}>Date{arrow('date-desc', false)}</th><th style={{ cursor: 'pointer' }} onClick={() => sortBy('rating')}>Rating{arrow('rating', false)}</th></tr></thead>
              <tbody>{rows.slice(0, shown).map((r) => (
                <tr key={r.id}><td><EditCell kind="action" label="Cover" onEdit={() => setCoverFor(r)}><Link to={`/release/${r.id}`}><Cover src={r.artwork_url} title={r.title} size={36} /></Link></EditCell></td>
                  <td><EditCell kind="text" label="Title" value={r.title} onSave={(v) => E.renameRelease(r, v)}><Link to={`/release/${r.id}`} style={{ fontWeight: 600 }}>{r.title}</Link></EditCell></td>
                  <td><EditCell kind="text" label="Artist" value={r.artist_credit ?? ''} onSave={(v) => E.setReleaseArtist(r, v)}><Credits release={r} /></EditCell></td>
                  <td className="muted"><EditCell kind="type" label="Type" value={r.type} onSave={(v) => E.setReleaseType(r, v)}>{r.type}</EditCell></td>
                  <td className="num muted" style={{ whiteSpace: 'nowrap' }}><EditCell kind="text" label="Release date" placeholder="27 Nov 2017, 2017-11-27 or 2017" value={r.date ?? (r.year ? String(r.year) : '')} onSave={(v) => E.setReleaseWhen(r, v)}>{r.date ? fmtDate(r.date) : r.year ?? '\u00a0'}</EditCell></td>
                  <td><QuickRate type="release" id={r.id} /></td></tr>))}</tbody>
            </table></div>
          )}
          {rows.length > shown && <div style={{ textAlign: 'center', marginTop: 24 }}><button className="btn" onClick={() => setShown((s) => s + PAGE * 2)}>Show more ({(rows.length - shown).toLocaleString()} left)</button></div>}
        </section>
      </div>
      {adding && <ReleaseForm onClose={() => setAdding(false)} />}
      {coverFor && <ImagePicker title={`Cover for ${coverFor.title}`} onClose={() => setCoverFor(null)} resetLabel={coverFor.artwork_url ? 'Remove cover' : undefined}
        onSet={async (u) => { await E.setReleaseCover(coverFor, u); say(u ? 'Cover updated' : 'Cover removed'); }} />}
    </div>
  );
}
