import { useMemo, useState } from 'react';
import { ArtistTile } from '../components/ui';
import { linkQueue } from '../lib/queue';
import { norm, useStore } from '../lib/store';
import { ArtistForm } from './ArtistPage';

export default function Artists({ producers }: { producers: boolean }) {
  const { data, ix, say } = useStore();
  const [q, setQ] = useState('');
  const [sort, setSort] = useState('count');
  const [favOnly, setFavOnly] = useState(false);
  const [shown, setShown] = useState(150);
  const [adding, setAdding] = useState(false);

  const rows = useMemo(() => {
    const n = norm(q);
    return data.artists.filter((a) => (!producers || a.is_producer) && (!n || norm([a.name, ...a.aliases].join(' ')).includes(n)) && (!favOnly || ix.ann.get(`artist:${a.id}`)?.favorite))
      .map((a) => {
        const cr = ix.creditsByArtist.get(a.id) ?? [];
        const count = producers
          ? new Set(cr.filter((c) => c.role === 'producer' || c.role === 'exec_producer').map((c) => c.release_id ?? ix.tracks.get(c.track_id!)?.release_id)).size
          : cr.filter((c) => c.role === 'primary' && c.release_id).length;
        const ratings = cr.filter((c) => c.role === 'primary' && c.release_id).map((c) => ix.ann.get(`release:${c.release_id}`)?.rating).filter(Boolean) as number[];
        return { a, count, avg: ratings.length ? ratings.reduce((s, x) => s + x, 0) / ratings.length : 0 };
      })
      .sort((x, y) => sort === 'name' ? x.a.name.localeCompare(y.a.name) : sort === 'avg' ? y.avg - x.avg || y.count - x.count : y.count - x.count || x.a.name.localeCompare(y.a.name));
  }, [data.artists, ix, q, sort, favOnly, producers]);

  const noPhoto = rows.filter((r) => !r.a.image_url && !r.a.ext.linked_at).map((r) => r.a.id);
  return (
    <div>
      <div className="row" style={{ marginBottom: 20 }}>
        <h1 className="h-page">{producers ? 'Producers' : 'Artists'}</h1><span className="spacer" />
        {noPhoto.length > 0 && <button className="btn" onClick={() => { linkQueue.add('artist', noPhoto); say(`Looking up ${noPhoto.length} ${producers ? 'producers' : 'artists'} in the background`); }}>Get photos &amp; links for {noPhoto.length}</button>}
        <button className="btn" onClick={() => setAdding(true)}>Add an artist</button>
      </div>
      <div className="row" style={{ marginBottom: 20 }}>
        <input className="input" style={{ width: 260 }} placeholder={`Filter ${producers ? 'producers' : 'artists'}`} value={q} onChange={(e) => { setQ(e.target.value); setShown(150); }} />
        <select className="select" value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Sort">
          <option value="count">Most {producers ? 'produced' : 'releases'}</option><option value="avg">Highest your average</option><option value="name">A–Z</option></select>
        <label className="row"><input type="checkbox" checked={favOnly} onChange={(e) => setFavOnly(e.target.checked)} /> Favourites</label>
        <span className="spacer" /><span className="muted num">{rows.length.toLocaleString()}</span>
      </div>
      {!rows.length ? <div className="empty">{producers ? 'No producers yet. Producers show up when you import your sheet, fill in an executive producer, or fetch credits from Genius on a release.' : 'No artists match.'}</div> : (
        <div className="grid tight">{rows.slice(0, shown).map(({ a, count, avg }) => <ArtistTile key={a.id} a={a} sub={`${count} ${producers ? 'produced' : count === 1 ? 'release' : 'releases'}${avg ? ` · ${avg.toFixed(1)}★` : ''}`} />)}</div>
      )}
      {rows.length > shown && <div style={{ textAlign: 'center', marginTop: 24 }}><button className="btn" onClick={() => setShown((s) => s + 300)}>Show more</button></div>}
      {adding && <ArtistForm onClose={() => setAdding(false)} />}
    </div>
  );
}
