import { useEffect, useMemo, useRef, useState } from 'react';
import { BrowserRouter, Link, NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { Cover } from './components/ui';
import { mode, supabase } from './lib/db';
import { linkQueue, useLinkQueue } from './lib/queue';
import { norm, releaseArtists, StoreProvider, useStore } from './lib/store';
import ArtistPage from './pages/ArtistPage';
import Artists from './pages/Artists';
import Charts from './pages/Charts';
import Concerts from './pages/Concerts';
import Find from './pages/Find';
import Home from './pages/Home';
import Library from './pages/Library';
import ListPage, { Lists } from './pages/Lists';
import ReleasePage from './pages/ReleasePage';
import Review, { needsReview } from './pages/Review';
import Settings from './pages/Settings';
import TrackPage from './pages/TrackPage';

function GlobalSearch() {
  const { data, ix } = useStore();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState(0);
  const nav = useNavigate();
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === '/' && !(e.target as HTMLElement).closest('input,textarea,select')) { e.preventDefault(); box.current?.querySelector('input')?.focus(); } };
    window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k);
  }, []);
  const results = useMemo(() => {
    const n = norm(q); if (n.length < 2) return [];
    const hit = (s?: string | null) => !!s && norm(s).includes(n);
    const starts = (s: string) => (norm(s).startsWith(n) ? 0 : 1);
    const artists = data.artists.filter((a) => hit(a.name) || a.aliases.some(hit)).sort((a, b) => starts(a.name) - starts(b.name) || a.name.length - b.name.length).slice(0, 6)
      .map((a) => ({ to: `/artist/${a.id}`, title: a.name, sub: a.is_producer ? 'Artist · producer' : 'Artist', img: a.image_url, round: true }));
    const releases = data.releases.filter((r) => hit(r.title) || hit(`${r.artist_credit} ${r.title}`)).sort((a, b) => starts(a.title) - starts(b.title)).slice(0, 8)
      .map((r) => ({ to: `/release/${r.id}`, title: r.title, sub: `${r.artist_credit} · ${r.type} · ${r.year ?? ''}`, img: r.artwork_url, round: false }));
    const tracks = data.tracks.filter((t) => hit(t.title)).slice(0, 6)
      .map((t) => { const r = t.release_id ? ix.releases.get(t.release_id) : undefined; return { to: `/track/${t.id}`, title: t.title, sub: `Song · ${t.artist_credit ?? r?.artist_credit ?? ''}${r ? ` · ${r.title}` : ''}`, img: r?.artwork_url, round: false }; });
    return [{ g: 'Artists', items: artists }, { g: 'Releases', items: releases }, { g: 'Songs', items: tracks }].filter((x) => x.items.length);
  }, [q, data, ix]);
  const flat = results.flatMap((r) => r.items);
  const go = (to: string) => { nav(to); setOpen(false); setQ(''); (document.activeElement as HTMLElement)?.blur(); };
  return (
    <div className="search" ref={box} onBlur={(e) => { if (!box.current?.contains(e.relatedTarget as Node)) setOpen(false); }}>
      <input className="input" placeholder="Search your library — artists, releases, songs  ( / )" value={q} aria-label="Search your library"
        onChange={(e) => { setQ(e.target.value); setOpen(true); setSel(0); }} onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(s + 1, flat.length - 1)); }
          if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
          if (e.key === 'Enter') { if (flat[sel]) go(flat[sel].to); else if (q.trim()) go(`/find?q=${encodeURIComponent(q.trim())}`); }
          if (e.key === 'Escape') setOpen(false);
        }} />
      {open && q.trim().length >= 2 && (
        <div className="dropdown">
          {results.map((grp) => (
            <div key={grp.g}><div className="dd-group">{grp.g}</div>
              {grp.items.map((it) => { const i = flat.indexOf(it); return (
                <Link key={it.to} to={it.to} className={`dd-item${i === sel ? ' sel' : ''}`} onClick={() => go(it.to)}>
                  <Cover src={it.img} title={it.title} size={36} round={it.round} />
                  <span style={{ minWidth: 0 }}><div style={{ fontWeight: 600 }}>{it.title}</div><div className="small muted">{it.sub}</div></span>
                </Link>); })}
            </div>
          ))}
          <Link to={`/find?q=${encodeURIComponent(q.trim())}`} className="dd-item" onClick={() => go(`/find?q=${encodeURIComponent(q.trim())}`)}>
            <span><strong>Find “{q.trim()}” online</strong><div className="small muted">Search Apple Music and MusicBrainz and add it to your library</div></span>
          </Link>
        </div>
      )}
    </div>
  );
}

function QueueStatus() {
  const s = useLinkQueue();
  if (!s.pending && !s.running) return null;
  const total = s.pending + s.done;
  return (
    <Link to="/settings" className="small muted" style={{ minWidth: 150 }} title="Linking in the background">
      Linking {s.done.toLocaleString()} / {total.toLocaleString()}{s.paused ? ' (paused)' : ''}
      <div className="progress" style={{ marginTop: 3 }}><div style={{ width: `${total ? (s.done / total) * 100 : 0}%` }} /></div>
    </Link>
  );
}

function Shell() {
  const { data, ix, loading, error, toast, upsert } = useStore();
  const [menu, setMenu] = useState(false);
  const loc = useLocation();
  useEffect(() => { setMenu(false); window.scrollTo(0, 0); }, [loc.pathname]);
  useEffect(() => {
    linkQueue.configure({
      getArtist: (id) => ix.artists.get(id), getRelease: (id) => ix.releases.get(id),
      releaseArtistName: (r) => releaseArtists(ix, r.id)[0]?.name ?? r.artist_credit ?? '',
      saveArtist: (a) => upsert('artists', [a]), saveRelease: (r) => upsert('releases', [r]),
    });
  }, [ix, upsert]);
  const producers = useMemo(() => data.artists.filter((a) => a.is_producer).length, [data.artists]);
  const toReview = useMemo(() => { const t = new Date().toISOString().slice(0, 10); return data.releases.filter((r) => needsReview(r, t)).length; }, [data.releases]);
  const nav: [string, string, number | null][] = [
    ['/', 'Home', null], ['/library', 'Library', data.releases.length], ['/artists', 'Artists', data.artists.length],
    ['/producers', 'Producers', producers], ['/lists', 'Lists', data.lists.length], ['/charts', 'Charts', null],
    ['/concerts', 'Concerts', data.concerts.length],
  ];
  return (
    <div className="shell">
      <aside className={`sidebar${menu ? ' open' : ''}`}>
        <Link to="/" className="wordmark" style={{ textDecoration: 'none' }}>SavStanfield<span>music hub</span></Link>
        <nav className="nav">
          {nav.map(([to, label, n]) => <NavLink key={to} to={to} end={to === '/'}>{label}{n !== null && <span className="count">{n.toLocaleString()}</span>}</NavLink>)}
          <div className="nav-sep" />
          <NavLink to="/find">Find &amp; add music</NavLink>
          <NavLink to="/review">Review matches{toReview > 0 && <span className="count">{toReview.toLocaleString()}</span>}</NavLink>
          <NavLink to="/settings">Import &amp; settings</NavLink>
        </nav>
        <div className="spacer" />
        <div className="small muted" style={{ padding: '0 8px' }}>{mode === 'local' ? 'Saved in this browser only' : 'Synced to your account'}</div>
      </aside>
      <div className="main">
        <header className="topbar">
          <button className="btn menu-btn" onClick={() => setMenu(true)} aria-label="Open menu">Menu</button>
          <GlobalSearch />
          <span className="spacer" />
          <QueueStatus />
        </header>
        <main className="page">
          {loading ? <div className="muted">Loading your library…</div> : error ? <div className="empty">Couldn't load your library: {error}</div> : (
            <Routes>
              <Route path="/" element={<Home />} />
              <Route path="/library" element={<Library />} />
              <Route path="/artists" element={<Artists producers={false} />} />
              <Route path="/producers" element={<Artists producers />} />
              <Route path="/artist/:id" element={<ArtistPage />} />
              <Route path="/release/:id" element={<ReleasePage />} />
              <Route path="/track/:id" element={<TrackPage />} />
              <Route path="/lists" element={<Lists />} />
              <Route path="/list/:id" element={<ListPage />} />
              <Route path="/charts" element={<Charts />} />
              <Route path="/concerts" element={<Concerts />} />
              <Route path="/find" element={<Find />} />
              <Route path="/review" element={<Review />} />
              <Route path="/settings" element={<Settings />} />
              <Route path="*" element={<div className="empty">That page doesn't exist. <Link to="/">Go home</Link></div>} />
            </Routes>
          )}
        </main>
      </div>
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}

function SignIn() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState('');
  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 16 }}>
      <form className="panel" style={{ width: 'min(400px, 100%)' }} onSubmit={async (e) => {
        e.preventDefault(); setErr('');
        const { error } = await supabase!.auth.signInWithOtp({ email, options: { emailRedirectTo: window.location.origin } });
        if (error) setErr(error.message); else setSent(true);
      }}>
        <div className="wordmark" style={{ margin: '0 0 18px' }}>SavStanfield<span>music hub</span></div>
        {sent ? <p>Check your email for a sign-in link.</p> : <>
          <label><span className="label">Email</span><input className="input" style={{ width: '100%' }} type="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></label>
          <button className="btn primary" style={{ marginTop: 12 }}>Email me a sign-in link</button>
          {err && <p style={{ color: 'var(--danger)' }}>{err}</p>}
        </>}
      </form>
    </div>
  );
}

export default function App() {
  const [session, setSession] = useState<'unknown' | 'in' | 'out'>(supabase ? 'unknown' : 'in');
  useEffect(() => {
    if (!supabase) return;
    supabase.auth.getSession().then(({ data }) => setSession(data.session ? 'in' : 'out'));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s ? 'in' : 'out'));
    return () => sub.subscription.unsubscribe();
  }, []);
  if (session === 'unknown') return null;
  if (session === 'out') return <SignIn />;
  return <BrowserRouter><StoreProvider><Shell /></StoreProvider></BrowserRouter>;
}
