import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { AddToList, AnnotationPanel, Cover, Credits, fmtDate, fmtMs, LinkBar, LinksEditor, Modal, QuickRate } from '../components/ui';
import { autoLinkRelease, findReleaseLabels, followLinks, tracklistSources } from '../lib/enrich';
import AddToPlaylist from '../components/AddToPlaylist';
import { player, usePlayer } from '../lib/player';
import { parseArtistCredit } from '../lib/importSheet';
import { fantanoSearch, mergeLinks } from '../lib/links';
import {
  appleCatalogueMatches, appleEmbed, appleFindAlbum, appleSearchAlbums, artistMatch, geniusSearch, geniusSong, mbLinks, mbSearchGroups,
  pickApple, wikiCover, type SourceTrack, soundcloudEmbed, soundcloudOembed, titleScore, wikiSearch, wikidataToWikipedia, youtubeEmbed, youtubeSearch, type AppleAlbum, type GeniusHit, type MBGroup,
} from '../lib/sources';
import { norm, releaseArtists, releaseLabels, trackArtists, useStore } from '../lib/store';
import PeopleInput from '../components/PeopleInput';
import { RELEASE_TYPES, type Artist, type Release, type Track } from '../lib/types';
import { now, uid } from '../lib/util';

export default function ReleasePage() {
  const { id } = useParams();
  const st = useStore();
  const { ix, upsert, say } = st;
  const nav = useNavigate();
  const r = ix.releases.get(id!);
  const [editLinks, setEditLinks] = useState(false);
  const [editing, setEditing] = useState(false);
  const [matching, setMatching] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [editTracks, setEditTracks] = useState(false);
  const [busy, setBusy] = useState('');
  const [embed, setEmbed] = useState<'apple' | 'youtube' | 'soundcloud' | null>(null);
  const [yt, setYt] = useState<Awaited<ReturnType<typeof youtubeSearch>> | null>(null);
  const ps = usePlayer(); const playingId = ps.ids[ps.index];
  useEffect(() => { if (id) void st.loadReleaseTracks([id]); }, [id, st.loadReleaseTracks]);

  const tracks = useMemo(() => [...(ix.tracksByRelease.get(id!) ?? [])].sort((a, b) => (a.disc ?? 1) - (b.disc ?? 1) || (a.number ?? 0) - (b.number ?? 0)), [ix, id]);
  const producers = useMemo(() => {
    if (!r) return [];
    const m = new Map<string, { a: Artist; exec: boolean; n: number }>();
    for (const a of releaseArtists(ix, r.id, 'exec_producer')) m.set(a.id, { a, exec: true, n: 0 });
    for (const t of tracks) for (const a of trackArtists(ix, t.id, 'producer')) { const e = m.get(a.id) ?? { a, exec: false, n: 0 }; e.n++; m.set(a.id, e); }
    return [...m.values()].sort((x, y) => Number(y.exec) - Number(x.exec) || y.n - x.n);
  }, [ix, r, tracks]);

  if (!r) return <div className="empty">This release isn't in your library. <Link to="/library">Back to library</Link></div>;
  const primary = releaseArtists(ix, r.id);
  const artistName = primary[0]?.name ?? r.artist_credit ?? '';
  const save = (patch: Partial<Release>) => upsert('releases', [{ ...r, ...patch, updated_at: now() }]);

  async function quickLink() {
    setBusy('Looking for matches…');
    try {
      const res = await autoLinkRelease(r!, artistName);
      await save(res.patch);
      const failed = [...new Set(res.errors.map((e) => e.split(':')[0]))];
      say(`${res.found.length ? `Linked: ${res.found.join(', ')}.` : 'No confident matches — try “Match by hand”.'}${failed.length ? ` Couldn't reach ${failed.join(', ')}.` : ''}`);
    } finally { setBusy(''); }
  }

  async function fetchTracks() {
    setBusy('Fetching tracklist…');
    try {
      let rel = r!;
      if (!rel.ext.apple_id) {
        const c = await appleFindAlbum(rel.title, artistName);
        if (!c) { say('Couldn’t find this on Apple Music. Use “Match by hand” first.'); return; }
        rel = { ...rel, ext: { ...rel.ext, apple_id: c.id }, links: mergeLinks(rel.links, { apple: c.url }), artwork_url: rel.artwork_url ?? c.artwork ?? null, updated_at: now() };
        await upsert('releases', [rel]);
      }
      const res = await st.replaceTracklist(rel);
      say(res.source ? `Tracklist from ${res.source}: ${res.added} tracks` : 'No tracklist found');
    } catch (e) { say((e as Error).message); } finally { setBusy(''); }
  }

  async function fetchProducers() {
    if (!tracks.length) { say('Fetch the tracklist first'); return; }
    let found = 0;
    try {
      for (const [i, t] of tracks.entries()) {
        setBusy(`Credits ${i + 1}/${tracks.length}: ${t.title}`);
        const hits = await geniusSearch(`${artistName} ${t.title.replace(/\s*\((feat|ft|with)\.?[^)]*\)/i, '')}`);
        const hit = hits.find((h) => titleScore(h.title, t.title) >= 0.85 && (artistMatch(h.artist, artistName) || artistMatch(h.artist, t.artist_credit ?? '')));
        if (!hit) continue;
        const s = await geniusSong(hit.id);
        await upsert('tracks', [{ ...t, links: mergeLinks(t.links, { genius: s.url, youtube: s.youtube }), ext: { ...t.ext, genius_id: hit.id }, updated_at: now() }]);
        s.producers.forEach((p, n) => {
          const { artist } = st.ensureArtist(p.name, { is_producer: true, links: { genius: p.url }, ext: { genius_id: p.id }, image_url: p.image_url && !/default_avatar/.test(p.image_url) ? p.image_url : null });
          st.creditArtist(artist.id, { track_id: t.id }, 'producer', n);
        });
        s.featured.forEach((p, n) => { const { artist } = st.ensureArtist(p.name, { links: { genius: p.url }, ext: { genius_id: p.id } }); st.creditArtist(artist.id, { track_id: t.id }, 'featured', n); });
        if (s.producers.length) found++;
        if (!r!.links.genius && s.album && titleScore(s.album.name, r!.title) >= 0.85) await save({ links: mergeLinks(r!.links, { genius: s.album.url }) });
      }
      say(`Producer credits found for ${found} of ${tracks.length} tracks`);
    } catch (e) { say((e as Error).message); } finally { setBusy(''); }
  }

  async function findYoutube() {
    setBusy('Searching YouTube…');
    try {
      const res = [...await youtubeSearch(`${artistName} ${r!.title} full album`, 'playlist'), ...await youtubeSearch(`${artistName} ${r!.title} full album`, 'video')];
      setYt(res);
    } catch (e) { say((e as Error).message); } finally { setBusy(''); }
  }

  const ae = appleEmbed(r.links.apple); const ye = youtubeEmbed(r.links.youtube); const se = soundcloudEmbed(r.links.soundcloud);
  const relLabels = releaseLabels(ix, r.id);
  /** Saving links: a new SoundCloud link also brings its cover if the release has none. */
  async function saveLinks(links: Release['links']) {
    setBusy('Saving links…');
    try {
      let artwork_url = r!.artwork_url;
      if (!artwork_url && links.soundcloud && links.soundcloud !== r!.links.soundcloud) {
        const o = await soundcloudOembed(links.soundcloud); if (o?.thumb) { artwork_url = o.thumb; say('Cover taken from SoundCloud'); }
      }
      await followThrough(st, { ...r!, artwork_url }, links, setBusy);
    } finally { setBusy(''); }
  }
  async function useWikiCover() {
    setBusy('Fetching the Wikipedia cover…');
    try { const c = await wikiCover(r!.links.wikipedia!); if (c) { await save({ artwork_url: c }); say('Cover taken from Wikipedia'); } else say('No cover found on the Wikipedia page'); }
    catch (e) { say((e as Error).message); } finally { setBusy(''); }
  }
  async function findLabels() {
    setBusy('Looking up labels…');
    try {
      const res = await findReleaseLabels(r!);
      if (res.names.length) { await st.setReleaseLabels(r!.id, [...relLabels.map((l) => l.name), ...res.names]); say(`Labels from ${res.source}: ${res.names.join(', ')}`); }
      else say('No label found — add it with Edit');
    } catch (e) { say((e as Error).message); } finally { setBusy(''); }
  }

  return (
    <div>
      <div className="hero">
        <Cover src={r.artwork_url} title={r.title} eager />
        <div>
          <div className="muted" style={{ marginBottom: 8 }}>{r.type}</div>
          <h1 className="hero-title">{r.title}</h1>
          <div style={{ fontSize: 22, fontWeight: 600, marginTop: 10, fontVariationSettings: "'wdth' 85" }}><Credits release={r} /></div>
          <div className="hero-meta">
            <span className="num">{r.date ? fmtDate(r.date) : r.year}</span>{relLabels.map((l) => <Link key={l.id} to={`/label/${l.id}`}>{l.name}</Link>)}
            {tracks.length > 0 && <span>{tracks.length} tracks</span>}
            <QuickRate type="release" id={r.id} />
          </div>
        </div>
      </div>

      <div style={{ margin: '22px 0' }}><LinkBar links={r.links} kind="release" name={r.title} artist={artistName} onEdit={() => setEditLinks(true)}
        extra={<a className="link search" href={fantanoSearch(r.title, artistName)} target="_blank" rel="noreferrer">Fantano</a>} /></div>

      <div className="row" style={{ marginBottom: 8 }}>
        <button className="btn primary" disabled={!!busy} onClick={quickLink}>Find links &amp; artwork</button>
        <button className="btn" disabled={!!busy} onClick={() => setMatching(true)}>Match by hand</button>
        <button className="btn" disabled={!!busy} onClick={() => setChoosing(true)} title="Choose where the tracklist comes from">{tracks.length ? 'Replace tracklist' : 'Get tracklist'}</button>
        {r.links.wikipedia && <button className="btn" disabled={!!busy} onClick={useWikiCover} title="The cover shown on the album’s Wikipedia page">Use Wikipedia cover</button>}
        <button className="btn" disabled={!!busy || !tracks.length} onClick={fetchProducers} title="Looks up each song on Genius">Get producer credits</button>
        {!relLabels.length && <button className="btn" disabled={!!busy || !(r.ext.deezer_id || r.ext.mbid || r.ext.apple_id)} onClick={findLabels} title="From Deezer, MusicBrainz or Apple Music">Find labels</button>}
        <AddToList type="release" id={r.id} />
        <button className="btn" onClick={() => setEditing(true)}>Edit</button>
        {busy && <span className="small muted">{busy}</span>}
      </div>

      <div className="two" style={{ marginTop: 24 }}>
        <div>
          <div className="row" style={{ marginBottom: 10 }}>
            {ae && <button className={`chip${embed === 'apple' ? ' on' : ''}`} onClick={() => setEmbed(embed === 'apple' ? null : 'apple')}>Play on Apple Music</button>}
            {ye && <button className={`chip${embed === 'youtube' ? ' on' : ''}`} onClick={() => setEmbed(embed === 'youtube' ? null : 'youtube')}>Play on YouTube</button>}
            {se && <button className={`chip${embed === 'soundcloud' ? ' on' : ''}`} onClick={() => setEmbed(embed === 'soundcloud' ? null : 'soundcloud')}>Play on SoundCloud</button>}
            {!ye && <button className="chip" disabled={!!busy} onClick={findYoutube}>Find on YouTube</button>}
          </div>
          {embed === 'apple' && ae && <iframe className="embed" title="Apple Music player" src={ae} height={450} allow="autoplay *; encrypted-media *; clipboard-write" sandbox="allow-forms allow-popups allow-same-origin allow-scripts allow-top-navigation-by-user-activation" />}
          {embed === 'soundcloud' && se && <iframe className="embed" title="SoundCloud player" src={se} height={400} allow="autoplay" />}
          {embed === 'youtube' && ye && <iframe className="embed" title="YouTube player" src={ye} style={{ aspectRatio: '16/9' }} allow="encrypted-media; picture-in-picture" allowFullScreen />}
          {yt && <div className="panel" style={{ marginBottom: 16 }}>
            <div className="row" style={{ marginBottom: 8 }}><strong>Pick the right YouTube upload</strong><span className="spacer" /><button className="btn sm ghost" onClick={() => setYt(null)}>Close</button></div>
            {yt.map((v) => <div key={v.id} className="cand" onClick={async () => { await save({ links: { ...r.links, youtube: v.url } }); setYt(null); setEmbed('youtube'); }}>
              {v.thumb ? <img src={v.thumb} alt="" style={{ width: 52, height: 40, objectFit: 'cover' }} /> : <span />}
              <span><div style={{ fontWeight: 600 }}>{v.title}</div><div className="small muted">{v.channel} · {v.url.includes('playlist') ? 'Playlist' : 'Video'}</div></span><span className="small">Use</span></div>)}
            {!yt.length && <div className="muted">No results.</div>}
          </div>}

          <h2 className="h-sec">Tracklist {tracks.length > 0 && <span className="muted">{fmtMs(tracks.reduce((s, t) => s + (t.duration_ms ?? 0), 0))}</span>}
            {tracks.length > 0 && <span className="row" style={{ marginLeft: 'auto', gap: 6, fontSize: 14, fontWeight: 400 }}>
              <button className="btn sm" onClick={() => player.play(tracks.map((x) => x.id), 0, r.title)}>Play album</button>
              <AddToPlaylist trackIds={tracks.map((x) => x.id)} label="Add album to playlist" />
              {!editTracks && <button className="btn sm" onClick={() => setEditTracks(true)}>Edit tracklist</button>}
            </span>}</h2>
          {editTracks ? <TracklistEditor release={r} tracks={tracks} onClose={() => setEditTracks(false)} /> : !tracks.length ? <div className="empty">No tracks yet. “Get tracklist” pulls it from Apple Music, Deezer, MusicBrainz or Wikipedia — or <button className="btn sm" onClick={() => setEditTracks(true)}>type it in</button></div> : (
            <ol className="tracklist">{tracks.map((t, i) => {
              const prods = trackArtists(ix, t.id, 'producer'); const feats = trackArtists(ix, t.id, 'featured');
              return (
                <li key={t.id} className={playingId === t.id ? 'playing' : ''}>
                  <button className="n btn ghost sm" style={{ padding: '2px 4px' }} aria-label={`Play ${t.title}`} title="Play" onClick={() => player.play(tracks.map((x) => x.id), i, r.title)}>{playingId === t.id ? '♪' : t.number ?? i + 1}</button>
                  <span style={{ minWidth: 0 }}>
                    <Link to={`/track/${t.id}`} style={{ fontWeight: 500 }}>{t.title}</Link>
                    {t.artist_credit && <span className="muted small"> — {t.artist_credit}</span>}
                    {t.ext.stale ? <span className="small" style={{ color: 'var(--danger)' }}> · not on this release (kept because you rated or listed it) <button className="btn sm ghost" onClick={async () => { if (confirm(`Remove “${t.title}” and its rating?`)) { await st.remove('credits', (ix.creditsByTrack.get(t.id) ?? []).map((c) => c.id)); await st.remove('tracks', [t.id]); } }}>Remove</button></span> : null}
                    {(prods.length > 0 || feats.length > 0) && <div className="credits">
                      {feats.length > 0 && <>feat. {feats.map((a, j) => <span key={a.id}>{j ? ', ' : ''}<Link to={`/artist/${a.id}`}>{a.name}</Link></span>)}{prods.length ? ' · ' : ''}</>}
                      {prods.length > 0 && <>prod. {prods.map((a, j) => <span key={a.id}>{j ? ', ' : ''}<Link to={`/artist/${a.id}`}>{a.name}</Link></span>)}</>}
                    </div>}
                  </span>
                  <span className="small muted num">{fmtMs(t.duration_ms)}</span>
                  <span className="row" style={{ flexWrap: 'nowrap', gap: 2 }}><QuickRate type="track" id={t.id} /><AddToPlaylist trackIds={[t.id]} label="+" small /></span>
                </li>);
            })}</ol>
          )}

          <h2 className="h-sec">Critics</h2>
          <CriticScores release={r} artistName={artistName} />
        </div>

        <div className="stack">
          <AnnotationPanel type="release" id={r.id} />
          {producers.length > 0 && <div className="panel">
            <div className="label">Producers</div>
            {producers.map(({ a, exec, n }) => <div key={a.id} className="row" style={{ padding: '3px 0' }}>
              <Link to={`/artist/${a.id}`} style={{ fontWeight: 600 }}>{a.name}</Link><span className="spacer" />
              <span className="small muted">{exec ? 'Executive producer' : ''}{exec && n ? ' · ' : ''}{n ? `${n} track${n > 1 ? 's' : ''}` : ''}</span></div>)}
          </div>}
          {primary.length > 0 && <div className="panel">
            <div className="label">Artists</div>
            {primary.map((a) => <Link key={a.id} to={`/artist/${a.id}`} className="dd-item"><Cover src={a.image_url} title={a.name} size={40} round /><strong>{a.name}</strong></Link>)}
          </div>}
          <div className="small muted">Added {r.created_at ? fmtDate(r.created_at.slice(0, 10)) : ''} · source: {r.source}</div>
          <button className="btn danger" onClick={async () => { if (confirm(`Delete “${r.title}” and its tracks, ratings and notes?`)) { await st.deleteRelease(r.id); nav('/library'); } }}>Delete release</button>
        </div>
      </div>

      {editLinks && <LinksEditor links={r.links} onClose={() => setEditLinks(false)} onSave={(links) => void saveLinks(links)} />}
      {editing && <ReleaseForm release={r} onClose={() => setEditing(false)} />}
      {choosing && <TracklistChooser release={r} hasTracks={tracks.length > 0} onClose={() => setChoosing(false)} onAppleSearch={() => { setChoosing(false); void fetchTracks(); }} />}
      {matching && <MatchWizard release={r} artistName={artistName} onClose={() => setMatching(false)} />}
    </div>
  );
}

// ——— Critic scores ———
const CRITICS: [string, number][] = [['Pitchfork', 10], ['Fantano', 10], ['Rolling Stone', 5], ['AOTY critics', 100], ['AOTY users', 100], ['RYM', 5], ['Metacritic', 100], ['HipHopDX', 5], ['XXL', 5], ['The Source', 5], ['Other', 10]];
function CriticScores({ release, artistName }: { release: Release; artistName: string }) {
  const { ix, upsert, remove } = useStore();
  const scores = ix.scoresByRelease.get(release.id) ?? [];
  const [src, setSrc] = useState('Pitchfork'); const [score, setScore] = useState(''); const [url, setUrl] = useState('');
  const max = CRITICS.find((c) => c[0] === src)?.[1] ?? 10;
  return (
    <div>
      {scores.length > 0 && <table className="table" style={{ marginBottom: 12 }}><tbody>{scores.map((s) => (
        <tr key={s.id}><td style={{ fontWeight: 600 }}>{s.url ? <a href={s.url} target="_blank" rel="noreferrer">{s.source}</a> : s.source}</td>
          <td className="num">{s.score ?? '—'} <span className="muted">/ {s.max}</span></td>
          <td style={{ width: 120 }}><div className="progress"><div style={{ width: `${((s.score ?? 0) / s.max) * 100}%` }} /></div></td>
          <td style={{ textAlign: 'right' }}><button className="btn sm ghost" onClick={() => remove('critic_scores', [s.id])}>Remove</button></td></tr>))}</tbody></table>}
      <form className="row" onSubmit={async (e) => { e.preventDefault(); if (!score) return; await upsert('critic_scores', [{ id: uid(), release_id: release.id, source: src, score: Number(score), max, url: url || null }]); setScore(''); setUrl(''); }}>
        <select className="select" value={src} onChange={(e) => setSrc(e.target.value)} aria-label="Source">{CRITICS.map(([c]) => <option key={c}>{c}</option>)}</select>
        <input className="input num" style={{ width: 80 }} inputMode="decimal" placeholder={`/ ${max}`} value={score} onChange={(e) => setScore(e.target.value)} aria-label="Score" />
        <input className="input" style={{ flex: 1, minWidth: 160 }} placeholder="Link to the review (optional)" value={url} onChange={(e) => setUrl(e.target.value)} />
        <button className="btn">Add score</button>
      </form>
      <div className="small muted" style={{ marginTop: 8 }}>Look up: {[['Pitchfork', `https://pitchfork.com/search/?q=${encodeURIComponent(`${artistName} ${release.title}`)}`], ['AOTY', release.links.aoty ?? `https://www.albumoftheyear.org/search/?q=${encodeURIComponent(`${artistName} ${release.title}`)}`], ['RYM', release.links.rym ?? `https://rateyourmusic.com/search?searchterm=${encodeURIComponent(`${artistName} ${release.title}`)}&searchtype=l`], ['Metacritic', `https://www.metacritic.com/search/${encodeURIComponent(release.title)}/?category=10`], ['Fantano', fantanoSearch(release.title, artistName)]].map(([l, u], i) => <span key={l}>{i ? ' · ' : ''}<a href={u} target="_blank" rel="noreferrer" style={{ textDecoration: 'underline' }}>{l}</a></span>)}</div>
    </div>
  );
}

// ——— Add / edit a release ———
export function ReleaseForm({ release, onClose, defaults }: { release?: Release; onClose: () => void; defaults?: Partial<Release> }) {
  const st = useStore();
  const nav = useNavigate();
  const init = release ?? { title: '', type: 'Album', artist_credit: '', date: '', year: null, label: '', artwork_url: '', ...defaults };
  const [f, setF] = useState({ title: init.title, type: init.type, artist_credit: init.artist_credit ?? '', date: init.date ?? '', year: init.year ? String(init.year) : '', label: init.label ?? '', artwork_url: init.artwork_url ?? '' });
  const execs = release ? releaseArtists(st.ix, release.id, 'exec_producer').map((a) => a.name).join(', ') : '';
  const curLabels = release ? releaseLabels(st.ix, release.id).map((l) => l.name).join(', ') : '';
  const [labels, setLabels] = useState(curLabels);
  const [prod, setProd] = useState(execs);
  const up = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  async function submit() {
    if (!f.title.trim() || !f.artist_credit.trim()) return;
    const date = f.date || null; const year = f.year ? Number(f.year) : date ? Number(date.slice(0, 4)) : null;
    const r: Release = { ...(release ?? { id: uid(), source: 'manual', links: {}, ext: {}, created_at: now(), ...defaults }), title: f.title.trim(), type: f.type, artist_credit: f.artist_credit.trim(), date, year, label: f.label || null, artwork_url: f.artwork_url || null, updated_at: now() } as Release;
    await st.upsert('releases', [r]);
    // Re-point primary artist credits if the artist text changed (or for a new release)
    if (!release || release.artist_credit !== r.artist_credit) {
      const old = (st.ix.creditsByRelease.get(r.id) ?? []).filter((c) => c.role === 'primary').map((c) => c.id);
      await st.remove('credits', old);
      const { names, group } = parseArtistCredit(r.artist_credit!, /collab/i.test(r.type));
      [...(group ? [group] : []), ...names].forEach((n, i) => st.creditArtist(st.ensureArtist(n).artist.id, { release_id: r.id }, 'primary', i));
    }
    if (labels !== curLabels) await st.setReleaseLabels(r.id, labels.split(','));
    if (prod !== execs) {
      await st.remove('credits', (st.ix.creditsByRelease.get(r.id) ?? []).filter((c) => c.role === 'exec_producer').map((c) => c.id));
      prod.split(',').map((s) => s.trim()).filter(Boolean).forEach((n, i) => st.creditArtist(st.ensureArtist(n, { is_producer: true }).artist.id, { release_id: r.id }, 'exec_producer', i));
    }
    onClose();
    if (!release) nav(`/release/${r.id}`);
  }
  return (
    <Modal title={release ? 'Edit release' : 'Add a release'} onClose={onClose}>
      <form className="form-grid" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <label className="full"><span className="label">Title</span><input className="input" style={{ width: '100%' }} required autoFocus value={f.title} onChange={up('title')} /></label>
        <label className="full"><span className="label">Artist — use “A & B” for collaborations, “A & B as Group” for duos with a name</span><input className="input" style={{ width: '100%' }} required value={f.artist_credit} onChange={up('artist_credit')} /></label>
        <label><span className="label">Type</span><select className="select" style={{ width: '100%' }} value={f.type} onChange={up('type')}>{[...new Set([...RELEASE_TYPES, f.type])].map((t) => <option key={t}>{t}</option>)}</select></label>
        <label><span className="label">Release date</span><input className="input" style={{ width: '100%' }} type="date" value={f.date} onChange={up('date')} /></label>
        <label><span className="label">Year (if no exact date)</span><input className="input num" style={{ width: '100%' }} inputMode="numeric" value={f.year} onChange={up('year')} /></label>
        <label><span className="label">Labels, comma-separated</span><input className="input" style={{ width: '100%' }} value={labels} onChange={(e) => setLabels(e.target.value)} /></label>
        <label className="full"><span className="label">Executive producer(s), comma-separated</span><input className="input" style={{ width: '100%' }} value={prod} onChange={(e) => setProd(e.target.value)} /></label>
        <label className="full"><span className="label">Artwork URL</span><input className="input" style={{ width: '100%' }} value={f.artwork_url} onChange={up('artwork_url')} placeholder="https://…" /></label>
        <div className="full row"><span className="spacer" /><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary">{release ? 'Save changes' : 'Add release'}</button></div>
      </form>
    </Modal>
  );
}

// ——— Choose matches by hand ———
/**
 * Save new links and make everything follow them: the chosen source's ID and cover, then (if the source
 * changed) a fresh tracklist and labels from it.
 */
/** Edit every song on the release at once: titles, numbers, featured artists, producers; add or remove songs. */
type DraftRow = { id: string; isNew: boolean; deleted: boolean; number: string; disc: string; title: string; length: string; feats: string[]; prods: string[] };
const parseLen = (s: string) => { const m = s.trim().match(/^(\d+):(\d{1,2})$/); return m ? (+m[1] * 60 + +m[2]) * 1000 : null; };
function TracklistEditor({ release, tracks, onClose }: { release: Release; tracks: Track[]; onClose: () => void }) {
  const st = useStore(); const { ix } = st;
  const names = (id: string, role: 'producer' | 'featured') => trackArtists(ix, id, role).map((a) => a.name);
  const initial = useMemo<DraftRow[]>(() => tracks.map((t) => ({ id: t.id, isNew: false, deleted: false, number: String(t.number ?? ''), disc: t.disc ? String(t.disc) : '', title: t.title, length: t.duration_ms ? fmtMs(t.duration_ms) : '', feats: names(t.id, 'featured'), prods: names(t.id, 'producer') })), []); // eslint-disable-line react-hooks/exhaustive-deps
  const [rows, setRows] = useState(initial);
  const [saving, setSaving] = useState(false);
  const set = (i: number, patch: Partial<DraftRow>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => norm(x) === norm(b[i]));
  async function save() {
    const rated = rows.filter((r) => r.deleted && !r.isNew && (ix.ann.has(`track:${r.id}`) || st.data.list_items.some((i) => i.entity_id === r.id)));
    if (rated.length && !confirm(`Delete ${rated.map((r) => `“${r.title}”`).join(', ')}? You've rated or listed ${rated.length > 1 ? 'them' : 'it'}.`)) return;
    setSaving(true);
    try {
      const gone: string[] = [];
      for (const [i, r] of rows.entries()) {
        const before = initial.find((x) => x.id === r.id);
        if (r.deleted) {
          if (r.isNew) continue;
          gone.push(...await st.setTrackCredits(r.id, 'producer', [], { prune: false }), ...await st.setTrackCredits(r.id, 'featured', [], { prune: false }));
          await st.remove('credits', (ix.creditsByTrack.get(r.id) ?? []).map((c) => c.id));
          await st.remove('tracks', [r.id]);
          continue;
        }
        if (!r.title.trim()) continue;
        const old = tracks.find((t) => t.id === r.id);
        const fields = { title: r.title.trim(), number: Number(r.number) || (r.isNew ? i + 1 : null), disc: Number(r.disc) || null, duration_ms: parseLen(r.length) ?? (r.length.trim() ? old?.duration_ms ?? null : null) };
        if (r.isNew) await st.upsert('tracks', [{ id: r.id, release_id: release.id, artist_credit: null, links: {}, ext: { manual: true }, created_at: now(), updated_at: now(), ...fields }]);
        else if (old && (old.title !== fields.title || old.number !== fields.number || (old.disc ?? null) !== fields.disc || (old.duration_ms ?? null) !== fields.duration_ms)) await st.upsert('tracks', [{ ...old, ...fields, ext: { ...old.ext, edited: now() }, updated_at: now() }]);
        if (!before || !same(before.prods, r.prods)) gone.push(...await st.setTrackCredits(r.id, 'producer', r.prods, { prune: false }));
        if (!before || !same(before.feats, r.feats)) gone.push(...await st.setTrackCredits(r.id, 'featured', r.feats, { prune: false }));
      }
      const pruned = gone.length ? await st.pruneArtists(gone) : 0;
      st.say(`Tracklist saved${pruned ? ` · removed ${pruned} unused artist${pruned > 1 ? 's' : ''}` : ''}`);
      onClose();
    } catch (e) { st.say((e as Error).message); } finally { setSaving(false); }
  }
  return (
    <div className="tracklist-edit">
      <div className="small muted">Type a name and press Enter to add it; × removes it. Lengths as m:ss.</div>
      {rows.map((r, i) => (
        <div key={r.id} className={`te-row${r.deleted ? ' deleted' : ''}`}>
          <div className="te-fields">
            <input className="input num" aria-label="Track number" value={r.number} onChange={(e) => set(i, { number: e.target.value })} placeholder="#" />
            <input className="input num small" aria-label="Disc" value={r.disc} onChange={(e) => set(i, { disc: e.target.value })} placeholder="disc" />
          </div>
          <div className="te-fields">
            <div className="row" style={{ flexWrap: 'nowrap', gap: 6 }}>
              <input className="input" style={{ flex: 1 }} aria-label="Title" value={r.title} disabled={r.deleted} onChange={(e) => set(i, { title: e.target.value })} placeholder="Song title" />
              <input className="input num" style={{ width: 70 }} aria-label="Length" value={r.length} disabled={r.deleted} onChange={(e) => set(i, { length: e.target.value })} placeholder="m:ss" />
            </div>
            {!r.deleted && <div className="te-two">
              <div><span className="label">Featuring</span><PeopleInput value={r.feats} onChange={(v) => set(i, { feats: v })} placeholder="Add featured artist" /></div>
              <div><span className="label">Producers</span><PeopleInput value={r.prods} onChange={(v) => set(i, { prods: v })} placeholder="Add producer" producersFirst /></div>
            </div>}
          </div>
          <button type="button" className="btn sm ghost" onClick={() => (r.isNew ? setRows((rs) => rs.filter((_, j) => j !== i)) : set(i, { deleted: !r.deleted }))}>{r.deleted ? 'Undo' : 'Remove'}</button>
        </div>
      ))}
      <div className="row">
        <button type="button" className="btn" onClick={() => setRows((rs) => [...rs, { id: uid(), isNew: true, deleted: false, number: String(rs.filter((x) => !x.deleted).length + 1), disc: '', title: '', length: '', feats: [], prods: [] }])}>+ Add song</button>
        <span className="spacer" />
        <button type="button" className="btn" disabled={saving} onClick={onClose}>Cancel</button>
        <button type="button" className="btn primary" disabled={saving} onClick={save}>{saving ? 'Saving…' : 'Save tracklist'}</button>
      </div>
    </div>
  );
}

/** Pick the tracklist source: each linked source is fetched and shown with its track count first. */
function TracklistChooser({ release, hasTracks, onClose, onAppleSearch }: { release: Release; hasTracks: boolean; onClose: () => void; onAppleSearch: () => void }) {
  const st = useStore();
  const sources = useMemo(() => tracklistSources(release), [release]);
  const [got, setGot] = useState<Record<string, SourceTrack[] | string>>({});
  const [saving, setSaving] = useState('');
  useEffect(() => {
    let live = true;
    for (const [name, fn] of sources) fn().then((t) => live && setGot((g) => ({ ...g, [name]: t.length ? t : 'No tracklist found' })), (e: Error) => live && setGot((g) => ({ ...g, [name]: e.message })));
    return () => { live = false; };
  }, [sources]);
  async function use(source: string, tracks: SourceTrack[]) {
    if (hasTracks && !confirm(`Replace the tracklist with ${tracks.length} tracks from ${source}? Songs you’ve rated or put on a list are kept.`)) return;
    setSaving(source);
    try {
      const res = await st.replaceTracklist(release, { source, tracks });
      st.say(`Tracklist from ${source}: ${res.added} new${res.kept ? `, ${res.kept} kept` : ''}${res.producers ? ` · ${res.producers} producer credits` : ''}`);
      onClose();
    } catch (e) { st.say((e as Error).message); setSaving(''); }
  }
  const total = (t: SourceTrack[]) => { const ms = t.reduce((s, x) => s + (x.ms ?? 0), 0); return ms ? ` · ${fmtMs(ms)}` : ''; };
  return (
    <Modal title={hasTracks ? 'Replace tracklist' : 'Get tracklist'} onClose={onClose}>
      <p className="muted" style={{ marginTop: 0 }}>From the sources this release is linked to. Wrong album everywhere? Fix the links first with Match by hand or Edit links.</p>
      {sources.map(([name]) => { const v = got[name]; return (
        <div key={name} className="panel" style={{ marginBottom: 10, padding: 12 }}>
          <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'nowrap' }}>
            <div><strong>{name}</strong> <span className="muted small">{v === undefined ? 'Loading…' : typeof v === 'string' ? v : `${v.length} tracks${total(v)}${v.some((t) => t.producers?.length) ? ' · with producers' : ''}`}</span></div>
            <button className="btn sm primary" disabled={!Array.isArray(v) || !!saving} onClick={() => Array.isArray(v) && use(name, v)}>{saving === name ? 'Saving…' : 'Use this'}</button>
          </div>
          {Array.isArray(v) && <div className="small muted" style={{ marginTop: 6 }}>{v.slice(0, 6).map((t) => t.title).join(' · ')}{v.length > 6 ? ' …' : ''}</div>}
        </div>); })}
      {!release.ext.apple_id && <div className="panel" style={{ padding: 12 }}><div className="row" style={{ justifyContent: 'space-between' }}><span><strong>Apple Music</strong> <span className="muted small">not linked yet</span></span><button className="btn sm" onClick={onAppleSearch}>Search Apple Music</button></div></div>}
      {!sources.length && <div className="small muted" style={{ marginTop: 8 }}>No linked sources yet — add a Wikipedia, Deezer or MusicBrainz link with Edit links.</div>}
    </Modal>
  );
}

async function followThrough(st: ReturnType<typeof useStore>, rel: Release, links: Release['links'], status?: (s: string) => void) {
  const { patch, changed } = await followLinks(rel, links);
  const next = { ...rel, ...patch } as Release;
  await st.upsert('releases', [next]);
  if (!changed.length) { st.say('Links saved'); return; }
  const had = (st.ix.tracksByRelease.get(rel.id)?.length ?? 0) > 0 || !!rel.ext.tracks_at;
  let msg = `Now following ${changed.join(', ')}`;
  if (had) {
    status?.('Replacing tracklist…');
    const t = await st.replaceTracklist(next).catch(() => null);
    if (t?.source) msg += ` · tracklist from ${t.source}`;
  }
  if (rel.ext.labels_at || (st.ix.releaseLabelsByRelease.get(rel.id)?.length ?? 0) > 0) {
    status?.('Updating labels…');
    const names = await st.refreshLabels(next).catch(() => []);
    if (names.length) msg += ` · labels: ${names.join(', ')}`;
  }
  st.say(msg);
}

function MatchWizard({ release, artistName, onClose }: { release: Release; artistName: string; onClose: () => void }) {
  const st = useStore();
  const { say } = st;
  const [q, setQ] = useState(`${artistName} ${release.title}`);
  const [apple, setApple] = useState<AppleAlbum[] | null>(null);
  const [mb, setMb] = useState<MBGroup[] | null>(null);
  const [gen, setGen] = useState<GeniusHit[] | null>(null);
  const [wiki, setWiki] = useState<{ title: string; description: string; url: string }[] | null>(null);
  const [errs, setErrs] = useState<string[]>([]);
  const [pick, setPick] = useState<{ apple?: AppleAlbum; mb?: MBGroup; genius?: GeniusHit; wiki?: string }>({});
  const [saving, setSaving] = useState(false);
  async function search() {
    setErrs([]); setApple(null); setMb(null); setGen(null); setWiki(null);
    const e: string[] = [];
    const w = <T,>(p: Promise<T>, label: string, set: (v: T) => void) => p.then(set).catch((x) => { e.push(`${label}: ${x.message}`); setErrs([...e]); });
    await Promise.all([
      w((async () => {
        // The artist's own catalogue first (reliable), then Apple's keyword search; UK store, then US. Shown as they arrive.
        let all: AppleAlbum[] = [];
        const add = (xs: AppleAlbum[]) => {
          all = [...all, ...xs.filter((x) => !all.some((y) => y.id === x.id))]; setApple(all);
          const best = pickApple(all, release.title, artistName); if (best) setPick((p) => ({ ...p, apple: p.apple ?? best }));
        };
        add(await appleCatalogueMatches(release.title, artistName, 'GB').catch(() => []));
        add(await appleSearchAlbums(q, 15, 'GB'));
        add(await appleCatalogueMatches(release.title, artistName, 'US').catch(() => []));
        add(await appleSearchAlbums(q, 15, 'US').catch(() => []));
      })(), 'Apple', () => undefined),
      w(mbSearchGroups(release.title, artistName), 'MusicBrainz', (v) => setMb(v)),
      w(geniusSearch(q), 'Genius', (v) => setGen(v)),
      w(wikiSearch(`${release.title} ${artistName}`), 'Wikipedia', (v) => setWiki(v)),
    ]);
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void search(); }, []);
  async function apply() {
    setSaving(true);
    try {
      let links = { ...release.links }; const ext = { ...release.ext }; let artwork = release.artwork_url; let date = release.date;
      if (pick.apple) { links.apple = pick.apple.url; artwork = pick.apple.artwork ?? artwork; date = date || pick.apple.date || null; }
      if (pick.mb) {
        const { wikidata, ...rest } = await mbLinks('release-group', pick.mb.id);
        if (!rest.wikipedia && wikidata && !pick.wiki) rest.wikipedia = await wikidataToWikipedia(wikidata);
        // Your pick replaces whatever MusicBrainz match was there
        links = { ...mergeLinks(links, rest), musicbrainz: rest.musicbrainz, ...(rest.wikipedia ? { wikipedia: rest.wikipedia } : {}), ...(rest.discogs ? { discogs: rest.discogs } : {}) };
        date = date || pick.mb.date || null;
      }
      if (pick.genius) { const s = await geniusSong(pick.genius.id); links.genius = s.album?.url ?? s.url; }
      if (pick.wiki) links.wikipedia = pick.wiki;
      onClose();
      await followThrough(st, { ...release, ext, artwork_url: artwork, date, year: date ? Number(date.slice(0, 4)) : release.year }, links);
    } catch (e) { say((e as Error).message); } finally { setSaving(false); }
  }
  const Col = ({ title, children }: { title: string; children: React.ReactNode }) => <div><div className="label" style={{ fontWeight: 600 }}>{title}</div><div style={{ maxHeight: 340, overflowY: 'auto' }}>{children}</div></div>;
  const loading = <div className="small muted">Searching…</div>;
  return (
    <Modal title="Match by hand" onClose={onClose} wide>
      <form className="row" onSubmit={(e) => { e.preventDefault(); void search(); }} style={{ marginBottom: 16 }}>
        <input className="input" style={{ flex: 1 }} value={q} onChange={(e) => setQ(e.target.value)} /><button className="btn">Search again</button>
      </form>
      {errs.length > 0 && <div className="small" style={{ color: 'var(--danger)', marginBottom: 10 }}>{errs.join(' · ')}</div>}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 18 }}>
        <Col title="Apple Music — link and artwork">{!apple ? loading : apple.map((a) => (
          <div key={a.id} className={`cand${pick.apple?.id === a.id ? ' on' : ''}`} onClick={() => setPick({ ...pick, apple: pick.apple?.id === a.id ? undefined : a })}>
            <Cover src={a.artwork} title={a.title} size={52} /><span><div style={{ fontWeight: 600 }}>{a.title}</div><div className="small muted">{a.artist} · {a.kind} · {a.date?.slice(0, 4)} · {a.tracks} tracks{a.country === 'US' ? ' · US store' : ''}{a.explicitness === 'cleaned' ? ' · clean' : ''}</div></span><span />
          </div>))}{apple && !apple.length && <div className="small muted">No results</div>}</Col>
        <Col title="MusicBrainz — IDs, Wikipedia, Discogs">{!mb ? loading : mb.map((g) => (
          <div key={g.id} className={`cand${pick.mb?.id === g.id ? ' on' : ''}`} style={{ gridTemplateColumns: '1fr auto' }} onClick={() => setPick({ ...pick, mb: pick.mb?.id === g.id ? undefined : g })}>
            <span><div style={{ fontWeight: 600 }}>{g.title}</div><div className="small muted">{g.artist} · {[g.type, ...g.secondary].join(' / ')} · {g.date?.slice(0, 4)}</div></span><span className="small muted">{g.score}%</span>
          </div>))}{mb && !mb.length && <div className="small muted">No results</div>}</Col>
        <Col title="Genius — pick any song from it">{!gen ? loading : gen.map((h) => (
          <div key={h.id} className={`cand${pick.genius?.id === h.id ? ' on' : ''}`} onClick={() => setPick({ ...pick, genius: pick.genius?.id === h.id ? undefined : h })}>
            <Cover src={h.image} title={h.title} size={52} /><span><div style={{ fontWeight: 600 }}>{h.title}</div><div className="small muted">{h.artist}</div></span><span />
          </div>))}{gen && !gen.length && <div className="small muted">No results</div>}</Col>
        <Col title="Wikipedia">{!wiki ? loading : wiki.map((p) => (
          <div key={p.url} className={`cand${pick.wiki === p.url ? ' on' : ''}`} style={{ gridTemplateColumns: '1fr' }} onClick={() => setPick({ ...pick, wiki: pick.wiki === p.url ? undefined : p.url })}>
            <span><div style={{ fontWeight: 600 }}>{p.title}</div><div className="small muted">{p.description}</div></span>
          </div>))}{wiki && !wiki.length && <div className="small muted">No results</div>}</Col>
      </div>
      <div className="row" style={{ marginTop: 18 }}><span className="small muted">Selected: {[pick.apple && 'Apple', pick.mb && 'MusicBrainz', pick.genius && 'Genius', pick.wiki && 'Wikipedia'].filter(Boolean).join(', ') || 'nothing'}</span>
        <span className="spacer" /><button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={saving || !Object.values(pick).some(Boolean)} onClick={apply}>{saving ? 'Saving…' : 'Save these links'}</button></div>
    </Modal>
  );
}
