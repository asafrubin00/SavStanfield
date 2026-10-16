import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Cover } from '../components/ui';
import { parseArtistCredit } from '../lib/importSheet';
import { linkQueue } from '../lib/queue';
import { appleSearchAlbums, appleSearchArtists, appleSearchSongs, mbSearchGroups, type AppleAlbum, type MBGroup } from '../lib/sources';
import { norm, useStore } from '../lib/store';
import type { Release } from '../lib/types';
import { now, uid } from '../lib/util';
import { ReleaseForm } from './ReleasePage';

export default function Find() {
  const st = useStore();
  const { data, upsert, say } = st;
  const nav = useNavigate();
  const [sp, setSp] = useSearchParams();
  const [q, setQ] = useState(sp.get('q') ?? '');
  const [albums, setAlbums] = useState<AppleAlbum[] | null>(null);
  const [artists, setArtists] = useState<Awaited<ReturnType<typeof appleSearchArtists>> | null>(null);
  const [songs, setSongs] = useState<Awaited<ReturnType<typeof appleSearchSongs>> | null>(null);
  const [mb, setMb] = useState<MBGroup[] | null>(null);
  const [err, setErr] = useState('');
  const [manual, setManual] = useState<Partial<Release> | null>(null);

  async function run(term: string) {
    if (!term.trim()) return;
    setErr(''); setAlbums(null); setArtists(null); setSongs(null); setMb(null);
    const fail = (label: string) => (e: Error) => setErr((x) => `${x}${x ? ' · ' : ''}${label}: ${e.message}`);
    appleSearchArtists(term, 6).then(setArtists).catch(fail('Apple artists'));
    appleSearchAlbums(term, 24).then(setAlbums).catch(fail('Apple albums'));
    mbSearchGroups(term).then(setMb).catch(fail('MusicBrainz'));
    appleSearchSongs(term, 10).then(setSongs).catch(fail('Apple songs'));
  }
  useEffect(() => { const t = sp.get('q'); if (t) { setQ(t); void run(t); } // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const haveAlbum = (title: string, artist: string) => data.releases.find((r) => norm(r.title) === norm(title) && norm(r.artist_credit ?? '').includes(norm(artist).split(' ')[0]));
  const haveArtist = (name: string) => data.artists.find((a) => norm(a.name) === norm(name) || a.aliases.some((x) => norm(x) === norm(name)));

  async function addAlbum(a: AppleAlbum | MBGroup, open: boolean) {
    const isApple = 'url' in a;
    const r: Release = {
      id: uid(), title: a.title, type: isApple ? (a as AppleAlbum).kind : (a as MBGroup).secondary.includes('Mixtape/Street') ? 'Mixtape' : (a as MBGroup).type,
      date: a.date && a.date.length === 10 ? a.date : null, year: a.date ? Number(a.date.slice(0, 4)) : null, artist_credit: a.artist,
      artwork_url: isApple ? (a as AppleAlbum).artwork ?? null : null, source: 'search', created_at: now(), updated_at: now(),
      links: isApple ? { apple: (a as AppleAlbum).url } : { musicbrainz: `https://musicbrainz.org/release-group/${a.id}` },
      ext: isApple ? { apple_id: (a as AppleAlbum).id } : { mbid: (a as MBGroup).id },
    };
    await upsert('releases', [r]);
    const { names, group } = parseArtistCredit(a.artist, /&|,/.test(a.artist) && !haveArtist(a.artist));
    [...(group ? [group] : []), ...names].forEach((n, i) => st.creditArtist(st.ensureArtist(n).artist.id, { release_id: r.id }, 'primary', i));
    linkQueue.add('release', [r.id]);
    say(`Added ${r.title}`);
    if (open) nav(`/release/${r.id}`);
  }
  async function addArtist(name: string, appleId: number, url: string) {
    const ex = haveArtist(name); if (ex) { nav(`/artist/${ex.id}`); return; }
    const a = { id: uid(), name, is_producer: false, aliases: [], links: { apple: url }, ext: { apple_id: appleId }, created_at: now(), updated_at: now() };
    await upsert('artists', [a]); linkQueue.add('artist', [a.id]); nav(`/artist/${a.id}`);
  }

  return (
    <div>
      <div className="row" style={{ marginBottom: 8 }}><h1 className="h-page">Find &amp; add music</h1></div>
      <p className="muted" style={{ marginTop: 0 }}>Searches Apple Music and MusicBrainz. Anything you add gets its links filled in automatically.</p>
      <form className="row" style={{ margin: '16px 0 8px' }} onSubmit={(e) => { e.preventDefault(); setSp({ q }, { replace: true }); void run(q); }}>
        <input className="input" style={{ flex: 1, maxWidth: 560 }} autoFocus placeholder="Artist, album or song" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="btn primary">Search</button>
        <button type="button" className="btn" onClick={() => setManual({})}>Add by hand instead</button>
      </form>
      {err && <div className="small" style={{ color: 'var(--danger)' }}>{err}</div>}

      {artists && artists.length > 0 && <><h2 className="h-sec">Artists</h2>
        <div className="row">{artists.map((a) => { const ex = haveArtist(a.name); return (
          <button key={a.id} className="link" style={{ background: 'var(--surface)', cursor: 'pointer' }} onClick={() => addArtist(a.name, a.id, a.url)}>
            {a.name}{a.genre ? <span className="muted"> · {a.genre}</span> : null}{ex ? ' · in library' : ' · add'}</button>); })}</div></>}

      {albums && <><h2 className="h-sec">Albums, EPs &amp; singles <span className="muted">Apple Music</span></h2>
        {!albums.length ? <div className="muted">No results.</div> : <div className="grid tight">{albums.map((a) => { const ex = haveAlbum(a.title, a.artist); return (
          <div key={a.id} className="tile">
            <a href={a.url} target="_blank" rel="noreferrer"><Cover src={a.artwork} title={a.title} /></a>
            <div className="t">{a.title}</div><div className="s">{a.artist}</div><div className="meta"><span className="num">{a.date?.slice(0, 4)}</span><span>{a.kind}</span><span>{a.genre}</span></div>
            <div style={{ marginTop: 6 }}>{ex ? <Link className="btn sm" to={`/release/${ex.id}`}>In library</Link> : <span className="row" style={{ gap: 4 }}><button className="btn sm primary" onClick={() => addAlbum(a, false)}>Add</button><button className="btn sm" onClick={() => addAlbum(a, true)}>Add &amp; open</button></span>}</div>
          </div>); })}</div>}</>}

      {mb && mb.length > 0 && <><h2 className="h-sec">MusicBrainz <span className="muted">good for mixtapes and anything Apple doesn't carry</span></h2>
        <div className="table-wrap"><table className="table"><tbody>{mb.map((g) => { const ex = haveAlbum(g.title, g.artist); return (
          <tr key={g.id}><td style={{ fontWeight: 600 }}>{g.title}</td><td>{g.artist}</td><td className="muted">{[g.type, ...g.secondary].join(' / ')}</td><td className="num muted">{g.date}</td>
            <td style={{ textAlign: 'right' }}>{ex ? <Link to={`/release/${ex.id}`}>In library</Link> : <button className="btn sm" onClick={() => addAlbum(g, false)}>Add</button>}</td></tr>); })}</tbody></table></div></>}

      {songs && songs.length > 0 && <><h2 className="h-sec">Songs</h2>
        <div className="table-wrap"><table className="table"><tbody>{songs.map((s) => (
          <tr key={s.id}><td className="thumb"><Cover src={s.artwork} title={s.title} size={36} /></td><td style={{ fontWeight: 600 }}>{s.title}</td><td>{s.artist}</td><td className="muted">{s.album}</td>
            <td style={{ textAlign: 'right' }}><a className="btn sm" href={s.url} target="_blank" rel="noreferrer">Apple Music</a></td></tr>))}</tbody></table></div>
        <p className="small muted">To keep a song, add its album — then rate the song on the album page.</p></>}

      {manual && <ReleaseForm onClose={() => setManual(null)} defaults={{ title: q }} />}
    </div>
  );
}
