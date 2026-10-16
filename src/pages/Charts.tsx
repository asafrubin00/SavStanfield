import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ReleaseTile } from '../components/ui';
import { useStore } from '../lib/store';
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

export default function Charts() {
  const { data, ix, upsert, say } = useStore();
  const nav = useNavigate();
  const [decade, setDecade] = useState('');
  const [year, setYear] = useState('');
  const [type, setType] = useState('');
  const [min, setMin] = useState(4);

  const inScope = useMemo(() => data.releases.filter((r) =>
    (!decade || (r.year && Math.floor(r.year / 10) * 10 === Number(decade))) && (!year || r.year === Number(year)) && (!type || r.type === type)), [data.releases, decade, year, type]);
  const rated = useMemo(() => inScope.map((r) => ({ r, a: ix.ann.get(`release:${r.id}`) })).filter((x) => x.a?.rating), [inScope, ix]);
  const top = useMemo(() => rated.filter((x) => x.a!.rating! >= min).sort((x, y) => y.a!.rating! - x.a!.rating! || Number(!!y.a!.favorite) - Number(!!x.a!.favorite) || (x.r.date ?? '').localeCompare(y.r.date ?? '')).map((x) => x.r), [rated, min]);

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
  const scopeName = [type, year || (decade && `${decade}s`)].filter(Boolean).join(', ') || 'All time';

  async function saveAsList() {
    const id = uid();
    await upsert('lists', [{ id, name: `Top rated — ${scopeName}`, description: `Your ${min}★-and-up releases, saved ${new Date().toLocaleDateString('en-GB')}`, ranked: true, created_at: now(), updated_at: now() }]);
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

      <h2 className="h-sec">Your top rated <span className="muted">{scopeName}</span></h2>
      <div className="row" style={{ marginBottom: 14 }}>
        <div className="seg">{[5, 4, 3].map((n) => <button key={n} className={min === n ? 'on' : ''} onClick={() => setMin(n)}>{n === 5 ? '5★ only' : `${n}★ and up`}</button>)}</div>
        <span className="muted">{top.length}</span><span className="spacer" />
        <button className="btn" disabled={!top.length} onClick={saveAsList}>Save as a list</button>
      </div>
      {top.length ? <div className="grid tight">{top.slice(0, 60).map((r) => <ReleaseTile key={r.id} r={r} />)}</div> : <div className="empty">Nothing rated {min}★ or higher here yet.</div>}
      {top.length > 60 && <p className="muted"><Link to={`/library?rating=${min}&sort=rating${decade ? `&decade=${decade}` : ''}${type ? `&type=${encodeURIComponent(type)}` : ''}`}>See all {top.length} in the library</Link></p>}

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
