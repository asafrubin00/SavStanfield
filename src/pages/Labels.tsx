import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { MultiSelect, SortSelect, usePref, flip } from '../components/controls';
import { AddToList, OldNotes, PageKicker, Cover, fmtDate, LinkBar, LinksEditor, Modal, ReleaseTile } from '../components/ui';
import { linkQueue } from '../lib/queue';
import { norm, useStore, type Index } from '../lib/store';
import type { Label, Release } from '../lib/types';
import { now, uid } from '../lib/util';

/** Releases on a label, and the artists behind them (plus anyone you've marked as signed). */
function labelContents(ix: Index, labelId: string) {
  const releases = (ix.releaseLabelsByLabel.get(labelId) ?? []).map((x) => ix.releases.get(x.release_id)).filter(Boolean) as Release[];
  const roster = new Map<string, { id: string; n: number; signed: boolean }>();
  for (const x of ix.artistLabelsByLabel.get(labelId) ?? []) roster.set(x.artist_id, { id: x.artist_id, n: 0, signed: true });
  for (const r of releases) for (const c of ix.creditsByRelease.get(r.id) ?? []) {
    if (c.role !== 'primary') continue;
    const e = roster.get(c.artist_id) ?? { id: c.artist_id, n: 0, signed: false }; e.n++; roster.set(c.artist_id, e);
  }
  return { releases, roster: [...roster.values()].sort((a, b) => Number(b.signed) - Number(a.signed) || b.n - a.n) };
}

export function Labels() {
  const { data, ix, upsert, say } = useStore();
  const nav = useNavigate();
  const [sp, setSp] = useSearchParams();
  const q = sp.get('q') ?? ''; const sort = sp.get('sort') ?? 'recent'; const rev = sp.get('rev') === '1';
  const set = (k: string, v: string | null) => { const n = new URLSearchParams(sp); if (v) n.set(k, v); else n.delete(k); setSp(n, { replace: true }); };
  const sortTo = (k: string) => { const n = new URLSearchParams(sp); if (k === 'recent') n.delete('sort'); else n.set('sort', k); n.delete('rev'); setSp(n, { replace: true }); };
  const sortBy = (k: string) => (sort === k ? set('rev', rev ? null : '1') : sortTo(k));
  const arrow = (k: string, up: boolean) => (sort === k ? ((up !== rev) ? ' ↑' : ' ↓') : '');
  const [view, setView] = usePref('labels.view', 'grid');
  const [showCounts, setShowCounts] = usePref('labels.showCounts', false);
  const [name, setName] = useState('');

  const rows = useMemo(() => {
    const n = norm(q);
    return data.labels.filter((l) => (!n || norm([l.name, ...l.aliases].join(' ')).includes(n)))
      .map((l) => ({ l, n: ix.releaseLabelsByLabel.get(l.id)?.length ?? 0, last: ix.lastByLabel.get(l.id) ?? '' }))
      .sort((x, y) => {
        const az = x.l.name.localeCompare(y.l.name, undefined, { sensitivity: 'base' });
        return sort === 'az' ? az : sort === 'za' ? -az : sort === 'count' ? y.n - x.n || az : y.last.localeCompare(x.last) || az;
      });
  }, [data.labels, ix, q, sort]);
  const shownRows = flip(rows, rev, (r) => (sort === 'count' ? r.n > 0 : sort === 'recent' ? !!r.last : true));

  const todo = data.releases.filter((r) => !r.ext.labels_at && !ix.releaseLabelsByRelease.get(r.id)?.length && (r.ext.deezer_id || r.ext.mbid || r.ext.apple_id)).map((r) => r.id);
  return (
    <div>
      <div className="row" style={{ marginBottom: 20 }}>
        <h1 className="h-page">Labels</h1><span className="spacer" />
        {todo.length > 0 && <button className="btn primary" onClick={() => { linkQueue.add('labels', todo); say(`Looking up labels for ${todo.length.toLocaleString()} releases in the background`); }}>Find labels for {todo.length.toLocaleString()} releases</button>}
      </div>
      <div className="row" style={{ marginBottom: 20 }}>
        <input className="input" style={{ width: 240 }} placeholder="Filter labels" value={q} onChange={(e) => set('q', e.target.value)} />
        <SortSelect value={sort} onChange={sortTo} rev={rev} onRev={(r) => set('rev', r ? '1' : null)} options={[['recent', 'Most recent release'], ['az', 'A–Z'], ['count', 'Most releases']]} />
        {view !== 'table' && <label className="row"><input type="checkbox" checked={showCounts} onChange={(e) => setShowCounts(e.target.checked)} /> Show counts</label>}
        <span className="muted num">{rows.length.toLocaleString()}</span>
        <div className="seg" role="group" aria-label="View"><button className={view !== 'table' ? 'on' : ''} onClick={() => setView('grid')}>Grid</button><button className={view === 'table' ? 'on' : ''} onClick={() => setView('table')}>Table</button></div>
        <span className="spacer" />
        <form className="row" onSubmit={async (e) => { e.preventDefault(); if (!name.trim()) return; const l: Label = { id: uid(), name: name.trim(), aliases: [], links: {}, ext: {}, created_at: now(), updated_at: now() }; await upsert('labels', [l]); nav(`/label/${l.id}`); }}>
          <input className="input" placeholder="New label" value={name} onChange={(e) => setName(e.target.value)} style={{ width: 160 }} /><button className="btn" disabled={!name.trim()}>Add</button>
        </form>
      </div>
      {!rows.length ? <div className="empty">{data.labels.length ? 'No labels match.' : 'No labels yet. “Find labels” pulls them from Deezer, MusicBrainz and Apple Music for releases that are already linked — or add them by hand on any release.'}</div> : (
        view === 'table' ? (
          <div className="table-wrap"><table className="table">
            <thead><tr><th className="thumb" /><th style={{ cursor: 'pointer' }} onClick={() => sortBy('az')}>Label{arrow('az', true)}</th><th style={{ cursor: 'pointer' }} onClick={() => sortBy('recent')}>Latest release{arrow('recent', false)}</th>
              <th style={{ cursor: 'pointer', textAlign: 'right' }} onClick={() => sortBy('count')}>Releases{arrow('count', false)}</th></tr></thead>
            <tbody>{shownRows.map(({ l, n, last }) => (
              <tr key={l.id}><td><Link to={`/label/${l.id}`}><Cover src={l.image_url} title={l.name} size={36} /></Link></td>
                <td><Link to={`/label/${l.id}`} style={{ fontWeight: 600 }}>{l.name}</Link></td>
                <td className="num muted small">{last ? fmtDate(last) : '—'}</td><td className="num" style={{ textAlign: 'right' }}>{n || ''}</td></tr>))}</tbody>
          </table></div>
        ) : <div className="grid tight">{shownRows.map(({ l, n, last }) => (
          <div key={l.id} className="tile">
            <Link to={`/label/${l.id}`}><Cover src={l.image_url} title={l.name} /></Link>
            <div className="t"><Link to={`/label/${l.id}`}>{l.name}</Link></div>
            <div className="s">{[sort === 'recent' && last ? `Latest ${fmtDate(last)}` : '', showCounts ? `${n} release${n === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ')}</div>
          </div>))}</div>
      )}
    </div>
  );
}

export default function LabelPage() {
  const { id } = useParams();
  const st = useStore();
  const { ix, data, upsert, say } = st;
  const nav = useNavigate();
  const l = ix.labels.get(id!);
  const [editLinks, setEditLinks] = useState(false);
  const [editing, setEditing] = useState(false);
  const [merging, setMerging] = useState(false);
  const [sort, setSort] = usePref('label.sort', 'newest');
  const [rev, setRev] = usePref('label.rev', false);
  const [types, setTypes] = useState<string[]>([]);
  const { releases, roster } = useMemo(() => labelContents(ix, id!), [ix, id]);
  if (!l) return <div className="empty">Label not found. <Link to="/labels">All labels</Link></div>;
  const day = (r: Release) => r.date ?? `${r.year ?? 0}`;
  const rt = (r: Release) => ix.ann.get(`release:${r.id}`)?.rating ?? 0;
  const shown = releases.filter((r) => !types.length || types.includes(r.type)).sort(
    sort === 'oldest' ? (x, y) => day(x).localeCompare(day(y)) : sort === 'rating' ? (x, y) => rt(y) - rt(x) || day(y).localeCompare(day(x))
      : sort === 'title' ? (x, y) => x.title.localeCompare(y.title) : sort === 'artist' ? (x, y) => (x.artist_credit ?? '').localeCompare(y.artist_credit ?? '') : (x, y) => day(y).localeCompare(day(x)));
  const shownSorted = flip(shown, rev, (r) => (sort === 'rating' ? rt(r) > 0 : true));
  const years = releases.map((r) => r.year).filter(Boolean) as number[];
  const save = (p: Partial<Label>) => upsert('labels', [{ ...l, ...p, updated_at: now() }]);

  return (
    <div>
      <div className="hero" style={{ gridTemplateColumns: 'minmax(160px, 240px) 1fr' }}>
        <Cover src={l.image_url} title={l.name} eager />
        <div>
          <PageKicker type="label" id={l.id} label={<>Label{l.aliases.length ? ` · also ${l.aliases.join(', ')}` : ''}</>} onEdit={() => setEditing(true)} />
          <h1 className="hero-name">{l.name}</h1>
          <div className="hero-meta">
            {years.length > 0 && <span className="num">{Math.min(...years)}–{Math.max(...years)}</span>}
            {ix.lastByLabel.get(l.id) && <span>Latest release {fmtDate(ix.lastByLabel.get(l.id))}</span>}
          </div>
        </div>
      </div>
      <div style={{ margin: '22px 0' }}><LinkBar links={l.links} kind="label" name={l.name} onEdit={() => setEditLinks(true)} /></div>
      <div className="row"><AddToList type="label" id={l.id} /><button className="btn" onClick={() => setMerging(true)}>Merge…</button></div>

      <div style={{ marginTop: 28 }}>
        <div>
          <OldNotes type="label" id={l.id} />
          {l.bio && <p style={{ marginTop: 0 }}>{l.bio}</p>}
          {roster.length > 0 && <>
            <h2 className="h-sec" style={{ marginTop: 0 }}>Artists</h2>
            <div className="row" style={{ gap: 6 }}>{roster.map((x) => { const a = ix.artists.get(x.id); return a && <Link key={a.id} className="chip" to={`/artist/${a.id}`} title={x.signed ? 'Marked as signed' : `${x.n} release${x.n === 1 ? '' : 's'}`}>{a.name}</Link>; })}</div>
          </>}
          <h2 className="h-sec">Releases</h2>
          {releases.length > 0 && <div className="row" style={{ marginBottom: 14 }}>
            <SortSelect value={sort} onChange={(v) => { setSort(v); setRev(false); }} rev={rev} onRev={setRev} options={[['newest', 'Release date'], ['artist', 'Artist A–Z'], ['title', 'Title A–Z']]} />
            <div style={{ minWidth: 180 }}><MultiSelect label="Types" options={[...new Set(releases.map((r) => r.type))].sort()} value={types} onChange={setTypes} /></div>
          </div>}
          {shownSorted.length ? <div className="grid tight">{shownSorted.map((r) => <ReleaseTile key={r.id} r={r} />)}</div> : <div className="empty">No releases on this label yet. Add it on a release with Edit.</div>}
          <div style={{ marginTop: 40 }}><button className="btn danger" onClick={async () => { if (confirm(`Delete the label ${l.name}? Releases stay; they just lose this label.`)) { await st.deleteLabel(l.id); nav('/labels'); } }}>Delete label</button></div>
        </div>
      </div>

      {editLinks && <LinksEditor links={l.links} onClose={() => setEditLinks(false)} onSave={(links) => save({ links })} />}
      {editing && <LabelForm label={l} onClose={() => setEditing(false)} />}
      {merging && <Modal title={`Merge ${l.name} into…`} onClose={() => setMerging(false)}>
        <MergeLabel from={l} done={(into) => { setMerging(false); say(`Merged into ${into.name}`); nav(`/label/${into.id}`); }} options={data.labels.filter((x) => x.id !== l.id)} />
      </Modal>}
    </div>
  );
}

function LabelForm({ label, onClose }: { label: Label; onClose: () => void }) {
  const { upsert } = useStore();
  const [f, setF] = useState({ name: label.name, aliases: label.aliases.join(', '), image_url: label.image_url ?? '', bio: label.bio ?? '' });
  return (
    <Modal title="Edit label" onClose={onClose}>
      <form className="form-grid" onSubmit={async (e) => { e.preventDefault(); await upsert('labels', [{ ...label, name: f.name.trim() || label.name, aliases: f.aliases.split(',').map((s) => s.trim()).filter(Boolean), image_url: f.image_url || null, bio: f.bio || null, updated_at: now() }]); onClose(); }}>
        <label className="full"><span className="label">Name</span><input className="input" style={{ width: '100%' }} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
        <label className="full"><span className="label">Other names, comma-separated (helps matching)</span><input className="input" style={{ width: '100%' }} value={f.aliases} onChange={(e) => setF({ ...f, aliases: e.target.value })} /></label>
        <label className="full"><span className="label">Logo URL</span><input className="input" style={{ width: '100%' }} value={f.image_url} onChange={(e) => setF({ ...f, image_url: e.target.value })} /></label>
        <label className="full"><span className="label">About</span><textarea className="textarea" value={f.bio} onChange={(e) => setF({ ...f, bio: e.target.value })} /></label>
        <div className="full row"><span className="spacer" /><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary">Save changes</button></div>
      </form>
    </Modal>
  );
}

function MergeLabel({ from, options, done }: { from: Label; options: Label[]; done: (into: Label) => void }) {
  const { data, ix, upsert, remove } = useStore();
  const [q, setQ] = useState('');
  const hits = q.length < 2 ? [] : options.filter((x) => norm(x.name).includes(norm(q))).slice(0, 10);
  async function merge(into: Label) {
    const have = new Set((ix.releaseLabelsByLabel.get(into.id) ?? []).map((x) => x.release_id));
    const rl = data.release_labels.filter((x) => x.label_id === from.id);
    await upsert('release_labels', rl.filter((x) => !have.has(x.release_id)).map((x) => ({ ...x, label_id: into.id })));
    await remove('release_labels', rl.filter((x) => have.has(x.release_id)).map((x) => x.id));
    const al = data.artist_labels.filter((x) => x.label_id === from.id);
    await upsert('artist_labels', al.map((x) => ({ ...x, label_id: into.id })));
    await upsert('labels', [{ ...into, aliases: [...new Set([...into.aliases, from.name, ...from.aliases])], image_url: into.image_url ?? from.image_url, links: { ...from.links, ...into.links }, updated_at: now() }]);
    await remove('labels', [from.id]);
    done(into);
  }
  return (
    <div>
      <p className="small muted" style={{ marginTop: -8 }}>For duplicates like “Def Jam” and “Def Jam Recordings”. Releases move to the label you pick, and “{from.name}” becomes one of its other names.</p>
      <input className="input" style={{ width: '100%' }} autoFocus placeholder="Search labels" value={q} onChange={(e) => setQ(e.target.value)} />
      <div style={{ marginTop: 10 }}>{hits.map((o) => <button key={o.id} className="dd-item btn ghost" style={{ width: '100%', justifyContent: 'flex-start' }} onClick={() => merge(o)}>{o.name}</button>)}</div>
    </div>
  );
}
