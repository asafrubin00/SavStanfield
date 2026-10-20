import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { SortSelect, usePref } from '../components/controls';
import { Cover, Credits, QuickRate, ReleaseTile } from '../components/ui';
import { norm, useStore } from '../lib/store';
import { now, uid } from '../lib/util';

function Bars({ rows, unit }: { rows: { label: string; to?: string; value: number; sub?: string }[]; unit: string }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <div role="table">{rows.map((r) => (
      <div key={r.label} className="bar-row" role="row" title={`${r.label}: ${r.value} ${unit}`}>
        <span role="cell" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.to ? <Link to={r.to}>{r.label}</Link> : r.label}</span>
        <span role="cell"><div className="bar" style={{ width: `${(r.value / max) * 100}%`, borderRadius: '0 4px 4px 0' }} /></span>
        <span role="cell" className="num" style={{ textAlign: 'right' }}>{Number.isInteger(r.value) ? r.value : r.value.toFixed(2)}</span>
      </div>))}</div>
  );
}

function Columns({ rows }: { rows: { label: string; value: number }[] }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  const [hover, setHover] = useState<number | null>(null);
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 160, borderBottom: '1px solid var(--line)', position: 'relative' }}>
        {rows.map((r, i) => (
          <div key={r.label} style={{ flex: 1, height: '100%', display: 'flex', alignItems: 'flex-end', cursor: 'default' }} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} title={`${r.label}: ${r.value}`}>
            <div style={{ width: '100%', height: `${(r.value / max) * 100}%`, background: 'var(--accent)', opacity: hover === null || hover === i ? 1 : .55, borderRadius: '4px 4px 0 0', minHeight: r.value ? 2 : 0 }} />
          </div>))}
        {hover !== null && <div className="small" style={{ position: 'absolute', top: 0, left: 0, background: 'var(--surface)', border: '1px solid var(--line)', padding: '2px 8px', borderRadius: 4 }}><strong>{rows[hover].label}</strong> · {rows[hover].value} releases</div>}
      </div>
      <div className="row small muted num" style={{ justifyContent: 'space-between', marginTop: 4 }}><span>{rows[0]?.label}</span><span>{rows.at(-1)?.label}</span></div>
    </div>
  );
}

type Tag = { kind: 'artist' | 'producer' | 'label'; id: string; name: string };
const KIND_LABEL: Record<Tag['kind'], string> = { artist: 'Artist', producer: 'Producer', label: 'Label' };

/** Pick artists, producers and labels as tags; suggestions say which kind each one is. */
function TagFilter({ value, onChange }: { value: Tag[]; onChange: (v: Tag[]) => void }) {
  const { data, ix } = useStore();
  const [q, setQ] = useState(''); const [focus, setFocus] = useState(false);
  const hits = useMemo(() => {
    const n = norm(q); if (!n) return [];
    const has = (t: Tag) => value.some((v) => v.kind === t.kind && v.id === t.id);
    const leads = new Set(data.credits.filter((c) => c.role === 'primary' && c.release_id).map((c) => c.artist_id));
    const out: Tag[] = [];
    for (const a of data.artists) if (norm(a.name).includes(n)) {
      if (leads.has(a.id)) out.push({ kind: 'artist', id: a.id, name: a.name });
      if (a.is_producer) out.push({ kind: 'producer', id: a.id, name: a.name });
    }
    for (const l of data.labels) if (norm(l.name).includes(n)) out.push({ kind: 'label', id: l.id, name: l.name });
    const starts = (t: Tag) => Number(norm(t.name).startsWith(n));
    return out.filter((t) => !has(t)).sort((x, y) => starts(y) - starts(x) || x.name.length - y.name.length).slice(0, 10);
  }, [q, value, data, ix]); // eslint-disable-line react-hooks/exhaustive-deps
  const add = (t: Tag) => { onChange([...value, t]); setQ(''); };
  return (
    <div className="people-input" style={{ position: 'relative', minWidth: 280, flex: 1, maxWidth: 640 }}>
      {value.map((t, i) => <span key={`${t.kind}${t.id}`} className="chip">{t.name}<span className="muted small"> · {KIND_LABEL[t.kind].toLowerCase()}</span><button type="button" aria-label={`Remove ${t.name}`} onClick={() => onChange(value.filter((_, j) => j !== i))}>×</button></span>)}
      <input value={q} placeholder={value.length ? 'Add another…' : 'Filter by artist, producer or label'} aria-label="Filter by artist, producer or label"
        onFocus={() => setFocus(true)} onBlur={() => window.setTimeout(() => setFocus(false), 150)} onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && hits[0]) { e.preventDefault(); add(hits[0]); } else if (e.key === 'Backspace' && !q && value.length) onChange(value.slice(0, -1)); }} />
      {focus && hits.length > 0 && <div className="dropdown" style={{ minWidth: 260 }}>{hits.map((t) => (
        <button type="button" key={`${t.kind}${t.id}`} className="dd-item btn ghost" style={{ width: '100%', justifyContent: 'flex-start' }} onMouseDown={(e) => { e.preventDefault(); add(t); }}>{t.name}<span className="small muted"> · {KIND_LABEL[t.kind]}</span></button>))}</div>}
    </div>
  );
}

const SHOW = 60;

export default function Charts() {
  const { data, ix, upsert, say } = useStore();
  const nav = useNavigate();
  const [decade, setDecade] = useState('');
  const [year, setYear] = useState('');
  const [type, setType] = useState('');
  const [min, setMin] = useState(4);
  const [tags, setTags] = useState<Tag[]>([]);
  const [match, setMatch] = useState<'any' | 'all'>('any');
  const [view, setView] = usePref('charts.view', 'covers');
  const [shown, setShown] = useState(SHOW);

  // Which releases each tag stands for: an artist's own releases, anything a producer worked on, everything on a label
  const tagSets = useMemo(() => tags.map((t) => {
    const s = new Set<string>();
    if (t.kind === 'label') for (const x of data.release_labels) { if (x.label_id === t.id) s.add(x.release_id); }
    else for (const c of ix.creditsByArtist.get(t.id) ?? []) {
      if (t.kind === 'artist' && c.role === 'primary' && c.release_id) s.add(c.release_id);
      if (t.kind === 'producer' && (c.role === 'producer' || c.role === 'exec_producer')) { const rid = c.release_id ?? (c.track_id ? ix.tracks.get(c.track_id)?.release_id : null); if (rid) s.add(rid); }
    }
    return s;
  }), [tags, data.release_labels, ix]);
  const inScope = useMemo(() => data.releases.filter((r) =>
    (!decade || (r.year && Math.floor(r.year / 10) * 10 === Number(decade))) && (!year || r.year === Number(year)) && (!type || r.type === type)
    && (!tagSets.length || (match === 'all' ? tagSets.every((s) => s.has(r.id)) : tagSets.some((s) => s.has(r.id))))), [data.releases, decade, year, type, tagSets, match]);
  const rated = useMemo(() => inScope.map((r) => ({ r, a: ix.ann.get(`release:${r.id}`) })).filter((x) => x.a?.rating), [inScope, ix]);
  const [exact, setExact] = useState(false);
  const [topSort, setTopSort] = useState('rating');
  const top = useMemo(() => {
    const day = (r: typeof rated[0]['r']) => r.date ?? `${r.year ?? 0}`;
    const pool = min === 0 ? inScope.map((r) => ({ r, a: ix.ann.get(`release:${r.id}`) })) : rated.filter((x) => exact ? x.a!.rating === min : x.a!.rating! >= min);
    const cmp: Record<string, (x: typeof rated[0], y: typeof rated[0]) => number> = {
      rating: (x, y) => (y.a?.rating ?? 0) - (x.a?.rating ?? 0) || Number(!!y.a?.favorite) - Number(!!x.a?.favorite) || day(y.r).localeCompare(day(x.r)),
      newest: (x, y) => day(y.r).localeCompare(day(x.r)), oldest: (x, y) => day(x.r).localeCompare(day(y.r)),
      artist: (x, y) => (x.r.artist_credit ?? '').localeCompare(y.r.artist_credit ?? '') || day(x.r).localeCompare(day(y.r)), title: (x, y) => x.r.title.localeCompare(y.r.title),
    };
    return pool.sort(cmp[topSort] ?? cmp.rating).map((x) => x.r);
  }, [rated, inScope, ix, min, exact, topSort]);

  const perYear = useMemo(() => {
    const m = new Map<number, number>(); for (const r of inScope) if (r.year && r.year <= new Date().getFullYear() + 1) m.set(r.year, (m.get(r.year) ?? 0) + 1);
    const ys = [...m.keys()].sort(); if (!ys.length) return [];
    return Array.from({ length: ys.at(-1)! - ys[0] + 1 }, (_, i) => ({ label: String(ys[0] + i), value: m.get(ys[0] + i) ?? 0 }));
  }, [inScope]);
  const dist = [5, 4, 3, 2, 1].map((n) => ({ label: '★'.repeat(n), value: rated.filter((x) => x.a!.rating === n).length }));
  const artistStats = useMemo(() => {
    const m = new Map<string, { n: number; sum: number; rated: number }>();
    const scope = new Set(inScope.map((r) => r.id));
    for (const c of data.credits) {
      if (c.role !== 'primary' || !c.release_id || !scope.has(c.release_id)) continue;
      const e = m.get(c.artist_id) ?? { n: 0, sum: 0, rated: 0 }; e.n++;
      const rt = ix.ann.get(`release:${c.release_id}`)?.rating; if (rt) { e.sum += rt; e.rated++; }
      m.set(c.artist_id, e);
    }
    return [...m.entries()].map(([id, e]) => ({ a: ix.artists.get(id)!, ...e })).filter((x) => x.a);
  }, [data.credits, inScope, ix]);
  const prodStats = useMemo(() => {
    const scope = new Set(inScope.map((r) => r.id)); const m = new Map<string, Set<string>>();
    for (const c of data.credits) {
      if (c.role !== 'producer' && c.role !== 'exec_producer') continue;
      const rid = c.release_id ?? ix.tracks.get(c.track_id!)?.release_id; if (!rid || !scope.has(rid)) continue;
      (m.get(c.artist_id) ?? m.set(c.artist_id, new Set()).get(c.artist_id)!).add(rid);
    }
    return [...m.entries()].map(([id, s]) => ({ a: ix.artists.get(id)!, n: s.size })).filter((x) => x.a).sort((x, y) => y.n - x.n).slice(0, 15);
  }, [data.credits, inScope, ix]);

  const decades = [...new Set(data.releases.map((r) => r.year && Math.floor(r.year / 10) * 10).filter(Boolean) as number[])].sort();
  const scopeName = [tags.map((t) => t.name).join(match === 'all' ? ' + ' : ' / '), type, year || (decade && `${decade}s`)].filter(Boolean).join(', ') || 'All time';

  async function saveAsList() {
    const id = uid();
    await upsert('lists', [{ id, name: `${min ? 'Top rated' : 'Chart'} — ${scopeName}`, description: `${min ? `Your ${min}★${exact ? '' : '-and-up'} releases` : 'All releases'}, saved ${new Date().toLocaleDateString('en-GB')}`, ranked: true, created_at: now(), updated_at: now() }]);
    await upsert('list_items', top.slice(0, 100).map((r, i) => ({ id: uid(), list_id: id, entity_type: 'release' as const, entity_id: r.id, position: i + 1 })));
    say('Saved as a list'); nav(`/list/${id}`);
  }

  return (
    <div>
      <div className="row" style={{ marginBottom: 20 }}><h1 className="h-page">Charts</h1></div>
      <div className="row" style={{ marginBottom: 8 }}>
        <select className="select" value={decade} onChange={(e) => { setDecade(e.target.value); setYear(''); }} aria-label="Decade"><option value="">All decades</option>{decades.map((d) => <option key={d} value={d}>{d}s</option>)}</select>
        <input className="input num" style={{ width: 90 }} placeholder="Year" inputMode="numeric" value={year} onChange={(e) => setYear(e.target.value)} aria-label="Year" />
        <select className="select" value={type} onChange={(e) => setType(e.target.value)} aria-label="Type"><option value="">All types</option>{[...new Set(data.releases.map((r) => r.type))].sort().map((t) => <option key={t}>{t}</option>)}</select>
        <span className="muted">{inScope.length.toLocaleString()} releases, {rated.length.toLocaleString()} rated</span>
      </div>
      <div className="row" style={{ marginBottom: 8, alignItems: 'flex-start' }}>
        <TagFilter value={tags} onChange={(v) => { setTags(v); setShown(SHOW); }} />
        {tags.length > 1 && <div className="seg" role="group" aria-label="Match" title="Any: releases matching any tag. All: only releases matching every tag (e.g. Future + Metro Boomin = Future releases Metro produced on)."><button className={match === 'any' ? 'on' : ''} onClick={() => setMatch('any')}>Any</button><button className={match === 'all' ? 'on' : ''} onClick={() => setMatch('all')}>All</button></div>}
      </div>

      <h2 className="h-sec">{min ? 'Your top rated' : 'Everything'} <span className="muted">{scopeName}</span></h2>
      <div className="row" style={{ marginBottom: 14 }}>
        <div className="seg"><button className={min === 0 ? 'on' : ''} onClick={() => { setMin(0); setShown(SHOW); }}>All</button>{[5, 4, 3, 2, 1].map((n) => <button key={n} className={min === n ? 'on' : ''} onClick={() => { setMin(n); setShown(SHOW); }}>{'★'.repeat(n)}</button>)}</div>
        {min > 0 && <div className="seg"><button className={!exact ? 'on' : ''} onClick={() => setExact(false)}>and up</button><button className={exact ? 'on' : ''} onClick={() => setExact(true)}>exactly</button></div>}
        <SortSelect value={topSort} onChange={setTopSort} options={[['rating', 'Highest rated'], ['newest', 'Newest first'], ['oldest', 'Oldest first'], ['artist', 'Artist A–Z'], ['title', 'Title A–Z']]} />
        <div className="seg" role="group" aria-label="View"><button className={view !== 'list' ? 'on' : ''} onClick={() => setView('covers')}>Album view</button><button className={view === 'list' ? 'on' : ''} onClick={() => setView('list')}>List view</button></div>
        <span className="muted">{top.length.toLocaleString()}</span><span className="spacer" />
        <button className="btn" disabled={!top.length} onClick={saveAsList}>Save as a list</button>
      </div>
      {!top.length ? <div className="empty">{min ? `Nothing rated ${exact ? 'exactly ' : ''}${min}★${exact ? '' : ' or higher'} here yet.` : 'Nothing matches these filters.'}</div>
        : view === 'list' ? (
          <div className="table-wrap"><table className="table">
            <thead><tr><th style={{ width: 36 }}>#</th><th className="thumb" /><th>Title</th><th>Artist</th><th>Type</th><th>Date</th><th>Rating</th></tr></thead>
            <tbody>{top.slice(0, shown).map((r, i) => (
              <tr key={r.id}><td className="num muted">{i + 1}</td><td><Link to={`/release/${r.id}`}><Cover src={r.artwork_url} title={r.title} size={36} /></Link></td>
                <td><Link to={`/release/${r.id}`} style={{ fontWeight: 600 }}>{r.title}</Link></td><td><Credits release={r} /></td><td className="muted">{r.type}</td>
                <td className="num muted" style={{ whiteSpace: 'nowrap' }}>{r.date ?? r.year ?? ''}</td><td><QuickRate type="release" id={r.id} /></td></tr>))}</tbody>
          </table></div>
        ) : <div className="grid tight">{top.slice(0, shown).map((r) => <ReleaseTile key={r.id} r={r} />)}</div>}
      {top.length > shown && <div style={{ textAlign: 'center', marginTop: 20 }}><button className="btn" onClick={() => setShown((s) => s + SHOW * 2)}>Show more ({(top.length - shown).toLocaleString()} left)</button></div>}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: '8px 40px' }}>
        <section><h2 className="h-sec">Releases by year</h2>{perYear.length ? <Columns rows={perYear} /> : <div className="muted">No dated releases.</div>}</section>
        <section><h2 className="h-sec">How you rate</h2><Bars rows={dist} unit="releases" /></section>
        <section><h2 className="h-sec">Most releases tracked</h2><Bars unit="releases" rows={[...artistStats].sort((x, y) => y.n - x.n).slice(0, 15).map((x) => ({ label: x.a.name, to: `/artist/${x.a.id}`, value: x.n }))} /></section>
        <section><h2 className="h-sec">Highest average <span className="muted">3+ rated</span></h2><Bars unit="★ average" rows={artistStats.filter((x) => x.rated >= 3).map((x) => ({ ...x, avg: x.sum / x.rated })).sort((x, y) => y.avg - x.avg || y.rated - x.rated).slice(0, 15).map((x) => ({ label: x.a.name, to: `/artist/${x.a.id}`, value: x.avg }))} /></section>
        <section><h2 className="h-sec">Top producers</h2>{prodStats.length ? <Bars unit="releases" rows={prodStats.map((x) => ({ label: x.a.name, to: `/artist/${x.a.id}`, value: x.n }))} /> : <div className="muted">No producer credits yet.</div>}</section>
      </div>
    </div>
  );
}
