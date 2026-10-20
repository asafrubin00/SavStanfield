import { useEffect, useState } from 'react';
import AddToPlaylist from '../components/AddToPlaylist';
import { player } from '../lib/player';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { AddToList, AnnotationPanel, Cover, fmtMs, LinkBar, LinksEditor, Modal, QuickRate } from '../components/ui';
import { mergeLinks } from '../lib/links';
import { artistMatch, geniusSearch, geniusSong, soundcloudEmbed, titleScore, youtubeEmbed } from '../lib/sources';
import { releaseArtists, trackArtists, useStore } from '../lib/store';
import PeopleInput from '../components/PeopleInput';
import type { Track } from '../lib/types';
import { now } from '../lib/util';

export default function TrackPage() {
  const { id } = useParams();
  const st = useStore();
  const { ix, upsert, remove, say } = st;
  const nav = useNavigate();
  const t = ix.tracks.get(id!);
  const [editLinks, setEditLinks] = useState(false);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [missing, setMissing] = useState(false);
  useEffect(() => { if (id && !ix.tracks.has(id)) { setMissing(false); void st.loadTracks([id]).finally(() => setMissing(true)); } }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!t && !missing) return <div className="muted">Loading…</div>;
  if (!t) return <div className="empty">This song isn't in your library. <Link to="/library">Back to library</Link></div>;
  const r = t.release_id ? ix.releases.get(t.release_id) : undefined;
  const artistName = t.artist_credit ?? (r ? releaseArtists(ix, r.id)[0]?.name ?? r.artist_credit : '') ?? '';
  const prods = trackArtists(ix, t.id, 'producer'); const feats = trackArtists(ix, t.id, 'featured');
  const save = (p: Partial<Track>) => upsert('tracks', [{ ...t, ...p, updated_at: now() }]);
  const ye = youtubeEmbed(t.links.youtube); const se = soundcloudEmbed(t.links.soundcloud);

  async function genius() {
    setBusy(true);
    try {
      const hit = (await geniusSearch(`${artistName} ${t!.title}`)).find((h) => titleScore(h.title, t!.title) >= 0.85 && artistMatch(h.artist, artistName));
      if (!hit) { say('Not found on Genius — paste the link with “Edit links”'); return; }
      const s = await geniusSong(hit.id);
      await save({ links: mergeLinks(t!.links, { genius: s.url, youtube: s.youtube }), ext: { ...t!.ext, genius_id: hit.id } });
      s.producers.forEach((p, n) => st.creditArtist(st.ensureArtist(p.name, { is_producer: true, links: { genius: p.url }, ext: { genius_id: p.id } }).artist.id, { track_id: t!.id }, 'producer', n));
      s.featured.forEach((p, n) => st.creditArtist(st.ensureArtist(p.name, { links: { genius: p.url }, ext: { genius_id: p.id } }).artist.id, { track_id: t!.id }, 'featured', n));
      say(`Genius: ${s.producers.length} producer${s.producers.length === 1 ? '' : 's'} found`);
    } catch (e) { say((e as Error).message); } finally { setBusy(false); }
  }

  return (
    <div>
      <div className="hero" style={{ gridTemplateColumns: 'minmax(140px, 200px) 1fr' }}>
        <Cover src={r?.artwork_url} title={t.title} />
        <div>
          <div className="muted" style={{ marginBottom: 8 }}>Song{r && <> · track {t.number} on <Link to={`/release/${r.id}`}>{r.title}</Link></>}</div>
          <h1 className="hero-title">{t.title}</h1>
          <div style={{ fontSize: 20, fontWeight: 600, marginTop: 8 }}>{t.artist_credit ?? r?.artist_credit}</div>
          <div className="hero-meta"><span className="num">{fmtMs(t.duration_ms)}</span>{r?.year && <span>{r.year}</span>}<QuickRate type="track" id={t.id} /></div>
        </div>
      </div>
      <div style={{ margin: '22px 0' }}><LinkBar links={t.links} kind="track" name={t.title} artist={artistName} onEdit={() => setEditLinks(true)} /></div>
      <div className="row"><button className="btn primary" disabled={busy} onClick={genius}>Get credits from Genius</button><button className="btn" onClick={() => player.play([t.id], 0)}>Play</button><AddToPlaylist trackIds={[t.id]} label="Add to playlist" /><AddToList type="track" id={t.id} /><button className="btn" onClick={() => setEditing(true)}>Edit</button></div>
      <div className="two" style={{ marginTop: 28 }}>
        <div>
          {se && <iframe className="embed" title="SoundCloud player" src={se} height={166} style={{ marginBottom: 20 }} allow="autoplay" />}
          {ye && <iframe className="embed" title="YouTube player" src={ye} style={{ aspectRatio: '16/9', marginBottom: 20 }} allow="encrypted-media; picture-in-picture" allowFullScreen />}
          {feats.length > 0 && <><h2 className="h-sec">Featuring</h2><div className="row">{feats.map((a) => <Link key={a.id} className="link" to={`/artist/${a.id}`}>{a.name}</Link>)}</div></>}
          <h2 className="h-sec">Produced by</h2>
          {prods.length ? <div className="row">{prods.map((a) => <Link key={a.id} className="link" to={`/artist/${a.id}`}>{a.name}</Link>)}</div> : <div className="muted">No producer credits yet.</div>}
        </div>
        <div className="stack">
          <AnnotationPanel type="track" id={t.id} />
          <button className="btn danger" onClick={async () => { if (confirm(`Delete “${t.title}”?`)) { await remove('credits', (ix.creditsByTrack.get(t.id) ?? []).map((c) => c.id)); await remove('tracks', [t.id]); nav(r ? `/release/${r.id}` : '/library'); } }}>Delete song</button>
        </div>
      </div>
      {editLinks && <LinksEditor links={t.links} onClose={() => setEditLinks(false)} onSave={(links) => save({ links })} />}
      {editing && <TrackForm track={t} onClose={() => setEditing(false)} />}
    </div>
  );
}

function TrackForm({ track, onClose }: { track: Track; onClose: () => void }) {
  const st = useStore(); const { upsert, ix } = st;
  const [f, setF] = useState({ title: track.title, artist_credit: track.artist_credit ?? '', number: String(track.number ?? ''), disc: String(track.disc ?? '') });
  const [prods, setProds] = useState(() => trackArtists(ix, track.id, 'producer').map((a) => a.name));
  const [feats, setFeats] = useState(() => trackArtists(ix, track.id, 'featured').map((a) => a.name));
  return (
    <Modal title="Edit song" onClose={onClose}>
      <form className="form-grid" onSubmit={async (e) => {
        e.preventDefault();
        await upsert('tracks', [{ ...track, title: f.title.trim() || track.title, artist_credit: f.artist_credit || null, number: Number(f.number) || null, disc: Number(f.disc) || null, updated_at: now() }]);
        const gone = [...await st.setTrackCredits(track.id, 'producer', prods, { prune: false }), ...await st.setTrackCredits(track.id, 'featured', feats, { prune: false })];
        if (gone.length) await st.pruneArtists(gone);
        onClose();
      }}>
        <label className="full"><span className="label">Title</span><input className="input" style={{ width: '100%' }} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></label>
        <label className="full"><span className="label">Artist (if different from the release)</span><input className="input" style={{ width: '100%' }} value={f.artist_credit} onChange={(e) => setF({ ...f, artist_credit: e.target.value })} /></label>
        <div className="full"><span className="label">Featuring</span><PeopleInput value={feats} onChange={setFeats} placeholder="Add featured artist" /></div>
        <div className="full"><span className="label">Producers</span><PeopleInput value={prods} onChange={setProds} placeholder="Add producer" producersFirst /></div>
        <label><span className="label">Track number</span><input className="input num" style={{ width: '100%' }} value={f.number} onChange={(e) => setF({ ...f, number: e.target.value })} /></label>
        <label><span className="label">Disc</span><input className="input num" style={{ width: '100%' }} value={f.disc} onChange={(e) => setF({ ...f, disc: e.target.value })} /></label>
        <div className="full row"><span className="spacer" /><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary">Save changes</button></div>
      </form>
    </Modal>
  );
}
