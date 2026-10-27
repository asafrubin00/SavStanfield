import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { SortSelect, usePref } from '../components/controls';
import { ArtistTile, Cover, fmtDate } from '../components/ui';
import type { Artist, Release } from '../lib/types';
import { linkQueue } from '../lib/queue';
import { usePageState } from '../lib/nav';
import { norm, shownInArtists, useStore } from '../lib/store';
import { ArtistForm } from './ArtistPage';

export const PEOPLE_SORTS: [string, string][] = [
  ['recent', 'Most recent release'], ['az', 'A–Z'], ['za', 'Z–A'], ['avg', 'Your average for their releases'], ['count', 'Most releases'],
];

export default function Artists({ producers }: { producers: boolean }) {
  const { data, ix, say, upsert } = useStore();
  const [sp, setSp] = useSearchParams();
  const q = sp.get('q') ?? '';
  const sort = sp.get('sort') ?? 'recent';
  const favOnly = sp.get('fav') === '1';
  const who = sp.get('who') ?? 'shown';
  const rev = sp.get('rev') === '1';
  /** Sort by a column; clicking the column you're already sorted by flips the direction. */
  const sortBy = (k: string) => { const n = new URLSearchParams(sp); if ((sp.get('sort') ?? 'recent') === k) { if (rev) n.delete('rev'); else n.set('rev', '1'); } else { if (k === 'recent') n.delete('sort'); else n.set('sort', k); n.delete('rev'); } setSp(n, { replace: true }); };
  const set = (k: string, v: string | null) => { const n = new URLSearchParams(sp); if (v) n.set(k, v); else n.delete(k); setSp(n, { replace: true }); setShown(150); };
  const [shown, setShown] = usePageState('shown', 150);
  const [adding, setAdding] = useState(false);
  const [showCounts, setShowCounts] = usePref('artists.showCounts', false);
  const [view, setView] = usePref('artists.view', 'grid');

  const rows = useMemo(() => {
    const n = norm(q); const today = new Date().toISOString().slice(0, 10);
    const last = producers ? ix.lastProducedByArtist : ix.lastByArtist;
    const out = data.artists
      .filter((a) => (!producers || a.is_producer) && (!n || norm([a.name, ...a.aliases].join(' ')).includes(n)))
      .filter((a) => producers || who === 'all' || shownInArtists(ix, a) === (who === 'shown'))
      .filter((a) => { const an = ix.ann.get(`artist:${a.id}`); return !favOnly || an?.favorite; })
      .map((a) => {
        const cr = ix.creditsByArtist.get(a.id) ?? [];
        const count = producers
          ? new Set(cr.filter((c) => c.role === 'producer' || c.role === 'exec_producer').map((c) => c.release_id ?? ix.tracks.get(c.track_id!)?.release_id)).size
          : cr.filter((c) => c.role === 'primary' && c.release_id).length;
        const ratings = cr.filter((c) => c.role === 'primary' && c.release_id).map((c) => ix.ann.get(`release:${c.release_id}`)?.rating).filter(Boolean) as number[];
        const day = (r?: Release) => r?.date ?? (r?.year ? String(r.year) : '');
        let lastRel: Release | undefined;
        for (const c of cr) {
          if (producers ? c.role !== 'producer' && c.role !== 'exec_producer' : c.role !== 'primary') continue;
          const rid = c.release_id ?? (c.track_id ? ix.tracks.get(c.track_id)?.release_id : undefined);
          const r = rid ? ix.releases.get(rid) : undefined;
          if (r && day(r) <= today && day(r) > day(lastRel)) lastRel = r;
        }
        return { a, count, lastRel, rated: ratings.length, last: last.get(a.id) ?? '', avg: ratings.length ? ratings.reduce((s, x) => s + x, 0) / ratings.length : 0 };
      })
      .sort((x, y) => {
        const az = x.a.name.localeCompare(y.a.name, undefined, { sensitivity: 'base' });
        switch (sort) {
          case 'az': return az;
          case 'za': return -az;
          case 'avg': return y.avg - x.avg || az;
          case 'count': return y.count - x.count || az;
          default: return y.last.localeCompare(x.last) || az; // most recent release, ties A–Z
        }
      })
;
    if (!rev) return out;
    // Flipped: reverse the ones that have a value, keep blanks (no releases, unrated) at the end
    const has = (r: typeof out[0]) => (sort === 'avg' ? r.avg > 0 : sort === 'count' ? r.count > 0 : sort === 'az' || sort === 'za' ? true : !!r.last);
    return [...out.filter(has).reverse(), ...out.filter((r) => !has(r))];
  }, [data.artists, ix, q, sort, favOnly, producers, who, rev]);
  const setShow = (a: Artist, v: string) => upsert('artists', [{ ...a, ext: { ...a.ext, show_in_artists: v || undefined }, updated_at: new Date().toISOString() }]);

  const sub = (r: typeof rows[0]) => [
    sort === 'recent' && r.last ? `Latest ${fmtDate(r.last)}` : '',
    showCounts ? `${r.count} ${producers ? 'produced' : r.count === 1 ? 'release' : 'releases'}` : '',
    (sort === 'avg' || showCounts) && r.avg ? `${r.avg.toFixed(1)}★ avg` : '',
  ].filter(Boolean).join(' · ');

  const noPhoto = rows.filter((r) => !r.a.image_url && !r.a.ext.linked_at).map((r) => r.a.id);
  return (
    <div>
      <div className="row" style={{ marginBottom: 20 }}>
        <h1 className="h-page">{producers ? 'Producers' : 'Artists'}</h1><span className="spacer" />
        {noPhoto.length > 0 && <button className="btn" onClick={() => { linkQueue.add('artist', noPhoto); say(`Looking up ${noPhoto.length} ${producers ? 'producers' : 'artists'} in the background`); }}>Get photos &amp; links for {noPhoto.length}</button>}
        {!producers && <Link className="btn" to="/artists/tidy">Tidy duplicates</Link>}
        <button className="btn" onClick={() => setAdding(true)}>Add an artist</button>
      </div>
      <div className="row" style={{ marginBottom: 20 }}>
        <input className="input" style={{ width: 240 }} placeholder={`Filter ${producers ? 'producers' : 'artists'}`} value={q} onChange={(e) => set('q', e.target.value)} />
        <SortSelect value={sort} options={PEOPLE_SORTS} onChange={(v) => { const n = new URLSearchParams(sp); if (v === 'recent') n.delete('sort'); else n.set('sort', v); n.delete('rev'); setSp(n, { replace: true }); }} rev={rev} onRev={(r) => set('rev', r ? '1' : null)} />
        <label className="row"><input type="checkbox" checked={favOnly} onChange={(e) => set('fav', e.target.checked ? '1' : null)} /> Favourites</label>
        {!producers && <select className="select" value={who} onChange={(e) => set('who', e.target.value === 'shown' ? null : e.target.value)} aria-label="Which artists" title="Hidden: people with no release of their own in your library (mostly producers), unless you've set them to Always">
          <option value="shown">Shown artists</option><option value="hidden">Hidden (producers etc.)</option><option value="all">Everyone</option></select>}
        {view !== 'table' && <label className="row"><input type="checkbox" checked={showCounts} onChange={(e) => setShowCounts(e.target.checked)} /> Show counts</label>}
        <span className="spacer" /><span className="muted num">{rows.length.toLocaleString()}</span>
        <div className="seg" role="group" aria-label="View"><button className={view !== 'table' ? 'on' : ''} onClick={() => setView('grid')}>Grid</button><button className={view === 'table' ? 'on' : ''} onClick={() => setView('table')}>Table</button></div>
      </div>
      {!rows.length ? <div className="empty">{producers ? 'No producers match. Producers show up when you import your sheet, fill in an executive producer, or get credits from Genius on a release.' : 'No artists match.'}</div> : (
        view === 'table' ? (
          <div className="table-wrap"><table className="table">
            <thead><tr><th className="thumb" />
              <th onClick={() => sortBy('az')} style={{ cursor: 'pointer' }}>Name{sort === 'az' ? (rev ? ' ↓' : ' ↑') : sort === 'za' ? ' ↓' : ''}</th>
              <th onClick={() => sortBy('recent')} style={{ cursor: 'pointer' }}>{producers ? 'Latest produced' : 'Latest release'}{sort === 'recent' ? (rev ? ' ↑' : ' ↓') : ''}</th>
              <th onClick={() => sortBy('count')} style={{ cursor: 'pointer', textAlign: 'right' }}>{producers ? 'Produced' : 'Releases'}{sort === 'count' ? (rev ? ' ↑' : ' ↓') : ''}</th>
              <th onClick={() => sortBy('avg')} style={{ cursor: 'pointer' }}>Your average{sort === 'avg' ? (rev ? ' ↑' : ' ↓') : ''}</th>
              {!producers && <th title="Auto: shown if they have a release of their own in your library">Show in Artists</th>}</tr></thead>
            <tbody>{rows.slice(0, shown).map((r) => (
              <tr key={r.a.id}>
                <td><Link to={`/artist/${r.a.id}`}><Cover src={r.a.image_url} title={r.a.name} size={36} round /></Link></td>
                <td><Link to={`/artist/${r.a.id}`} style={{ fontWeight: 600 }}>{r.a.name}</Link></td>
                <td className="small">{r.lastRel ? <><span className="num muted">{r.lastRel.date ? fmtDate(r.lastRel.date) : r.lastRel.year}</span> · <Link to={`/release/${r.lastRel.id}`}>{r.lastRel.title}</Link></> : <span className="muted">—</span>}</td>
                <td className="num" style={{ textAlign: 'right' }}>{r.count || ''}</td>
                <td className="num small">{r.avg ? <>{r.avg.toFixed(1)} ★ <span className="muted">({r.rated})</span></> : <span className="muted">—</span>}</td>
                {!producers && <td><select className="select" style={{ padding: '3px 6px' }} value={(r.a.ext.show_in_artists as string) ?? ''} onChange={(e) => void setShow(r.a, e.target.value)} aria-label={`Show ${r.a.name} in Artists`}>
                  <option value="">Auto ({(ix.creditsByArtist.get(r.a.id) ?? []).some((c) => c.role === 'primary' && c.release_id) ? 'shown' : 'hidden'})</option><option value="always">Always</option><option value="never">Never</option></select></td>}
              </tr>))}</tbody>
          </table></div>
        ) : <div className="grid tight">{rows.slice(0, shown).map((r) => <ArtistTile key={r.a.id} a={r.a} sub={sub(r)} />)}</div>
      )}
      {rows.length > shown && <div style={{ textAlign: 'center', marginTop: 24 }}><button className="btn" onClick={() => setShown((s) => s + 300)}>Show more</button></div>}
      {adding && <ArtistForm onClose={() => setAdding(false)} />}
    </div>
  );
}
