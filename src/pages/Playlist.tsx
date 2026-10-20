import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { SortSelect, usePref } from '../components/controls';
import { CoverGrid, CoverPicker, groupForCovers, ListCover } from '../components/ListBits';
import { Cover, fmtMs, QuickRate } from '../components/ui';
import { adapter } from '../lib/db';
import { player, trackEmbed, usePlayer } from '../lib/player';
import { norm, useStore } from '../lib/store';
import type { List, ListItem, Release, Track } from '../lib/types';
import { now } from '../lib/util';

const totalTime = (ms: number) => { const m = Math.round(ms / 60000); return m >= 60 ? `${Math.floor(m / 60)} hr ${m % 60} min` : `${m} min`; };

function download(name: string, text: string, type: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
const csvCell = (v: unknown) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

export default function PlaylistView({ list: l }: { list: List }) {
  const st = useStore();
  const { ix, data, upsert, remove, searchTracks, loadReleaseTracks, addTracksToList } = st;
  const nav = useNavigate();
  const ps = usePlayer();
  const items = useMemo(() => [...(ix.itemsByList.get(l.id) ?? [])].filter((i) => i.entity_type === 'track').sort((a, b) => a.position - b.position), [ix, l.id]);
  useEffect(() => { void st.loadTracks(items.map((i) => i.entity_id!).filter(Boolean)); }, [items.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const [sort, setSort] = useState('order');
  const [view, setView] = usePref(`list.view.${l.id}`, 'songs');
  const [picking, setPicking] = useState(false);
  const [q, setQ] = useState('');
  const [found, setFound] = useState<Track[]>([]);
  useEffect(() => {
    if (q.trim().length < 2) { setFound([]); return; }
    const t = window.setTimeout(() => { void searchTracks(q.trim(), 15).then(setFound).catch(() => setFound([])); }, 250);
    return () => window.clearTimeout(t);
  }, [q, searchTracks]);
  const albumHits = useMemo(() => { const n = norm(q); return n.length < 2 ? [] : data.releases.filter((r) => norm(`${r.artist_credit} ${r.title}`).includes(n)).slice(0, 5); }, [q, data.releases]);

  type Row = { it: ListItem; t?: Track; r?: Release; i: number };
  const rows: Row[] = items.map((it, i) => { const t = ix.tracks.get(it.entity_id!); return { it, t, r: t?.release_id ? ix.releases.get(t.release_id) : undefined, i }; });
  const artistOf = (x: Row) => x.t?.artist_credit ?? x.r?.artist_credit ?? '';
  const cmp: Record<string, (a: Row, b: Row) => number> = {
    title: (a, b) => (a.t?.title ?? '').localeCompare(b.t?.title ?? ''), artist: (a, b) => artistOf(a).localeCompare(artistOf(b)),
    album: (a, b) => (a.r?.title ?? '').localeCompare(b.r?.title ?? ''), length: (a, b) => (a.t?.duration_ms ?? 0) - (b.t?.duration_ms ?? 0),
    rating: (a, b) => (ix.ann.get(`track:${b.t?.id}`)?.rating ?? 0) - (ix.ann.get(`track:${a.t?.id}`)?.rating ?? 0),
    newest: (a, b) => (b.r?.date ?? `${b.r?.year ?? ''}`).localeCompare(a.r?.date ?? `${a.r?.year ?? ''}`),
  };
  const shown = sort === 'order' ? rows : [...rows].sort(cmp[sort]);
  const ids = shown.map((x) => x.t?.id).filter(Boolean) as string[];
  const total = rows.reduce((s, x) => s + (x.t?.duration_ms ?? 0), 0);
  const playing = ps.ids.length ? ps.ids[ps.index] : null;

  const renumber = (arr: ListItem[]) => upsert('list_items', arr.map((it, i) => ({ ...it, position: i + 1 })));
  const move = (i: number, d: number) => { const a = [...items]; const j = i + d; if (j < 0 || j >= a.length) return; [a[i], a[j]] = [a[j], a[i]]; void renumber(a); };

  function exportCsv() {
    const head = ['#', 'Title', 'Artist', 'Album', 'Year', 'Length', 'Apple Music', 'Deezer'];
    const lines = rows.map((x, n) => [n + 1, x.t?.title, artistOf(x), x.r?.title, x.r?.year, fmtMs(x.t?.duration_ms), x.t?.links.apple ?? '', x.t?.links.deezer ?? ''].map(csvCell).join(','));
    download(`${l.name}.csv`, [head.join(','), ...lines].join('\n'), 'text/csv');
  }
  function exportTxt() { download(`${l.name}.txt`, rows.filter((x) => x.t).map((x) => `${artistOf(x)} - ${x.t!.title}`).join('\n'), 'text/plain'); }

  return (
    <div>
      <div className="hero" style={{ gridTemplateColumns: 'minmax(140px, 220px) 1fr', alignItems: 'end' }}>
        <ListCover list={l} items={items} onClick={() => setPicking(true)} />
        <div>
          <div className="muted" style={{ marginBottom: 6 }}>Playlist</div>
          <input className="hero-title" style={{ border: 0, background: 'transparent', width: '100%', padding: 0, color: 'inherit' }} value={l.name} aria-label="Playlist name" onChange={(e) => upsert('lists', [{ ...l, name: e.target.value, updated_at: now() }])} />
          <input className="input" style={{ width: '100%', marginTop: 8, background: 'transparent' }} placeholder="Add a description" value={l.description ?? ''} onChange={(e) => upsert('lists', [{ ...l, description: e.target.value }])} />
          <div className="hero-meta">{rows.length} song{rows.length === 1 ? '' : 's'}{total > 0 && <span>{totalTime(total)}</span>}</div>
        </div>
      </div>
      <div className="row" style={{ margin: '18px 0' }}>
        <button className="btn primary" disabled={!ids.length} onClick={() => player.play(ids, 0, l.name)}>Play</button>
        <button className="btn" disabled={!ids.length} onClick={() => player.shuffle(ids, l.name)}>Shuffle</button>
        <div className="seg" role="group" aria-label="View"><button className={view !== 'albums' ? 'on' : ''} onClick={() => setView('songs')}>Songs</button><button className={view === 'albums' ? 'on' : ''} onClick={() => setView('albums')}>Albums</button></div>
        <SortSelect value={sort} onChange={setSort} options={[['order', 'Playlist order'], ['title', 'Title'], ['artist', 'Artist'], ['album', 'Album'], ['length', 'Length'], ['rating', 'Your rating'], ['newest', 'Newest release']]} />
        <span className="spacer" />
        <button className="btn" disabled={!rows.length} onClick={exportCsv} title="Spreadsheet with Apple Music links">Export CSV</button>
        <button className="btn" disabled={!rows.length} onClick={exportTxt} title="“Artist - Title” lines — paste into TuneMyMusic or Soundiiz to recreate it in Apple Music">Export text</button>
        <button className="btn danger" onClick={async () => { if (confirm(`Delete the playlist “${l.name}”? The songs stay in your library.`)) { await remove('list_items', (ix.itemsByList.get(l.id) ?? []).map((i) => i.id)); await remove('lists', [l.id]); nav('/lists'); } }}>Delete</button>
      </div>

      <div className="search" style={{ maxWidth: 620, marginBottom: 18 }}>
        <input className="input" placeholder="Add songs — search any song or album in your library" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Add songs" />
        {q.trim().length >= 2 && (
          <div className="dropdown">
            {found.length > 0 && <div className="dd-group">Songs</div>}
            {found.map((t) => { const r = t.release_id ? ix.releases.get(t.release_id) : undefined; return (
              <button key={t.id} className="dd-item btn ghost" style={{ width: '100%', justifyContent: 'flex-start', textAlign: 'left' }} onClick={() => addTracksToList(l.id, [t.id])}>
                <Cover src={r?.artwork_url} title={t.title} size={32} /><span style={{ minWidth: 0 }}><strong>{t.title}</strong><div className="small muted">{t.artist_credit ?? r?.artist_credit} · {r?.title}</div></span>
              </button>); })}
            {albumHits.length > 0 && <div className="dd-group">Add a whole album</div>}
            {albumHits.map((r) => (
              <button key={r.id} className="dd-item btn ghost" style={{ width: '100%', justifyContent: 'flex-start', textAlign: 'left' }} onClick={async () => {
                await loadReleaseTracks([r.id]);
                const list = await adapter.tracksForReleases([r.id]);
                if (!list.length) { st.say('No tracklist for that album yet — open it and click “Get tracklist”'); return; }
                await addTracksToList(l.id, list.sort((a, b) => (a.disc ?? 1) - (b.disc ?? 1) || (a.number ?? 0) - (b.number ?? 0)).map((t) => t.id));
              }}>
                <Cover src={r.artwork_url} title={r.title} size={32} /><span><strong>{r.title}</strong><div className="small muted">{r.artist_credit} · {r.year}</div></span>
              </button>))}
            {!found.length && !albumHits.length && <div className="small muted" style={{ padding: 8 }}>Nothing found. Songs appear once their album has a tracklist.</div>}
          </div>
        )}
      </div>

      {picking && <CoverPicker list={l} items={items} onClose={() => setPicking(false)} />}
      {!rows.length ? <div className="empty">No songs yet. Search above, or use “+ Playlist” on any album’s tracklist.</div> : view === 'albums' ? (
        <CoverGrid groups={groupForCovers(ix, shown.map((x) => x.it))} label={l.name} />
      ) : (
        <div className="table-wrap"><table className="table">
          <thead><tr><th style={{ width: 36 }}>#</th><th className="thumb" /><th>Title</th><th>Album</th><th style={{ textAlign: 'right' }}>Length</th><th /><th /></tr></thead>
          <tbody>{shown.map((x) => {
            const isPlaying = x.t && x.t.id === playing;
            return (
              <tr key={x.it.id} style={isPlaying ? { background: 'color-mix(in srgb, var(--accent) 12%, transparent)' } : undefined}>
                <td className="num muted">
                  <button className="btn sm ghost" style={{ padding: '2px 6px' }} aria-label={`Play ${x.t?.title ?? ''}`} disabled={!x.t} onClick={() => player.play(ids, ids.indexOf(x.t!.id), l.name)}>{isPlaying ? '♪' : x.i + 1}</button>
                </td>
                <td><Cover src={x.r?.artwork_url} title={x.t?.title ?? '?'} size={32} /></td>
                <td style={{ minWidth: 180 }}>{x.t ? <><Link to={`/track/${x.t.id}`} style={{ fontWeight: 600 }}>{x.t.title}</Link><div className="small muted">{artistOf(x)}{x.t && !trackEmbed(x.t) ? ' · no player link' : ''}</div></> : <span className="muted">Loading…</span>}</td>
                <td className="small">{x.r && <Link to={`/release/${x.r.id}`}>{x.r.title}</Link>}</td>
                <td className="num muted" style={{ textAlign: 'right' }}>{fmtMs(x.t?.duration_ms)}</td>
                <td>{x.t && <QuickRate type="track" id={x.t.id} />}</td>
                <td style={{ whiteSpace: 'nowrap', textAlign: 'right' }}>
                  {sort === 'order' && <><button className="btn sm ghost" aria-label="Move up" disabled={x.i === 0} onClick={() => move(x.i, -1)}>↑</button><button className="btn sm ghost" aria-label="Move down" disabled={x.i === items.length - 1} onClick={() => move(x.i, 1)}>↓</button></>}
                  <button className="btn sm ghost" aria-label="Remove" onClick={() => remove('list_items', [x.it.id])}>✕</button>
                </td>
              </tr>);
          })}</tbody>
        </table></div>
      )}
    </div>
  );
}
