import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { autoId, criticScore, fetchReviews, planCriticScores, SRC_NAME, type Maybe, type Src } from '../lib/critics';
import { useStore } from '../lib/store';
import type { Release } from '../lib/types';
import { now } from '../lib/util';

const LAST = 'critics.lastRun';
export const lastCriticRun = (): { at: string; p4k: number; drop: number; maybe: number } | null => { try { return JSON.parse(localStorage.getItem(LAST) ?? 'null'); } catch { return null; } };

/** Fetch both datasets, match them to the library and save the differences. */
export function useCriticRefresh() {
  const st = useStore();
  const live = useRef(st); live.current = st;
  const [busy, setBusy] = useState(false);
  const run = useCallback(async (quiet = false) => {
    setBusy(true);
    try {
      if (!quiet) live.current.say('Fetching Pitchfork and Fantano scores…');
      const reviews = await fetchReviews();
      const s = live.current;
      const plan = planCriticScores(s.data, reviews);
      if (plan.upsert.length) await s.upsert('critic_scores', plan.upsert);
      if (plan.remove.length) await s.remove('critic_scores', plan.remove);
      if (plan.releases.length) await s.upsert('releases', plan.releases.map((r) => ({ ...r, updated_at: now() })));
      const res = { at: now(), ...plan.counts };
      try { localStorage.setItem(LAST, JSON.stringify(res)); } catch { /* storage blocked */ }
      const changed = plan.upsert.length + plan.remove.length;
      if (!quiet || changed) s.say(`Critic scores: ${plan.counts.p4k.toLocaleString()} Pitchfork, ${plan.counts.drop.toLocaleString()} Fantano${changed ? ` (${changed} new or changed)` : ''}${plan.counts.maybe ? ` · ${plan.counts.maybe} possible matches to check in Import & settings` : ''}`);
      return res;
    } catch (e) { if (!quiet) live.current.say(`Couldn't get critic scores: ${(e as Error).message}`); return null; }
    finally { setBusy(false); }
  }, []);
  return { run, busy };
}

/** Once a week, quietly, when the site is open with your library loaded. */
export function CriticAutoRefresh() {
  const { loading, data } = useStore();
  const { run } = useCriticRefresh();
  const done = useRef(false);
  useEffect(() => {
    if (done.current || loading || !data.releases.length) return;
    const last = lastCriticRun();
    if (last && Date.now() - new Date(last.at).getTime() < 7 * 864e5) { done.current = true; return; }
    done.current = true;
    const t = window.setTimeout(() => void run(true), 8000); // after everything else has loaded
    return () => window.clearTimeout(t);
  }, [loading, data.releases.length, run]);
  return null;
}

/** Say yes or no to a doubtful match. Yes pins it (kept on every refresh); no is never suggested again. */
export function useMaybe() {
  const { upsert, ix } = useStore();
  return {
    accept: async (r: Release, m: Maybe) => {
      const cur = ix.releases.get(r.id) ?? r; const ext = cur.ext as Record<string, unknown>;
      await upsert('critic_scores', [{ id: autoId(m.src, r.id), release_id: r.id, source: SRC_NAME[m.src], score: m.score, max: 10, url: m.url }]);
      const rest = ((ext.critic_maybe as Maybe[] | undefined) ?? []).filter((x) => x.src !== m.src);
      const bnm = m.src === 'p4k' && (m.bnm || m.bnr) ? (m.bnr ? 'bnr' : 'bnm') : ext.p4k_bnm;
      await upsert('releases', [{ ...cur, ext: { ...ext, critic_pin: { ...(ext.critic_pin as object ?? {}), [m.src]: m.key }, critic_maybe: rest.length ? rest : undefined, p4k_bnm: bnm } as Release['ext'], updated_at: now() }]);
    },
    reject: async (r: Release, m: Maybe) => {
      const cur = ix.releases.get(r.id) ?? r; const ext = cur.ext as Record<string, unknown>;
      const rest = ((ext.critic_maybe as Maybe[] | undefined) ?? []).filter((x) => x.key !== m.key);
      await upsert('releases', [{ ...cur, ext: { ...ext, critic_no: [...new Set([...((ext.critic_no as string[]) ?? []), m.key])], critic_maybe: rest.length ? rest : undefined } as Release['ext'], updated_at: now() }]);
    },
  };
}

/** "Pitchfork 7.4 · Best New Music" and "Fantano 7/10", each linking to the review; plus any match to confirm. */
export function CriticLines({ release }: { release: Release }) {
  const { ix } = useStore();
  const M = useMaybe();
  const scores = ix.scoresByRelease.get(release.id);
  const maybes = ((release.ext as Record<string, unknown>).critic_maybe as Maybe[] | undefined) ?? [];
  const bnm = (release.ext as Record<string, unknown>).p4k_bnm as string | undefined;
  const rows = (['p4k', 'drop'] as Src[]).map((src) => ({ src, s: criticScore(scores, src) })).filter((x) => x.s);
  if (!rows.length && !maybes.length) return null;
  return (
    <div className="critic-lines">
      {rows.map(({ src, s }) => (
        <div key={src} className="critic-line">
          <span className="label" style={{ margin: 0 }}>{SRC_NAME[src]}</span><span className="spacer" />
          {s!.url ? <a href={s!.url} target="_blank" rel="noreferrer" className="critic-score">{fmtScore(s!.score!)}</a> : <span className="critic-score">{fmtScore(s!.score!)}</span>}
          <span className="muted small">/ 10</span>
          {src === 'p4k' && bnm && <span className="bnm" title={bnm === 'bnr' ? 'Best New Reissue' : 'Best New Music'}>{bnm === 'bnr' ? 'BNR' : 'BNM'}</span>}
        </div>))}
      {maybes.map((m) => (
        <div key={m.key} className="critic-maybe small">
          <span className="muted">Possible {SRC_NAME[m.src]}:</span> <a href={m.url} target="_blank" rel="noreferrer">{m.artist} — {m.title}</a> <span className="num">{fmtScore(m.score)}</span>
          <span className="row" style={{ gap: 4, marginTop: 4 }}><button type="button" className="btn sm" onClick={() => void M.accept(release, m)}>Use</button><button type="button" className="btn sm ghost" onClick={() => void M.reject(release, m)}>Not this</button></span>
        </div>))}
    </div>
  );
}
export const fmtScore = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

/** Import & settings: refresh button, last run, and every possible match in one place. */
export function CriticSettings() {
  const { data } = useStore();
  const { run, busy } = useCriticRefresh();
  const M = useMaybe();
  const [last, setLast] = useState(lastCriticRun);
  const maybe = data.releases.filter((r) => ((r.ext as Record<string, unknown>).critic_maybe as Maybe[] | undefined)?.length);
  return (
    <section>
      <h2 className="h-sec">Critic scores</h2>
      <p className="muted" style={{ marginTop: 0 }}>Pitchfork and Fantano scores matched to your releases, from two fan-run datasets (The Fork and The Drop) that update daily. Refreshes itself about once a week; a score you add by hand always wins.</p>
      <div className="row">
        <button className="btn primary" disabled={busy} onClick={async () => { const r = await run(); if (r) setLast(r); }}>{busy ? 'Updating…' : 'Update critic scores'}</button>
        {last && <span className="small muted">Last updated {new Date(last.at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} · {last.p4k.toLocaleString()} Pitchfork · {last.drop.toLocaleString()} Fantano</span>}
      </div>
      {maybe.length > 0 && <>
        <h3 className="small" style={{ margin: '16px 0 6px' }}>Possible matches to check ({maybe.length})</h3>
        <div className="table-wrap"><table className="table"><tbody>{maybe.flatMap((r) => (((r.ext as Record<string, unknown>).critic_maybe as Maybe[]) ?? []).map((m) => (
          <tr key={`${r.id}${m.key}`}>
            <td><Link to={`/release/${r.id}`} style={{ fontWeight: 600 }}>{r.title}</Link><div className="small muted">{r.artist_credit} · {r.year}</div></td>
            <td className="small">{SRC_NAME[m.src]}: <a href={m.url} target="_blank" rel="noreferrer">{m.artist} — {m.title}</a> <span className="num">{fmtScore(m.score)}</span></td>
            <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}><button className="btn sm" onClick={() => void M.accept(r, m)}>Use</button> <button className="btn sm ghost" onClick={() => void M.reject(r, m)}>Not this</button></td>
          </tr>)))}</tbody></table></div>
      </>}
    </section>
  );
}
