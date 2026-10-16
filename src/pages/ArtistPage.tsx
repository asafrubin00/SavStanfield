import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { AddToList, AnnotationPanel, Cover, fmtDate, LinkBar, LinksEditor, Modal, QuickRate, ReleaseTile } from '../components/ui';
import { autoLinkArtist } from '../lib/enrich';
import { parseArtistCredit } from '../lib/importSheet';
import { appleArtistAlbums, appleSearchArtists, mbArtistGroups, mbSearchArtists, type AppleAlbum, type MBGroup } from '../lib/sources';
import { norm, useStore } from '../lib/store';
import { RELEASE_TYPES, type Artist, type Release, type Track } from '../lib/types';
import { now, uid } from '../lib/util';
import { linkQueue } from '../lib/queue';

export default function ArtistPage() {
  const { id } = useParams();
  const st = useStore();
  const { ix, data, upsert, say } = st;
  const nav = useNavigate();
  const a = ix.artists.get(id!);
  const [busy, setBusy] = useState('');
  const [editLinks, setEditLinks] = useState(false);
  const [editing, setEditing] = useState(false);
  const [disco, setDisco] = useState(false);
  const [merging, setMerging] = useState(false);
  const [bioOpen, setBioOpen] = useState(false);

  const credits = useMemo(() => ix.creditsByArtist.get(id!) ?? [], [ix, id]);
  const { discog, produced, appearances } = useMemo(() => {
    const discog: Release[] = []; const produced = new Map<string, { r: Release; tracks: Track[]; exec: boolean }>(); const appearances = new Map<string, { r?: Release; tracks: Track[] }>();
    const mine = new Set<string>();
    for (const c of credits) if (c.role === 'primary' && c.release_id) { const r = ix.releases.get(c.release_id); if (r && !mine.has(r.id)) { mine.add(r.id); discog.push(r); } }
    for (const c of credits) {
      if (c.role === 'exec_producer' && c.release_id) { const r = ix.releases.get(c.release_id); if (r) produced.set(r.id, { r, tracks: produced.get(r.id)?.tracks ?? [], exec: true }); }
      if (c.track_id) {
        const t = ix.tracks.get(c.track_id); if (!t) continue;
        const r = t.release_id ? ix.releases.get(t.release_id) : undefined;
        if (c.role === 'producer' && r) { const e = produced.get(r.id) ?? { r, tracks: [], exec: false }; e.tracks.push(t); produced.set(r.id, e); }
        if ((c.role === 'featured' || c.role === 'primary') && !(r && mine.has(r.id))) { const k = r?.id ?? t.id; const e = appearances.get(k) ?? { r, tracks: [] }; e.tracks.push(t); appearances.set(k, e); }
      }
    }
    discog.sort((x, y) => (x.date ?? `${x.year}`).localeCompare(y.date ?? `${y.year}`));
    return { discog, produced: [...produced.values()].sort((x, y) => (y.r.year ?? 0) - (x.r.year ?? 0)), appearances: [...appearances.values()] };
  }, [credits, ix]);

  if (!a) return <div className="empty">This artist isn't in your library. <Link to="/artists">All artists</Link></div>;
  const byType = new Map<string, Release[]>();
  for (const r of discog) (byType.get(r.type) ?? byType.set(r.type, []).get(r.type)!).push(r);
  const typeOrder = [...RELEASE_TYPES, ...[...byType.keys()].filter((t) => !RELEASE_TYPES.includes(t))].filter((t) => byType.has(t));
  const rated = discog.map((r) => ix.ann.get(`release:${r.id}`)?.rating).filter(Boolean) as number[];
  const avg = rated.length ? rated.reduce((s, x) => s + x, 0) / rated.length : null;
  const concerts = data.concerts.filter((c) => c.artist_id === a.id);
  const save = (patch: Partial<Artist>) => upsert('artists', [{ ...a, ...patch, updated_at: now() }]);

  async function quickLink() {
    setBusy('Looking up…');
    try {
      const res = await autoLinkArtist(a!); await save(res.patch);
      const failed = [...new Set(res.errors.map((e) => e.split(':')[0]))];
      say(`${res.found.length ? `Found: ${res.found.join(', ')}.` : 'No confident matches — add links by hand.'}${failed.length ? ` Couldn't reach ${failed.join(', ')}.` : ''}`);
    }
    catch (e) { say((e as Error).message); } finally { setBusy(''); }
  }

  return (
    <div>
      <div className="hero">
        <Cover src={a.image_url} title={a.name} eager />
        <div>
          <div className="muted" style={{ marginBottom: 8 }}>{a.is_producer ? 'Artist and producer' : 'Artist'}{a.aliases.length ? ` · also ${a.aliases.join(', ')}` : ''}</div>
          <h1 className="hero-name">{a.name}</h1>
          <div className="hero-meta">
            <span>{discog.length} release{discog.length === 1 ? '' : 's'}</span>
            {produced.length > 0 && <span>{produced.length} produced</span>}
            {avg !== null && <span className="num">Your average {avg.toFixed(1)} ★ across {rated.length}</span>}
            <QuickRate type="artist" id={a.id} />
          </div>
        </div>
      </div>
      <div style={{ margin: '22px 0' }}><LinkBar links={a.links} kind="artist" name={a.name} onEdit={() => setEditLinks(true)} /></div>
      <div className="row">
        <button className="btn primary" disabled={!!busy} onClick={quickLink}>Find links &amp; photo</button>
        <button className="btn" onClick={() => setDisco(true)}>Import discography</button>
        <button className="btn" disabled={!discog.some((r) => !r.links.apple)} onClick={() => { linkQueue.add('release', discog.filter((r) => !r.links.apple || !r.artwork_url).map((r) => r.id)); say('Linking releases in the background'); }}>Link all releases</button>
        <AddToList type="artist" id={a.id} />
        <button className="btn" onClick={() => setEditing(true)}>Edit</button>
        <button className="btn" onClick={() => setMerging(true)}>Merge…</button>
        {busy && <span className="small muted">{busy}</span>}
      </div>

      <div className="two" style={{ marginTop: 28 }}>
        <div>
          {a.bio && <p style={{ maxWidth: '68ch', marginTop: 0 }}>{bioOpen || a.bio.length < 420 ? a.bio : `${a.bio.slice(0, 420)}… `}{a.bio.length >= 420 && <button className="btn sm ghost" onClick={() => setBioOpen(!bioOpen)}>{bioOpen ? 'Less' : 'More'}</button>}</p>}
          {!discog.length && <div className="empty">No releases yet. <br /><button className="btn" onClick={() => setDisco(true)}>Import discography</button></div>}
          {typeOrder.map((t) => (
            <section key={t}>
              <h2 className="h-sec">{t === 'Album' ? 'Albums' : t === 'Mixtape' ? 'Mixtapes' : t === 'EP' ? 'EPs' : t === 'Single' ? 'Singles' : t} <span className="muted">{byType.get(t)!.length}</span></h2>
              <div className="grid tight">{byType.get(t)!.map((r) => <ReleaseTile key={r.id} r={r} showArtist={r.artist_credit !== a.name} />)}</div>
            </section>
          ))}
          {produced.length > 0 && <section>
            <h2 className="h-sec">Production <span className="muted">{produced.length}</span></h2>
            <div className="table-wrap"><table className="table"><tbody>{produced.map(({ r, tracks, exec }) => (
              <tr key={r.id}><td className="thumb"><Cover src={r.artwork_url} title={r.title} size={36} /></td>
                <td><Link to={`/release/${r.id}`} style={{ fontWeight: 600 }}>{r.title}</Link><div className="small muted">{r.artist_credit} · {r.year}</div></td>
                <td className="small">{exec && <div>Executive producer</div>}{tracks.map((t, i) => <span key={t.id}>{i ? ', ' : ''}<Link to={`/track/${t.id}`}>{t.title}</Link></span>)}</td></tr>))}</tbody></table></div>
          </section>}
          {appearances.length > 0 && <section>
            <h2 className="h-sec">Appearances <span className="muted">{appearances.length}</span></h2>
            <div className="table-wrap"><table className="table"><tbody>{appearances.map(({ r, tracks }) => (
              <tr key={r?.id ?? tracks[0].id}><td className="thumb"><Cover src={r?.artwork_url} title={r?.title ?? tracks[0].title} size={36} /></td>
                <td>{tracks.map((t, i) => <span key={t.id}>{i ? ', ' : ''}<Link to={`/track/${t.id}`} style={{ fontWeight: 600 }}>{t.title}</Link></span>)}
                  {r && <div className="small muted">on <Link to={`/release/${r.id}`}>{r.title}</Link> · {r.artist_credit} · {r.year}</div>}</td></tr>))}</tbody></table></div>
          </section>}
          {concerts.length > 0 && <section>
            <h2 className="h-sec">Seen live</h2>
            {concerts.map((c) => <div key={c.id} className="row" style={{ padding: '4px 0' }}><span className="num muted">{fmtDate(c.date)}</span><strong>{c.tour}</strong><span className="muted">{c.venue}, {c.location}</span></div>)}
          </section>}
        </div>
        <div className="stack">
          <AnnotationPanel type="artist" id={a.id} />
          <button className="btn danger" onClick={async () => { if (confirm(`Delete ${a.name}? Their releases stay in your library.`)) { await st.deleteArtist(a.id); nav('/artists'); } }}>Delete artist</button>
        </div>
      </div>

      {editLinks && <LinksEditor links={a.links} onClose={() => setEditLinks(false)} onSave={(links) => save({ links })} />}
      {editing && <ArtistForm artist={a} onClose={() => setEditing(false)} />}
      {disco && <DiscographyImporter artist={a} onClose={() => setDisco(false)} />}
      {merging && <MergeArtist artist={a} onClose={() => setMerging(false)} />}
    </div>
  );
}

export function ArtistForm({ artist, onClose }: { artist?: Artist; onClose: () => void }) {
  const { upsert } = useStore();
  const nav = useNavigate();
  const [f, setF] = useState({ name: artist?.name ?? '', aliases: artist?.aliases.join(', ') ?? '', image_url: artist?.image_url ?? '', bio: artist?.bio ?? '', is_producer: artist?.is_producer ?? false });
  return (
    <Modal title={artist ? 'Edit artist' : 'Add an artist'} onClose={onClose}>
      <form className="form-grid" onSubmit={async (e) => {
        e.preventDefault(); if (!f.name.trim()) return;
        const a: Artist = { ...(artist ?? { id: uid(), links: {}, ext: {}, created_at: now() }), name: f.name.trim(), aliases: f.aliases.split(',').map((s) => s.trim()).filter(Boolean), image_url: f.image_url || null, bio: f.bio || null, is_producer: f.is_producer, updated_at: now() } as Artist;
        await upsert('artists', [a]); onClose(); if (!artist) nav(`/artist/${a.id}`);
      }}>
        <label className="full"><span className="label">Name</span><input className="input" style={{ width: '100%' }} required autoFocus value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
        <label className="full"><span className="label">Other names, comma-separated (helps matching)</span><input className="input" style={{ width: '100%' }} value={f.aliases} onChange={(e) => setF({ ...f, aliases: e.target.value })} /></label>
        <label className="full"><span className="label">Photo URL</span><input className="input" style={{ width: '100%' }} value={f.image_url} onChange={(e) => setF({ ...f, image_url: e.target.value })} /></label>
        <label className="full"><span className="label">Bio</span><textarea className="textarea" value={f.bio} onChange={(e) => setF({ ...f, bio: e.target.value })} /></label>
        <label className="row full"><input type="checkbox" checked={f.is_producer} onChange={(e) => setF({ ...f, is_producer: e.target.checked })} /> Show under producers</label>
        <div className="full row"><span className="spacer" /><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary">{artist ? 'Save changes' : 'Add artist'}</button></div>
      </form>
    </Modal>
  );
}

function MergeArtist({ artist, onClose }: { artist: Artist; onClose: () => void }) {
  const { data, ix, upsert, remove, say } = useStore();
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const opts = q.length < 2 ? [] : data.artists.filter((x) => x.id !== artist.id && norm(x.name).includes(norm(q))).slice(0, 10);
  async function merge(into: Artist) {
    const creds = (ix.creditsByArtist.get(artist.id) ?? []).map((c) => ({ ...c, artist_id: into.id }));
    await upsert('credits', creds);
    await upsert('artists', [{ ...into, aliases: [...new Set([...into.aliases, artist.name, ...artist.aliases])], is_producer: into.is_producer || artist.is_producer, links: { ...artist.links, ...into.links }, image_url: into.image_url ?? artist.image_url, updated_at: now() }]);
    const ann = ix.ann.get(`artist:${artist.id}`);
    if (ann && !ix.ann.get(`artist:${into.id}`)) await upsert('annotations', [{ ...ann, id: `artist:${into.id}`, entity_id: into.id }]);
    await upsert('list_items', data.list_items.filter((i) => i.entity_id === artist.id).map((i) => ({ ...i, entity_id: into.id })));
    await upsert('concerts', data.concerts.filter((c) => c.artist_id === artist.id).map((c) => ({ ...c, artist_id: into.id })));
    if (ann) await remove('annotations', [ann.id]);
    await remove('artists', [artist.id]);
    say(`Merged ${artist.name} into ${into.name}`); onClose(); nav(`/artist/${into.id}`);
  }
  return (
    <Modal title={`Merge ${artist.name} into…`} onClose={onClose}>
      <p className="small muted" style={{ marginTop: -8 }}>Use this for duplicates. Everything credited to {artist.name} moves to the artist you pick, and “{artist.name}” becomes one of their other names.</p>
      <input className="input" style={{ width: '100%' }} autoFocus placeholder="Search artists" value={q} onChange={(e) => setQ(e.target.value)} />
      <div style={{ marginTop: 10 }}>{opts.map((o) => <button key={o.id} className="dd-item btn ghost" style={{ width: '100%', justifyContent: 'flex-start' }} onClick={() => merge(o)}><Cover src={o.image_url} title={o.name} size={32} round />{o.name}</button>)}</div>
    </Modal>
  );
}

// ——— Discography import from Apple Music + MusicBrainz ———
interface Row { key: string; title: string; credit: string; date?: string; type: string; artwork?: string; apple?: AppleAlbum; mb?: MBGroup; have?: Release }
function mbType(g: MBGroup) {
  if (g.secondary.includes('Mixtape/Street')) return 'Mixtape';
  if (g.secondary.includes('Compilation')) return 'Compilation';
  if (g.secondary.includes('Live')) return 'Live';
  if (g.secondary.includes('Soundtrack')) return 'Soundtrack';
  if (g.secondary.includes('Remix')) return 'Other';
  return g.type === 'Album' ? 'Album' : g.type === 'EP' ? 'EP' : g.type === 'Single' ? 'Single' : 'Other';
}

function DiscographyImporter({ artist, onClose }: { artist: Artist; onClose: () => void }) {
  const st = useStore();
  const { ix, upsert, say } = st;
  const [rows, setRows] = useState<Row[] | null>(null);
  const [status, setStatus] = useState('');
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [types, setTypes] = useState<Set<string>>(new Set(['Album', 'Mixtape', 'EP', 'Compilation', 'Soundtrack', 'Live', 'Other']));
  const [mbChoices, setMbChoices] = useState<{ id: string; name: string; disambiguation?: string; country?: string }[] | null>(null);

  async function load(mbidOverride?: string) {
    setStatus('Finding the artist on Apple Music and MusicBrainz…'); setMbChoices(null);
    const ext = { ...artist.ext }; const links = { ...artist.links };
    try {
      if (!ext.apple_id) { const m = (await appleSearchArtists(artist.name)).find((x) => norm(x.name) === norm(artist.name)); if (m) { ext.apple_id = m.id; links.apple ??= m.url; } }
      if (mbidOverride) ext.mbid = mbidOverride;
      if (!ext.mbid) {
        const c = (await mbSearchArtists(artist.name)).filter((x) => norm(x.name) === norm(artist.name));
        if (c.length === 1) ext.mbid = c[0].id; else if (c.length > 1) setMbChoices(c);
      }
      if (ext.apple_id !== artist.ext.apple_id || ext.mbid !== artist.ext.mbid) await upsert('artists', [{ ...artist, ext, links, updated_at: now() }]);
      setStatus('Loading releases…');
      const [apple, mb] = await Promise.all([
        ext.apple_id ? appleArtistAlbums(ext.apple_id as number).catch(() => []) : [],
        ext.mbid ? mbArtistGroups(ext.mbid).catch(() => []) : [],
      ]);
      const mine = (ix.creditsByArtist.get(artist.id) ?? []).filter((c) => c.role === 'primary' && c.release_id).map((c) => ix.releases.get(c.release_id!)!).filter(Boolean);
      const haveBy = new Map(mine.map((r) => [norm(r.title), r]));
      const map = new Map<string, Row>();
      for (const g of mb) {
        const k = norm(g.title);
        map.set(k, { key: k, title: g.title, credit: g.artist || artist.name, date: g.date, type: mbType(g), mb: g, have: haveBy.get(k) });
      }
      for (const al of apple) {
        const k = norm(al.title); const e = map.get(k);
        if (e) { e.apple = al; e.artwork = al.artwork; e.date ??= al.date; if (e.type === 'Other') e.type = al.kind; }
        else map.set(k, { key: k, title: al.title, credit: al.artist, date: al.date, type: al.kind, artwork: al.artwork, apple: al, have: haveBy.get(k) });
      }
      const list = [...map.values()].sort((x, y) => (x.date ?? '9').localeCompare(y.date ?? '9'));
      setRows(list);
      setSel(new Set(list.filter((r) => !r.have && ['Album', 'Mixtape', 'EP'].includes(r.type)).map((r) => r.key)));
      setStatus(!apple.length && !mb.length ? 'Nothing found. Check the artist name, or add releases by hand.' : `${apple.length} from Apple Music, ${mb.length} from MusicBrainz`);
    } catch (e) { setStatus((e as Error).message); }
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, []);

  async function importSel() {
    const chosen = rows!.filter((r) => sel.has(r.key) && !r.have);
    const rels: Release[] = chosen.map((r) => ({
      id: uid(), title: r.title, type: r.type, date: r.date && r.date.length === 10 ? r.date : null, year: r.date ? Number(r.date.slice(0, 4)) : null,
      artist_credit: r.credit, artwork_url: r.artwork ?? null, source: 'import', created_at: now(), updated_at: now(),
      links: { ...(r.apple ? { apple: r.apple.url } : {}), ...(r.mb ? { musicbrainz: `https://musicbrainz.org/release-group/${r.mb.id}` } : {}) },
      ext: { ...(r.apple ? { apple_id: r.apple.id } : {}), ...(r.mb ? { mbid: r.mb.id } : {}) },
    }));
    await upsert('releases', rels);
    rels.forEach((r) => {
      st.creditArtist(artist.id, { release_id: r.id }, 'primary', 0);
      if (norm(r.artist_credit!) !== norm(artist.name)) {
        const { names } = parseArtistCredit(r.artist_credit!, true);
        names.filter((n) => norm(n) !== norm(artist.name)).forEach((n, i) => st.creditArtist(st.ensureArtist(n).artist.id, { release_id: r.id }, 'primary', i + 1));
      }
    });
    linkQueue.add('release', rels.map((r) => r.id));
    say(`Added ${rels.length} releases — fetching links in the background`); onClose();
  }

  const visible = rows?.filter((r) => types.has(r.type) || (r.type === 'Single' && types.has('Single'))) ?? [];
  const allTypes = [...new Set(rows?.map((r) => r.type) ?? [])];
  return (
    <Modal title={`Import ${artist.name}'s discography`} onClose={onClose} wide>
      <div className="small muted" style={{ marginBottom: 12 }}>{status}</div>
      {mbChoices && <div className="panel" style={{ marginBottom: 12 }}>
        <div className="label">More than one “{artist.name}” on MusicBrainz — which one?</div>
        {mbChoices.map((c) => <button key={c.id} className="btn sm" style={{ margin: 3 }} onClick={() => load(c.id)}>{c.name}{c.disambiguation ? ` (${c.disambiguation})` : ''}{c.country ? ` · ${c.country}` : ''}</button>)}
      </div>}
      {rows && <>
        <div className="row" style={{ marginBottom: 10 }}>
          {allTypes.map((t) => <button key={t} className={`chip${types.has(t) ? ' on' : ''}`} onClick={() => { const n = new Set(types); if (n.has(t)) n.delete(t); else n.add(t); setTypes(n); }}>{t} {rows.filter((r) => r.type === t).length}</button>)}
          <span className="spacer" />
          <button className="btn sm" onClick={() => setSel(new Set(visible.filter((r) => !r.have).map((r) => r.key)))}>Select all shown</button>
          <button className="btn sm" onClick={() => setSel(new Set())}>Select none</button>
        </div>
        <div style={{ maxHeight: '55vh', overflowY: 'auto' }}><table className="table"><tbody>{visible.map((r) => (
          <tr key={r.key} style={{ opacity: r.have ? .55 : 1 }}>
            <td style={{ width: 30 }}><input type="checkbox" disabled={!!r.have} checked={sel.has(r.key)} aria-label={`Select ${r.title}`} onChange={(e) => { const n = new Set(sel); if (e.target.checked) n.add(r.key); else n.delete(r.key); setSel(n); }} /></td>
            <td className="thumb"><Cover src={r.artwork} title={r.title} size={36} /></td>
            <td><strong>{r.title}</strong>{r.credit !== artist.name && <div className="small muted">{r.credit}</div>}</td>
            <td className="muted">{r.type}</td><td className="num muted">{r.date}</td>
            <td className="small muted">{[r.apple && 'Apple', r.mb && 'MB'].filter(Boolean).join(' + ')}</td>
            <td className="small">{r.have ? <Link to={`/release/${r.have.id}`}>In library</Link> : ''}</td>
          </tr>))}</tbody></table></div>
        <div className="row" style={{ marginTop: 14 }}><span className="spacer" /><button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!sel.size} onClick={importSel}>Add {sel.size} to library</button></div>
      </>}
    </Modal>
  );
}
