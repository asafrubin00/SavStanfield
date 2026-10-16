import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { ArtistTile, Cover, fmtDate, ReleaseTile } from '../components/ui';
import { useStore } from '../lib/store';

export default function Home() {
  const { data, ix } = useStore();
  const today = new Date().toISOString().slice(0, 10);
  const upcoming = useMemo(() => data.releases.filter((r) => r.date && r.date > today).sort((a, b) => a.date!.localeCompare(b.date!)), [data.releases, today]);
  const recent = useMemo(() => data.releases.filter((r) => r.date && r.date <= today).sort((a, b) => b.date!.localeCompare(a.date!)).slice(0, 12), [data.releases, today]);
  const notes = useMemo(() => [...data.annotations].filter((a) => a.review || a.notes).sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? '')).slice(0, 6), [data.annotations]);
  const favArtists = useMemo(() => data.annotations.filter((a) => a.entity_type === 'artist' && a.favorite).map((a) => ix.artists.get(a.entity_id)).filter(Boolean).slice(0, 12), [data.annotations, ix]);

  if (!data.releases.length) return (
    <div style={{ maxWidth: 640 }}>
      <h1 className="hero-name" style={{ fontSize: 'clamp(48px, 8vw, 96px)' }}>Your music,<br />one place.</h1>
      <p style={{ fontSize: 18, marginTop: 20 }}>Start by importing your tracker spreadsheet — albums, mixtapes, leaks, concerts and lists all come across. Or search for something and add it.</p>
      <div className="row" style={{ marginTop: 20 }}><Link className="btn primary" to="/settings">Import your spreadsheet</Link><Link className="btn" to="/find">Find music</Link></div>
    </div>
  );

  return (
    <div>
      {upcoming.length > 0 && <section>
        <h2 className="h-sec" style={{ marginTop: 0 }}>Coming up <span className="muted">{upcoming.length}</span></h2>
        <div style={{ display: 'grid', gridAutoFlow: 'column', gridAutoColumns: 'minmax(220px, 1fr)', gap: 12, overflowX: 'auto', paddingBottom: 6 }}>
          {upcoming.slice(0, 16).map((r) => (
            <Link key={r.id} to={`/release/${r.id}`} className="panel" style={{ display: 'grid', gridTemplateColumns: '56px 1fr', gap: 12, alignItems: 'center', textDecoration: 'none', padding: 10 }}>
              <Cover src={r.artwork_url} title={r.title} size={56} />
              <span style={{ minWidth: 0 }}><div className="num" style={{ fontWeight: 800, fontVariationSettings: "'wdth' 75", fontSize: 18 }}>{fmtDate(r.date)}</div>
                <div style={{ fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.title}</div><div className="small muted" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.artist_credit} · {r.type}</div></span>
            </Link>))}
        </div>
      </section>}

      <h2 className="h-sec">Latest releases you track <Link className="small muted" to="/library?when=released">See all</Link></h2>
      <div className="grid tight">{recent.map((r) => <ReleaseTile key={r.id} r={r} />)}</div>

      {favArtists.length > 0 && <><h2 className="h-sec">Favourite artists</h2><div className="grid tight">{favArtists.map((a) => <ArtistTile key={a!.id} a={a!} />)}</div></>}

      {notes.length > 0 && <><h2 className="h-sec">Recent reviews &amp; notes</h2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 14 }}>{notes.map((n) => {
          const r = n.entity_type === 'release' ? ix.releases.get(n.entity_id) : undefined;
          const a = n.entity_type === 'artist' ? ix.artists.get(n.entity_id) : undefined;
          const t = n.entity_type === 'track' ? ix.tracks.get(n.entity_id) : undefined;
          const to = r ? `/release/${r.id}` : a ? `/artist/${a.id}` : t ? `/track/${t.id}` : '#';
          return <Link key={n.id} to={to} className="panel" style={{ textDecoration: 'none' }}>
            <strong>{r?.title ?? a?.name ?? t?.title}</strong>{r && <span className="muted"> · {r.artist_credit}</span>}
            <p style={{ margin: '6px 0 0', display: '-webkit-box', WebkitLineClamp: 4, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{n.review || n.notes}</p></Link>;
        })}</div></>}
    </div>
  );
}
