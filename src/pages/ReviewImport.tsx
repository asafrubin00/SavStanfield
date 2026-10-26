import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Cover } from '../components/ui';
import { parseArtistCredit } from '../lib/importSheet';
import { linkQueue } from '../lib/queue';
import { norm, releaseArtists, useStore, type Index } from '../lib/store';
import { cleanTitle } from '../lib/sources';
import type { Annotation, Release } from '../lib/types';
import { now, uid } from '../lib/util';

/** One review from a note: "[2026] Artist - Title", then the text. */
export interface NoteReview { year: number | null; artist: string; title: string; text: string }

const HEADING = /^\s*\[(\d{4})\]\s*(.+?)\s+[-–—]\s+(.+?)\s*$/;

/** Split pasted Apple Notes text into reviews. Anything before the first "[year] Artist - Title" line (the note's title) is ignored. */
export function parseNoteReviews(text: string): NoteReview[] {
  const out: NoteReview[] = []; let cur: NoteReview | null = null; let body: string[] = [];
  const flush = () => { if (cur) { cur.text = body.join('\n').replace(/\n{3,}/g, '\n\n').trim(); if (cur.text) out.push(cur); } };
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    const m = line.match(HEADING);
    if (m) { flush(); cur = { year: Number(m[1]), artist: m[2].trim(), title: m[3].trim(), text: '' }; body = []; }
    else if (cur) body.push(line.trim());
  }
  flush();
  return out;
}

// Titles compared loosely: punctuation, "The", edition tags and Roman numerals ("Dillagence II" = "Dillagence 2") don't matter
const ROMAN: Record<string, string> = { ii: '2', iii: '3', iv: '4', v: '5', vi: '6', vii: '7', viii: '8', ix: '9', x: '10' };
const tkey = (s: string) => norm(cleanTitle(s).replace(/\$/g, 's')).replace(/^the /, '').split(' ').map((w) => ROMAN[w] ?? w).join('');
const akey = (s: string) => norm(s.replace(/\$/g, 's')).replace(/^the /, '').replace(/\s+/g, '');
const bigrams = (s: string) => { const b = new Set<string>(); for (let i = 0; i < s.length - 1; i++) b.add(s.slice(i, i + 2)); return b; };
const dice = (a: string, b: string) => { if (a === b) return 1; const x = bigrams(a), y = bigrams(b); let n = 0; for (const g of x) if (y.has(g)) n++; return (2 * n) / (x.size + y.size || 1); };

const diceSets = (x: Set<string>, y: Set<string>) => { let n = 0; for (const g of x) if (y.has(g)) n++; return (2 * n) / (x.size + y.size || 1); };
/** Everything about each release the matcher needs, worked out once rather than for every review. */
type Prepped = { r: Release; t: string; tb: Set<string>; names: string[] };
function prep(ix: Index, releases: Release[]): Prepped[] {
  return releases.map((r) => { const t = tkey(r.title); return { r, t, tb: bigrams(t), names: [...new Set([r.artist_credit ?? '', ...releaseArtists(ix, r.id).map((a) => a.name)].map(akey).filter(Boolean))] }; });
}

function artistScore(names: string[], artist: string) {
  const want = akey(artist); const parts = artist.split(/\s*(?:&|,|\bx\b|\band\b)\s*/i).map(akey).filter(Boolean);
  let best = 0;
  for (const n of names) {
    best = Math.max(best, dice(n, want));
    if (n.includes(want) || want.includes(n)) best = Math.max(best, 0.9);
    for (const p of parts) if (p.length > 2 && (n === p || dice(n, p) > 0.85)) best = Math.max(best, 0.85);
  }
  return best;
}

type Match = { r: Release; score: number };
function candidates(all: Prepped[], nr: NoteReview): Match[] {
  const t = tkey(nr.title); const tb = bigrams(t);
  const out: Match[] = [];
  for (const p of all) {
    if (Math.abs(p.t.length - t.length) > Math.max(p.t.length, t.length) * 0.5) continue;
    const ts = p.t === t ? 1 : diceSets(p.tb, tb); if (ts < 0.6) continue;
    const as = artistScore(p.names, nr.artist); if (as < 0.6) continue;
    const yr = nr.year && p.r.year ? (Math.abs(p.r.year - nr.year) <= 1 ? 0.05 : -0.05) : 0;
    out.push({ r: p.r, score: ts * 0.65 + as * 0.35 + yr });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 4);
}

type Choice = 'replace' | 'append' | 'skip';

export default function ReviewImport() {
  const st = useStore(); const { data, ix } = st;
  const [text, setText] = useState('');
  const [picked, setPicked] = useState<Record<number, string>>({}); // review index → release id ('' = none)
  const [choice, setChoice] = useState<Record<number, Choice>>({});
  const [busy, setBusy] = useState('');
  const reviews = useMemo(() => parseNoteReviews(text), [text]);
  // Only redo the matching when releases or credits change — not when a review or rating is saved
  const prepped = useMemo(() => prep(ix, data.releases), [data.releases, data.credits]); // eslint-disable-line react-hooks/exhaustive-deps
  const rows = useMemo(() => reviews.map((nr) => {
    const c = candidates(prepped, nr);
    // A strong match is picked even when there are look-alikes (deluxe editions, duplicates) — those get flagged to check
    const good = c[0] && c[0].score >= 0.88;
    const close = good && !!c[1] && c[0].score - c[1].score <= 0.06;
    return { nr, c, auto: good ? c[0].r.id : '', check: close };
  }), [reviews, prepped]);
  const target = (i: number) => (i in picked ? picked[i] : rows[i].auto);
  const existing = (rid: string) => ix.ann.get(`release:${rid}`)?.review?.trim() ?? '';
  const same = (a: string, b: string) => norm(a) === norm(b);
  const decision = (i: number): Choice | 'new' | 'dup' | 'none' => {
    const rid = target(i); if (!rid) return 'none';
    const ex = existing(rid); if (!ex) return 'new';
    if (same(ex, rows[i].nr.text) || norm(ex).includes(norm(rows[i].nr.text))) return 'dup';
    return choice[i] ?? 'append';
  };
  const counts = rows.reduce((m, _, i) => { const d = decision(i); m[d] = (m[d] ?? 0) + 1; return m; }, {} as Record<string, number>);
  const toSave = rows.map((_, i) => i).filter((i) => ['new', 'replace', 'append'].includes(decision(i)));

  async function addToLibrary(i: number) {
    const nr = rows[i].nr; const collab = /&| x /i.test(nr.artist);
    const r: Release = { id: uid(), title: nr.title, artist_credit: nr.artist, type: collab ? 'Collaboration' : 'Album', year: nr.year, date: null, label: null, artwork_url: null, source: 'manual', links: {}, ext: {}, created_at: now(), updated_at: now() } as Release;
    await st.upsert('releases', [r]);
    const { names, group } = parseArtistCredit(nr.artist, collab);
    [...(group ? [group] : []), ...names].forEach((n, k) => st.creditArtist(st.ensureArtist(n).artist.id, { release_id: r.id }, 'primary', k));
    linkQueue.add('release', [r.id]);
    setPicked((p) => ({ ...p, [i]: r.id }));
    st.say(`Added ${nr.title} — finding its cover and links in the background`);
  }

  async function save() {
    setBusy('Saving reviews');
    try {
      // Several reviews of the same album (e.g. a first listen and a revisit) become one review, oldest first
      const byRelease = new Map<string, Annotation>();
      for (const i of toSave) {
        const rid = target(i); const key = `release:${rid}`; const d = decision(i); const nr = rows[i].nr;
        const prev = byRelease.get(key);
        const cur = prev ?? ix.ann.get(key) ?? { id: key, entity_type: 'release' as const, entity_id: rid, favorite: false };
        const base = prev ? prev.review ?? '' : d === 'append' ? existing(rid) : '';
        const review = base ? `${base}\n\n— ${nr.year ?? ''}\n${nr.text}`.trim() : nr.text;
        byRelease.set(key, { ...cur, review, updated_at: now() } as Annotation);
      }
      const out = [...byRelease.values()];
      await st.upsert('annotations', out);
      st.say(`Imported ${toSave.length} review${toSave.length === 1 ? '' : 's'}${out.length < toSave.length ? ` onto ${out.length} albums` : ''}`);
      setText(''); setPicked({}); setChoice({});
    } catch (e) { st.say((e as Error).message); } finally { setBusy(''); }
  }

  return (
    <div>
      <div className="row" style={{ marginBottom: 6 }}><h1 className="h-page">Import reviews</h1></div>
      <p className="muted" style={{ marginTop: 0, maxWidth: '72ch' }}>In Apple Notes, open a note, press ⌘A then ⌘C, and paste it below. Each review should start with a line like <code>[2026] Gucci Mane - Against All Odds</code>; everything up to the next one is the review. Your star ratings aren't touched — the “3/5” stays in the text. Nothing is saved until you click Import.</p>
      <textarea className="textarea" style={{ minHeight: 160 }} placeholder={'ALBUMS I listened to in 2026\n\n[2026] Gucci Mane - Against All Odds\n\nOn the 21st October since Wop took his first steps… 3/5'} value={text} onChange={(e) => { setText(e.target.value); setPicked({}); setChoice({}); }} />
      {text.trim() && !rows.length && <div className="empty" style={{ marginTop: 12 }}>No reviews found — each needs a heading line like <code>[2026] Artist - Title</code>.</div>}
      {rows.length > 0 && <>
        <div className="row" style={{ margin: '16px 0' }}>
          <strong>{rows.length} reviews</strong>
          <span className="muted small">{[counts.new && `${counts.new} new`, (counts.append || counts.replace) && `${(counts.append ?? 0) + (counts.replace ?? 0)} already have a review`, counts.dup && `${counts.dup} already imported`, counts.none && `${counts.none} not matched`].filter(Boolean).join(' · ')}</span>
          <span className="spacer" />
          <button className="btn primary" disabled={!toSave.length || !!busy} onClick={save}>{busy ? 'Saving…' : `Import ${toSave.length} review${toSave.length === 1 ? '' : 's'}`}</button>
        </div>
        <div className="table-wrap"><table className="table"><tbody>{rows.map(({ nr, c }, i) => {
          const rid = target(i); const r = rid ? ix.releases.get(rid) : undefined; const d = decision(i);
          return (
            <tr key={i} style={d === 'none' ? { background: 'color-mix(in srgb, var(--danger) 8%, transparent)' } : undefined}>
              <td style={{ width: '28%' }}><strong>{nr.title}</strong><div className="small muted">{nr.artist}{nr.year ? ` · ${nr.year}` : ''}</div>
                <div className="small muted" style={{ marginTop: 4, maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={nr.text}>{nr.text.slice(0, 160)}</div></td>
              <td style={{ width: '34%' }}>
                {r && rows[i].check && !(i in picked) && <div className="small" style={{ color: 'var(--star)', marginBottom: 4 }}>Several similar — check it's the right one</div>}
                {r ? <Link to={`/release/${r.id}`} className="row" style={{ gap: 8, flexWrap: 'nowrap' }}><Cover src={r.artwork_url} title={r.title} size={40} /><span><strong>{r.title}</strong><div className="small muted">{r.artist_credit} · {r.year}</div></span></Link>
                  : <span className="small" style={{ color: 'var(--danger)' }}>Not matched</span>}
                {(c.length > 1 || !r) && <select className="select" style={{ marginTop: 6, maxWidth: '100%' }} value={rid} onChange={(e) => setPicked((p) => ({ ...p, [i]: e.target.value }))} aria-label="Which release">
                  <option value="">— none —</option>
                  {[...c.map((m) => m.r), ...(r && !c.some((m) => m.r.id === r.id) ? [r] : [])].map((x) => <option key={x.id} value={x.id}>{x.title} — {x.artist_credit} ({x.year ?? '?'}, {x.type})</option>)}
                </select>}
              </td>
              <td className="small" style={{ width: '20%' }}>
                {d === 'new' && <span>New review</span>}
                {d === 'dup' && <span className="muted">Already imported</span>}
                {(d === 'append' || d === 'replace' || d === 'skip') && <><div className="muted">Already has a review</div>
                  <select className="select" style={{ marginTop: 4 }} value={d} onChange={(e) => setChoice((x) => ({ ...x, [i]: e.target.value as Choice }))} aria-label="What to do with the existing review">
                    <option value="append">Add underneath</option><option value="replace">Replace</option><option value="skip">Skip</option></select></>}
                {d === 'none' && <button className="btn sm" onClick={() => void addToLibrary(i)}>Add it to the library</button>}
              </td>
            </tr>);
        })}</tbody></table></div>
      </>}
    </div>
  );
}
