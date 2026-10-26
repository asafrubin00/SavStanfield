import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Cover } from '../components/ui';
import { norm, useStore, type Index } from '../lib/store';
import type { Artist } from '../lib/types';
import { now } from '../lib/util';

/** "The Alchemist", "Alchemist" and "ALCHEMIST" all give the same key; so do "J.I.D." and "JID", "Robb Bank$" and "Robb Banks". */
const key = (s: string) => norm(s.replace(/\$/g, 's')).replace(/^the /, '').replace(/\s+/g, '');
const bigrams = (s: string) => { const b = new Set<string>(); for (let i = 0; i < s.length - 1; i++) b.add(s.slice(i, i + 2)); return b; };
const dice = (a: Set<string>, b: Set<string>) => { let n = 0; for (const x of a) if (b.has(x)) n++; return (2 * n) / (a.size + b.size || 1); };
const SPLIT = /\s*(?:&|,|\bx\b|\band\b|\bfeat\.?|\bft\.?|\bwith\b)\s*/i;

type Pair = { a: Artist; b: Artist; score: number; exact: boolean };

export function findDuplicates(ix: Index, artists: Artist[]): Pair[] {
  const notSame = (x: Artist, y: Artist) => ((x.ext.not_same as string[] | undefined) ?? []).includes(y.id) || ((y.ext.not_same as string[] | undefined) ?? []).includes(x.id);
  const rows = artists.map((a) => ({ a, k: key(a.name), b: bigrams(key(a.name)) })).filter((r) => r.k.length >= 2);
  const out: Pair[] = [];
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const x = rows[i], y = rows[j];
      if (x.k === y.k) { if (!notSame(x.a, y.a)) out.push({ a: x.a, b: y.a, score: 1, exact: true }); continue; }
      if (Math.min(x.k.length, y.k.length) < 5 || Math.abs(x.k.length - y.k.length) > Math.max(x.k.length, y.k.length) * 0.3) continue;
      // "French Montana" vs "French Montana & Max B" is a joint credit, not a misspelling
      if (SPLIT.test(x.a.name) !== SPLIT.test(y.a.name)) continue;
      const s = dice(x.b, y.b);
      if (s >= 0.85 && !notSame(x.a, y.a)) out.push({ a: x.a, b: y.a, score: s, exact: false });
    }
  }
  void ix;
  return out.sort((p, q) => Number(q.exact) - Number(p.exact) || q.score - p.score);
}

/** Artists whose name is two or more artists you already have, e.g. "Action Bronson & Joey Bada$$". */
export function findCombos(ix: Index, artists: Artist[]): { combo: Artist; parts: Artist[] }[] {
  const out: { combo: Artist; parts: Artist[] }[] = [];
  for (const a of artists) {
    if (a.ext.is_group) continue;
    const names = a.name.split(SPLIT).map((s) => s.trim()).filter(Boolean);
    if (names.length < 2) continue;
    const parts = names.map((n) => ix.artistByName.get(norm(n))).filter((p): p is Artist => !!p && p.id !== a.id);
    if (parts.length === names.length) out.push({ combo: a, parts });
  }
  return out.sort((x, y) => x.combo.name.localeCompare(y.combo.name));
}

export default function TidyArtists() {
  const st = useStore(); const { data, ix } = st;
  const [busy, setBusy] = useState('');
  const pairs = useMemo(() => findDuplicates(ix, data.artists), [ix, data.artists]);
  const combos = useMemo(() => findCombos(ix, data.artists), [ix, data.artists]);
  const n = (a: Artist) => (ix.creditsByArtist.get(a.id) ?? []).filter((c) => c.role === 'primary' && c.release_id).length;
  const credits = (a: Artist) => (ix.creditsByArtist.get(a.id) ?? []).length;
  const run = async (label: string, f: () => Promise<void>) => { setBusy(label); try { await f(); st.say(label); } catch (e) { st.say((e as Error).message); } finally { setBusy(''); } };
  const notSame = (p: Pair) => run('Marked as different people', async () => {
    await st.upsert('artists', [
      { ...p.a, ext: { ...p.a.ext, not_same: [...new Set([...((p.a.ext.not_same as string[]) ?? []), p.b.id])] }, updated_at: now() },
      { ...p.b, ext: { ...p.b.ext, not_same: [...new Set([...((p.b.ext.not_same as string[]) ?? []), p.a.id])] }, updated_at: now() },
    ]);
  });
  const Who = ({ a }: { a: Artist }) => (
    <Link to={`/artist/${a.id}`} className="row" style={{ gap: 8, flexWrap: 'nowrap', minWidth: 0 }}>
      <Cover src={a.image_url} title={a.name} size={36} round />
      <span style={{ minWidth: 0 }}><strong>{a.name}</strong><div className="small muted">{n(a)} release{n(a) === 1 ? '' : 's'} · {credits(a)} credit{credits(a) === 1 ? '' : 's'}{a.is_producer ? ' · producer' : ''}</div></span>
    </Link>
  );
  return (
    <div>
      <div className="row" style={{ marginBottom: 6 }}><h1 className="h-page">Tidy artists</h1><span className="spacer" />{busy && <span className="small muted">{busy}…</span>}</div>
      <p className="muted" style={{ marginTop: 0, maxWidth: '70ch' }}>Merging moves every release, song credit, rating and list entry to the artist you keep, and the other spelling becomes one of their other names so it's recognised next time. “Not the same” and “It's a group” are remembered, so those don't come back.</p>

      <h2 className="h-sec">Likely duplicates <span className="muted">{pairs.length}</span></h2>
      {!pairs.length ? <div className="empty">No duplicates found.</div> : (
        <div className="table-wrap"><table className="table"><tbody>{pairs.map((p) => (
          <tr key={`${p.a.id}${p.b.id}`}>
            <td style={{ width: '30%' }}><Who a={p.a} /></td>
            <td style={{ width: '30%' }}><Who a={p.b} /></td>
            <td className="small muted" style={{ whiteSpace: 'nowrap' }}>{p.exact ? 'Same name' : 'Similar spelling'}</td>
            <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
              <button className="btn sm" disabled={!!busy} onClick={() => run(`Merged into ${p.a.name}`, () => st.mergeArtists(p.b, p.a))}>Keep “{p.a.name}”</button>{' '}
              <button className="btn sm" disabled={!!busy} onClick={() => run(`Merged into ${p.b.name}`, () => st.mergeArtists(p.a, p.b))}>Keep “{p.b.name}”</button>{' '}
              <button className="btn sm ghost" disabled={!!busy} onClick={() => notSame(p)}>Not the same</button>
            </td>
          </tr>))}</tbody></table></div>
      )}

      <h2 className="h-sec">Two artists stuck together <span className="muted">{combos.length}</span></h2>
      <p className="small muted" style={{ marginTop: -6 }}>Split credits everything to each artist separately — a joint album shows on both pages, a feature in both their appearances — then removes the joint entry.</p>
      {!combos.length ? <div className="empty">Nothing to split.</div> : (
        <div className="table-wrap"><table className="table"><tbody>{combos.map(({ combo, parts }) => (
          <tr key={combo.id}>
            <td style={{ width: '30%' }}><Who a={combo} /></td>
            <td className="small">→ {parts.map((p, i) => <span key={p.id}>{i ? ' + ' : ''}<Link to={`/artist/${p.id}`}>{p.name}</Link></span>)}</td>
            <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
              <button className="btn sm primary" disabled={!!busy} onClick={() => run(`Split ${combo.name}`, () => st.splitArtist(combo, parts))}>Split</button>{' '}
              <button className="btn sm ghost" disabled={!!busy} onClick={() => run(`Kept ${combo.name} as a group`, () => st.upsert('artists', [{ ...combo, ext: { ...combo.ext, is_group: true }, updated_at: now() }]))}>It's a group, keep it</button>
            </td>
          </tr>))}</tbody></table></div>
      )}
    </div>
  );
}
