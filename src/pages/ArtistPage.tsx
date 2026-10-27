import { fetchMembers, groupMembers, groupsOf, linkMembers, years } from '../lib/members';
import PeopleInput from '../components/PeopleInput';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { AddToList, AnnotationPanel, Cover, Credits, fmtDate, LinkBar, LinksEditor, Modal, QuickRate, ReleaseTile } from '../components/ui';
import { autoLinkArtist } from '../lib/enrich';
import { parseArtistCredit } from '../lib/importSheet';
import { appleArtistAlbums, appleSearchArtists, mbArtistGroups, mbSearchArtists, type AppleAlbum, type MBGroup } from '../lib/sources';
import { artistLabels, norm, shownInArtists, trackArtists, useStore } from '../lib/store';
import { SortSelect, usePref, flip } from '../components/controls';
import { type Artist, type Release, type Track } from '../lib/types';
import { now, uid } from '../lib/util';
import { linkQueue } from '../lib/queue';

/** Artist page sections, in order. Types not listed under SHOWN or HIDDEN go in "Other". */
const SHOWN: [string, string[]][] = [
  ['Albums', ['Album']], ['Collaborations', ['Collaboration']], ['Deluxe editions', ['Deluxe']], ['Mixtapes', ['Mixtape']],
  ['EPs', ['EP']], ['Compilations', ['Compilation', 'Greatest Hits']], ['Soundtracks', ['Soundtrack']],
];
const HIDDEN: [string, string[]][] = [['Singles', ['Single']], ['Leaks', ['Leak', 'Leak Compilation', 'Unreleased Album']], ['Appearances', ['Guest Appearance']]];

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
  const [featBusy, setFeatBusy] = useState(false);
  const [moreOpen, setMoreOpen] = usePref('artist.moreOpen', false);
  const cur = ix.artists.get(id!);
  const members = cur ? linkMembers(ix, groupMembers(cur)) : [];
  const memberOf = cur ? groupsOf(ix, cur.id) : [];
  const splitNames = (ix.artists.get(id!)?.name ?? '').split(/\s*(?:&|,|\bx\b|\band\b|\bfeat\.?|\bft\.?|\bwith\b)\s*/i).map((s) => s.trim()).filter(Boolean);
  const [merging, setMerging] = useState(false);
  const [bioOpen, setBioOpen] = useState(false);
  const [discSort, setDiscSort] = usePref('artist.discSort', 'newest');
  const [discRev, setDiscRev] = usePref('artist.discRev', false);
  const [grouped, setGrouped] = usePref('artist.grouped', true);
  const [showCounts, setShowCounts] = usePref('artists.showCounts', false);

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
    const when = (x: { r?: Release }) => x.r?.date ?? `${x.r?.year ?? ''}`;
    return { discog, produced: [...produced.values()].sort((x, y) => (y.r.year ?? 0) - (x.r.year ?? 0)), appearances: [...appearances.values()].sort((x, y) => when(y).localeCompare(when(x))) };
  }, [credits, ix]);

  if (!a) return <div className="empty">This artist isn't in your library. <Link to="/artists">All artists</Link></div>;
  const day = (r: Release) => r.date ?? `${r.year ?? 0}`;
  const rt = (r: Release) => ix.ann.get(`release:${r.id}`)?.rating ?? 0;
  const sorter: Record<string, (x: Release, y: Release) => number> = {
    newest: (x, y) => day(y).localeCompare(day(x)), oldest: (x, y) => day(x).localeCompare(day(y)),
    rating: (x, y) => rt(y) - rt(x) || day(y).localeCompare(day(x)), title: (x, y) => x.title.localeCompare(y.title),
  };
  const sorted = flip([...discog].sort(sorter[discSort] ?? sorter.newest), discRev, (r) => (discSort === 'rating' ? rt(r) > 0 : true));
  // Main sections in a fixed order; singles, leaks and guest appearances sit behind a reveal
  const sectionOf = (t: string) => SHOWN.find(([, ts]) => ts.includes(t))?.[0] ?? (HIDDEN.flatMap(([, ts]) => ts).includes(t) ? null : 'Other');
  const byType = new Map<string, Release[]>();
  for (const r of sorted) {
    const sec = sectionOf(r.type); if (!sec) continue;
    const k = grouped ? sec : 'All releases';
    (byType.get(k) ?? byType.set(k, []).get(k)!).push(r);
  }
  const hiddenRel = (types: string[]) => sorted.filter((r) => types.includes(r.type));
  const labelsHere = artistLabels(ix, a.id);
  const typeOrder = grouped ? [...SHOWN.map(([n]) => n), 'Other'].filter((t) => byType.has(t)) : [...byType.keys()];
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
          {memberOf.length > 0 && <div style={{ marginTop: 10, fontSize: 17 }}><span className="muted">Member of </span>{memberOf.map(({ group, m }, i) => <span key={group.id}>{i ? ', ' : ''}<Link to={`/artist/${group.id}`} style={{ fontWeight: 600 }}>{group.name}</Link>{years(m) && <span className="muted small"> ({years(m)})</span>}</span>)}</div>}
          <div className="hero-meta">
            {showCounts && <span>{discog.length} release{discog.length === 1 ? '' : 's'}</span>}
            {showCounts && produced.length > 0 && <span>{produced.length} produced</span>}
            {ix.lastByArtist.get(a.id) && <span>Latest release {fmtDate(ix.lastByArtist.get(a.id))}</span>}
            {avg !== null && <span className="num">Your average {avg.toFixed(1)} ★ across {rated.length}</span>}
            <QuickRate type="artist" id={a.id} />
          </div>
          {labelsHere.length > 0 && <div className="row" style={{ marginTop: 12, gap: 6 }}>
            {labelsHere.slice(0, 8).map(({ label, manual, n }) => <Link key={label.id} className="chip" to={`/label/${label.id}`} title={manual ? 'Set by you' : `${n} release${n === 1 ? '' : 's'}`}>{label.name}</Link>)}
          </div>}
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
        <button className="btn" disabled={!!busy} title="Looks up band members on MusicBrainz" onClick={async () => {
          if (a.ext.members_manual && !confirm('You’ve edited the members by hand. Replace them with what MusicBrainz has?')) return;
          setBusy('Looking up members…');
          try {
            const res = await fetchMembers(ix, a);
            await save({ ext: { ...a.ext, mbid: a.ext.mbid ?? res.mbid, mb_type: res.type ?? a.ext.mb_type, members_at: now(), ...(res.members ? { members: res.members, members_manual: false } : {}) } });
            say(res.members ? `${res.members.length} members found` : res.type && res.type !== 'Group' ? `MusicBrainz lists ${a.name} as a ${res.type.toLowerCase()}, not a group` : 'No members found on MusicBrainz');
          } catch (e) { say((e as Error).message); } finally { setBusy(''); }
        }}>Find members</button>
        {splitNames.length > 1 && <button className="btn" title={`Credit everything to ${splitNames.join(' and ')} separately`} onClick={async () => {
          if (!confirm(`Split “${a.name}” into ${splitNames.join(' + ')}? Everything credited to it goes to each of them, and this joint entry is removed.`)) return;
          const parts = splitNames.map((n) => st.ensureArtist(n).artist);
          await st.splitArtist(a, parts); st.say(`Split into ${splitNames.join(' + ')}`); nav(`/artist/${parts[0].id}`);
        }}>Split…</button>}
        <select className="select" value={(a.ext.show_in_artists as string) ?? ''} onChange={(e) => void save({ ext: { ...a.ext, show_in_artists: e.target.value || undefined } })} aria-label="Show in Artists" title="Whether this person appears on the Artists page">
          <option value="">Artists page: auto ({shownInArtists(ix, { ...a, ext: { ...a.ext, show_in_artists: undefined } }) ? 'shown' : 'hidden'})</option><option value="always">Artists page: always</option><option value="never">Artists page: never</option></select>
        <button className="btn" disabled={featBusy} title="Looks for “feat. / ft. / with …” this artist in every song title" onClick={async () => { setFeatBusy(true); try { const n = await st.findFeaturesFor(a); st.say(n ? `Found ${n} new feature${n > 1 ? 's' : ''}` : 'No new features found'); } catch (e) { st.say((e as Error).message); } finally { setFeatBusy(false); } }}>{featBusy ? 'Searching…' : 'Find features'}</button>
        {busy && <span className="small muted">{busy}</span>}
      </div>

      <div className="two" style={{ marginTop: 28 }}>
        <div>
          {a.bio && <p style={{ maxWidth: '68ch', marginTop: 0 }}>{bioOpen || a.bio.length < 420 ? a.bio : `${a.bio.slice(0, 420)}… `}{a.bio.length >= 420 && <button className="btn sm ghost" onClick={() => setBioOpen(!bioOpen)}>{bioOpen ? 'Less' : 'More'}</button>}</p>}
          {discog.length > 0 && <div className="row" style={{ marginTop: 8 }}>
            <SortSelect value={discSort} onChange={(v) => { setDiscSort(v); setDiscRev(false); }} rev={discRev} onRev={setDiscRev} options={[['newest', 'Release date'], ['rating', 'Your rating'], ['title', 'Title A–Z']]} />
            <label className="row"><input type="checkbox" checked={grouped} onChange={(e) => setGrouped(e.target.checked)} /> Group by type</label>
            <label className="row"><input type="checkbox" checked={showCounts} onChange={(e) => setShowCounts(e.target.checked)} /> Show counts</label>
          </div>}
          {!discog.length && <div className="empty">No releases yet. <br /><button className="btn" onClick={() => setDisco(true)}>Import discography</button></div>}
          {typeOrder.map((t) => (
            <section key={t}>
              <h2 className="h-sec">{t} {showCounts && <span className="muted">{byType.get(t)!.length}</span>}</h2>
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
          {(() => {
            const singles = hiddenRel(HIDDEN[0][1]); const leaks = hiddenRel(HIDDEN[1][1]); const guest = hiddenRel(HIDDEN[2][1]);
            const n = singles.length + leaks.length + guest.length + appearances.length;
            if (!n) return null;
            const relRows = (rs: Release[]) => rs.map((r) => (
              <tr key={r.id}><td className="thumb"><Link to={`/release/${r.id}`}><Cover src={r.artwork_url} title={r.title} size={36} /></Link></td>
                <td><Link to={`/release/${r.id}`} style={{ fontWeight: 600 }}>{r.title}</Link><div className="small muted">{r.artist_credit !== a.name && <><Credits release={r} /> · </>}{r.date ? fmtDate(r.date) : r.year}</div></td>
                <td style={{ textAlign: 'right' }}><QuickRate type="release" id={r.id} /></td></tr>));
            const what = [singles.length && 'singles', leaks.length && 'leaks', (guest.length || appearances.length) && 'appearances'].filter(Boolean) as string[];
            return <section>
              <button className="btn" style={{ marginTop: 28 }} aria-expanded={moreOpen} onClick={() => setMoreOpen(!moreOpen)}>{moreOpen ? 'Hide' : 'Show'} {what.join(', ').replace(/, ([^,]*)$/, ' and $1')} ({n})</button>
              {moreOpen && <>
                {singles.length > 0 && <><h2 className="h-sec">Singles <span className="muted">{singles.length}</span></h2><div className="table-wrap"><table className="table"><tbody>{relRows(singles)}</tbody></table></div></>}
                {leaks.length > 0 && <><h2 className="h-sec">Leaks <span className="muted">{leaks.length}</span></h2><div className="table-wrap"><table className="table"><tbody>{relRows(leaks)}</tbody></table></div></>}
                {(guest.length > 0 || appearances.length > 0) && <>
                  <h2 className="h-sec">Appearances <span className="muted">{guest.length + appearances.length}</span></h2>
                  <div className="table-wrap"><table className="table"><tbody>{relRows(guest)}{appearances.map(({ r, tracks }) => (
                    <tr key={r?.id ?? tracks[0].id}><td className="thumb"><Cover src={r?.artwork_url} title={r?.title ?? tracks[0].title} size={36} /></td>
                      <td>{tracks.map((t, i) => <span key={t.id}>{i ? ', ' : ''}<Link to={`/track/${t.id}`} style={{ fontWeight: 600 }}>{t.title}</Link><button className="btn sm ghost" style={{ padding: '0 4px' }} title={`Not ${a.name} — remove this appearance`} aria-label={`Remove ${a.name} from ${t.title}`} onClick={() => void st.setTrackCredits(t.id, 'featured', trackArtists(ix, t.id, 'featured').filter((x) => x.id !== a.id).map((x) => x.name))}>×</button></span>)}
                        {r && <div className="small muted">on <Link to={`/release/${r.id}`}>{r.title}</Link> · <Credits release={r} /> · {r.year}</div>}</td><td /></tr>))}</tbody></table></div>
                </>}
              </>}
            </section>;
          })()}
          {concerts.length > 0 && <section>
            <h2 className="h-sec">Seen live</h2>
            {concerts.map((c) => <div key={c.id} className="row" style={{ padding: '4px 0' }}><span className="num muted">{fmtDate(c.date)}</span><strong>{c.tour}</strong><span className="muted">{c.venue}, {c.location}</span></div>)}
          </section>}
        </div>
        <div className="stack">
          {(members.length > 0 || a.ext.mb_type === 'Group') && <div className="panel">
            <div className="row" style={{ marginBottom: 6 }}><span className="label" style={{ margin: 0 }}>Members</span><span className="spacer" />{a.ext.members_manual ? <span className="small muted" title="Set by hand — automatic lookups leave it alone">edited</span> : null}</div>
            {members.map((m, i) => { const ma = m.id ? ix.artists.get(m.id) : undefined; return (
              <div key={`${m.name}${i}`} className="row" style={{ padding: '4px 0', flexWrap: 'nowrap', opacity: m.end ? 0.7 : 1 }}>
                <Cover src={ma?.image_url} title={m.name} size={34} round />
                <span style={{ minWidth: 0, flex: 1 }}>{ma ? <Link to={`/artist/${ma.id}`} style={{ fontWeight: 600 }}>{ma.name}</Link> : <span>{m.name}</span>}
                  {years(m) && <div className="small muted">{years(m)}{m.end ? ' · former' : ''}</div>}</span>
                {!ma && <button className="btn sm ghost" title={`Add ${m.name} to your library`} aria-label={`Add ${m.name} to library`} onClick={async () => {
                  const { artist: na } = st.ensureArtist(m.name, { ext: m.mbid ? { mbid: m.mbid } : {} });
                  await st.upsert('artists', [{ ...a, ext: { ...a.ext, members: members.map((x, j) => (j === i ? { ...x, id: na.id } : x)) }, updated_at: now() }]);
                  void st.findFeaturesFor(na); st.say(`Added ${m.name}`);
                }}>+</button>}
              </div>); })}
            {!members.length && <div className="small muted">No members found.</div>}
          </div>}
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
  const { upsert, ix, setArtistLabels, findFeaturesFor, say } = useStore();
  const nav = useNavigate();
  const manualLabels = artist ? (ix.artistLabelsByArtist.get(artist.id) ?? []).map((x) => ix.labels.get(x.label_id)?.name).filter(Boolean).join(', ') : '';
  const [labels, setLabels] = useState(manualLabels);
  const [f, setF] = useState({ name: artist?.name ?? '', aliases: artist?.aliases.join(', ') ?? '', image_url: artist?.image_url ?? '', bio: artist?.bio ?? '', is_producer: artist?.is_producer ?? false });
  const oldMembers = artist ? groupMembers(artist) : [];
  const [members, setMembers] = useState(() => oldMembers.map((m) => (m.id ? ix.artists.get(m.id)?.name ?? m.name : m.name)));
  return (
    <Modal title={artist ? 'Edit artist' : 'Add an artist'} onClose={onClose}>
      <form className="form-grid" onSubmit={async (e) => {
        e.preventDefault(); if (!f.name.trim()) return;
        const before = oldMembers.map((m) => (m.id ? ix.artists.get(m.id)?.name ?? m.name : m.name));
        const membersChanged = members.join('|') !== before.join('|');
        // Keep the years we already had for anyone still listed; anything typed by hand is never overwritten by a lookup
        const nextMembers = membersChanged ? linkMembers(ix, members.map((n) => oldMembers.find((m) => norm(m.name) === norm(n) || (m.id && norm(ix.artists.get(m.id)?.name ?? '') === norm(n))) ?? { name: n })) : oldMembers;
        const baseExt = (artist?.ext ?? {}) as Artist['ext'];
        const ext = membersChanged ? { ...baseExt, members: nextMembers, members_manual: true } as Artist['ext'] : baseExt;
        const a: Artist = { ...(artist ?? { id: uid(), links: {}, ext: {}, created_at: now() }), ext, name: f.name.trim(), aliases: f.aliases.split(',').map((s) => s.trim()).filter(Boolean), image_url: f.image_url || null, bio: f.bio || null, is_producer: f.is_producer, updated_at: now() } as Artist;
        await upsert('artists', [a]);
        if (labels !== manualLabels) await setArtistLabels(a.id, labels.split(','));
        onClose(); if (!artist) { nav(`/artist/${a.id}`); void findFeaturesFor(a).then((n) => n && say(`Found ${n} feature${n > 1 ? 's' : ''} for ${a.name}`)).catch(() => undefined); }
      }}>
        <label className="full"><span className="label">Name</span><input className="input" style={{ width: '100%' }} required autoFocus value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
        <label className="full"><span className="label">Other names, comma-separated (helps matching)</span><input className="input" style={{ width: '100%' }} value={f.aliases} onChange={(e) => setF({ ...f, aliases: e.target.value })} /></label>
        <label className="full"><span className="label">Labels they're signed to, comma-separated (labels from their releases show up automatically)</span><input className="input" style={{ width: '100%' }} value={labels} onChange={(e) => setLabels(e.target.value)} /></label>
        <div className="full"><span className="label">Members (for groups) — type a name and press Enter</span><PeopleInput value={members} onChange={setMembers} placeholder="Add a member" /></div>
        <label className="full"><span className="label">Photo URL</span><input className="input" style={{ width: '100%' }} value={f.image_url} onChange={(e) => setF({ ...f, image_url: e.target.value })} /></label>
        <label className="full"><span className="label">Bio</span><textarea className="textarea" value={f.bio} onChange={(e) => setF({ ...f, bio: e.target.value })} /></label>
        <label className="row full"><input type="checkbox" checked={f.is_producer} onChange={(e) => setF({ ...f, is_producer: e.target.checked })} /> Show under producers</label>
        <div className="full row"><span className="spacer" /><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary">{artist ? 'Save changes' : 'Add artist'}</button></div>
      </form>
    </Modal>
  );
}

function MergeArtist({ artist, onClose }: { artist: Artist; onClose: () => void }) {
  const { data, mergeArtists, say } = useStore();
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const opts = q.length < 2 ? [] : data.artists.filter((x) => x.id !== artist.id && norm(x.name).includes(norm(q))).slice(0, 10);
  async function merge(into: Artist) {
    await mergeArtists(artist, into);
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
