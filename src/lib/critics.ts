/*
 * Pitchfork and Fantano scores, matched onto your releases.
 * Sources (both public, refreshed daily by their maintainer, fetched straight from the browser):
 *   Pitchfork — The Fork's dataset on GitHub (olievans123/the-fork, album-index.json)
 *   Fantano   — The Drop's data file (the-drop-reviews.vercel.app/drops.json)
 * Scores are stored as critic_scores rows with ids "auto:p4k:<release>" / "auto:drop:<release>", so a score you
 * add by hand always wins and is never touched. Doubtful matches are kept on the release to confirm or reject.
 */
import type { CriticScore, DataSet, Release } from './types';

export const FORK_URL = 'https://raw.githubusercontent.com/olievans123/the-fork/main/album-index.json';
export const DROP_URL = 'https://the-drop-reviews.vercel.app/drops.json';
export type Src = 'p4k' | 'drop';
export const SRC_NAME: Record<Src, string> = { p4k: 'Pitchfork', drop: 'Fantano' };
export const autoId = (src: Src, releaseId: string) => `auto:${src}:${releaseId}`;
export const isAuto = (s: CriticScore) => s.id.startsWith('auto:');

export interface Review { src: Src; key: string; artist: string; title: string; score: number; url: string; bnm?: boolean; bnr?: boolean; year?: number; reviewer?: string }
/** On a release: a doubtful match waiting for you ("Use" / "Not this"). */
export interface Maybe { src: Src; key: string; artist: string; title: string; score: number; url: string; bnm?: boolean; bnr?: boolean }

const ENT: Record<string, string> = { amp: '&', quot: '"', apos: "'", '#39': "'", lt: '<', gt: '>', nbsp: ' ' };
const unescape = (s: string) => s.replace(/&(amp|quot|apos|#39|lt|gt|nbsp);/g, (_, e: string) => ENT[e]).replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)));

export async function fetchReviews(): Promise<Review[]> {
  const [fork, drop] = await Promise.all([
    fetch(FORK_URL).then((r) => { if (!r.ok) throw new Error(`Pitchfork data: ${r.status}`); return r.json() as Promise<Record<string, { ar: string; ti: string; sc: number; u: string; d?: string; bnm?: boolean; bnr?: boolean; rv?: string }>>; }),
    fetch(DROP_URL).then((r) => { if (!r.ok) throw new Error(`Fantano data: ${r.status}`); return r.json() as Promise<{ id: string; artist: string; title: string; score: number; url: string; releaseYear?: number; date?: string }[]>; }),
  ]);
  const out: Review[] = [];
  for (const [slug, x] of Object.entries(fork)) {
    if (typeof x.sc !== 'number') continue;
    out.push({ src: 'p4k', key: `p4k:${slug}`, artist: unescape(x.ar), title: unescape(x.ti), score: x.sc, url: `https://pitchfork.com${x.u}`, bnm: x.bnm, bnr: x.bnr, year: x.d ? Number(x.d.slice(0, 4)) : undefined, reviewer: x.rv });
  }
  for (const x of drop) {
    if (typeof x.score !== 'number') continue;
    out.push({ src: 'drop', key: `drop:${x.id}`, artist: unescape(x.artist), title: unescape(x.title), score: x.score, url: x.url, year: x.releaseYear ?? (x.date ? Number(x.date.slice(0, 4)) : undefined) });
  }
  return out;
}

// ——— Matching ———
const EDITION = /\b(deluxe|expanded|remaster(?:ed)?|anniversary|reissue|edition|bonus tracks?|super|collector'?s|legacy|complete|box set)\b/i;
const fold = (s: string) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
/** "The Marshall Mathers LP (Deluxe Edition)" → "marshallmatherslp" */
export const titleKey = (t: string) => fold(t)
  .replace(/\s*[([][^)\]]*[)\]]/g, (m) => (EDITION.test(m) || /\b(feat|ft|with)\b/.test(m) ? '' : m))
  .replace(/\s+-\s+(single|ep)$/, '').replace(/\$/g, 's').replace(/&/g, ' and ').replace(/^the\s+/, '').replace(/[^a-z0-9]+/g, '');
export const artistKey = (a: string) => fold(a).replace(/\$/g, 's').replace(/&/g, ' and ').replace(/^the\s+/, '').replace(/[^a-z0-9]+/g, '');
const splitArtists = (a: string) => [a, ...a.split(/\s*(?:,|&|\/|\band\b|\bx\b|\bwith\b|\bfeat\.?|\bft\.?)\s*/i)].map(artistKey).filter((k) => k.length > 1);
const isReissueTitle = (t: string) => EDITION.test(t);
const bigrams = (s: string) => { const b = new Set<string>(); for (let i = 0; i < s.length - 1; i++) b.add(s.slice(i, i + 2)); return b; };
const dice = (a: string, b: string) => { if (a === b) return 1; const A = bigrams(a), B = bigrams(b); let n = 0; for (const x of A) if (B.has(x)) n++; return (2 * n) / (A.size + B.size || 1); };

/**
 * Close enough to ask you about: a spelling variant ("Tha"/"The", "Pt."/"Part"), not a different album.
 * Sequels and spin-offs ("Doe or Die II", "Tha Carter V", "Madvillainy Demos", "Stillmatic" for "Illmatic") are ruled out.
 */
const romans = (t: string) => (fold(t).match(/\b[ivx]{1,4}\b/g) ?? []).join(',');
function similar(a: string, b: string, rawA: string, rawB: string) {
  if (a.slice(0, 4) !== b.slice(0, 4)) return false;
  if (romans(rawA) !== romans(rawB)) return false;
  if (a.startsWith(b) || b.startsWith(a)) return false;
  const nums = (x: string) => (x.match(/\d+/g) ?? []).join(',');
  if (nums(a) !== nums(b)) return false;
  return dice(a, b) >= 0.85;
}
const MATCHABLE = /^(album|mixtape|ep|collaboration|deluxe|compilation|soundtrack|live|greatest hits|unreleased album|other)$/i;

export interface Plan {
  upsert: CriticScore[]; remove: string[]; releases: Release[];
  counts: { p4k: number; drop: number; maybe: number };
}

/**
 * Work out what should change: which automatic scores to add/replace/remove, and which releases get new
 * "possible match" notes or Best New Music flags. Nothing is saved here.
 */
export function planCriticScores(data: DataSet, reviews: Review[]): Plan {
  const byArtist = new Map<string, Review[]>();
  for (const r of reviews) for (const k of new Set(splitArtists(r.artist))) (byArtist.get(k) ?? byArtist.set(k, []).get(k)!).push(r);

  const artistsById = new Map(data.artists.map((a) => [a.id, a]));
  const primaryNames = new Map<string, string[]>();
  for (const c of data.credits) if (c.role === 'primary' && c.release_id) {
    const a = artistsById.get(c.artist_id); if (!a) continue;
    (primaryNames.get(c.release_id) ?? primaryNames.set(c.release_id, []).get(c.release_id)!).push(a.name, ...a.aliases);
  }
  const scores = new Map<string, CriticScore[]>();
  for (const s of data.critic_scores) (scores.get(s.release_id) ?? scores.set(s.release_id, []).get(s.release_id)!).push(s);

  const plan: Plan = { upsert: [], remove: [], releases: [], counts: { p4k: 0, drop: 0, maybe: 0 } };
  for (const rel of data.releases) {
    const mine = scores.get(rel.id) ?? [];
    const ext = rel.ext as Record<string, unknown>;
    const rejected = new Set((ext.critic_no as string[] | undefined) ?? []);
    const pinned = (ext.critic_pin as Record<string, string> | undefined) ?? {};
    const wantReissue = rel.type === 'Deluxe' || isReissueTitle(rel.title);
    const tk = titleKey(rel.title);
    const aks = new Set([...(primaryNames.get(rel.id) ?? []), rel.artist_credit ?? ''].flatMap(splitArtists));
    const cands = MATCHABLE.test(rel.type) && tk ? [...new Set([...aks].flatMap((k) => byArtist.get(k) ?? []))] : [];
    const maybes: Maybe[] = []; let bnm: string | undefined;

    for (const src of ['p4k', 'drop'] as Src[]) {
      // A score you added by hand, or an automatic one you removed: leave this source alone
      const manual = mine.some((s) => !s.id.startsWith('auto:') && s.source.toLowerCase() === SRC_NAME[src].toLowerCase()) || !!(ext.critic_off as Record<string, boolean> | undefined)?.[src];
      const id = autoId(src, rel.id);
      const cur = mine.find((s) => s.id === id);
      let pick: Review | undefined;
      if (!manual) {
        const pinKey = pinned[src];
        const pool = cands.filter((c) => c.src === src && !rejected.has(c.key) && isReissueTitle(c.title) === wantReissue && !(src === 'p4k' && c.bnr && !wantReissue));
        if (pinKey) pick = reviews.find((r) => r.key === pinKey);
        else {
          const exact = pool.filter((c) => titleKey(c.title) === tk);
          // Two reviews with the same title (self-titled albums, say): the one nearest the release year.
          // (Pitchfork's date is the review date, so an old classic reviewed years later still counts.)
          const near = (c: Review) => Math.abs((c.year ?? rel.year ?? 0) - (rel.year ?? c.year ?? 0));
          exact.sort((x, y) => near(x) - near(y));
          if (exact.length) pick = exact[0];
          else {
            const close = [...exact, ...pool.filter((c) => { const ck = titleKey(c.title); return ck !== tk && similar(ck, tk, c.title, rel.title); })]
              .sort((x, y) => dice(titleKey(y.title), tk) - dice(titleKey(x.title), tk)).slice(0, 2);
            for (const c of close) maybes.push({ src, key: c.key, artist: c.artist, title: c.title, score: c.score, url: c.url, bnm: c.bnm, bnr: c.bnr });
          }
        }
      }
      if (pick) {
        plan.counts[src]++;
        if (src === 'p4k' && (pick.bnm || pick.bnr)) bnm = pick.bnr ? 'bnr' : 'bnm';
        if (!cur || cur.score !== pick.score || cur.url !== pick.url) plan.upsert.push({ id, release_id: rel.id, source: SRC_NAME[src], score: pick.score, max: 10, url: pick.url });
      } else if (cur) plan.remove.push(id);
    }
    plan.counts.maybe += maybes.length ? 1 : 0;
    const oldMaybe = JSON.stringify(ext.critic_maybe ?? []); const newMaybe = JSON.stringify(maybes);
    if (oldMaybe !== newMaybe || (ext.p4k_bnm ?? undefined) !== bnm) {
      const next = { ...ext, critic_maybe: maybes.length ? maybes : undefined, p4k_bnm: bnm };
      plan.releases.push({ ...rel, ext: next as Release['ext'] });
    }
  }
  return plan;
}

/** The score shown for a source on a release: yours if you added one, otherwise the automatic one. */
export function criticScore(scores: CriticScore[] | undefined, src: Src): CriticScore | undefined {
  const name = SRC_NAME[src].toLowerCase();
  const list = (scores ?? []).filter((s) => s.source.toLowerCase() === name && s.score != null);
  return list.find((s) => !isAuto(s)) ?? list[0];
}
