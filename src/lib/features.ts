import type { Artist } from './types';

/**
 * Featured-artist text in a song title or credit: "(feat. X)", "[ft. X & Y]", "(featuring X)", "(with X)",
 * or a trailing "feat. X" / "ft X" without brackets.
 */
export function featureText(s?: string | null): string[] {
  if (!s) return [];
  const out: string[] = [];
  const bracket = /[([]\s*(?:feat\.?|ft\.?|featuring|with)\s+([^)\]]+)[)\]]/gi;
  let m: RegExpExecArray | null;
  while ((m = bracket.exec(s))) out.push(m[1]);
  if (!out.length) {
    const bare = s.match(/\s(?:feat\.?|ft\.?|featuring)\s+(.+)$/i);
    if (bare) out.push(bare[1]);
  }
  return out.map((x) => x.trim()).filter(Boolean);
}

const SEP = /(\s*,\s*|\s*&\s*|\s+and\s+|\s+x\s+|\s*\+\s*|\s*\/\s*)/i;

/**
 * Split "Mase, Puff Daddy & Kelly Price" into artists you already have. Longest match wins, so a duo in the
 * library ("Cool & Dre") stays whole. Names with no artist in the library come back in `unmatched`.
 */
export function resolveNames(text: string, lookup: (name: string) => Artist | undefined): { matched: Artist[]; unmatched: string[] } {
  const parts = text.split(SEP); // names at even indexes, separators at odd
  const matched: Artist[] = []; const unmatched: string[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    let hit: Artist | undefined; let end = i;
    for (let j = parts.length - 1; j >= i; j -= 2) {
      const a = lookup(parts.slice(i, j + 1).join('').trim());
      if (a) { hit = a; end = j; break; }
    }
    if (hit) { if (!matched.some((x) => x.id === hit!.id)) matched.push(hit); i = end; }
    else { const n = parts[i].trim(); if (n && !/^(?:others|more|friends)$/i.test(n)) unmatched.push(n); }
  }
  return { matched, unmatched };
}

/** All featured names for a song title (and its own artist credit, if it has one). */
export function songFeatures(title: string, artistCredit: string | null | undefined, lookup: (name: string) => Artist | undefined) {
  const matched: Artist[] = []; const unmatched: string[] = [];
  for (const t of [...featureText(title), ...featureText(artistCredit)]) {
    const r = resolveNames(t, lookup);
    for (const a of r.matched) if (!matched.some((x) => x.id === a.id)) matched.push(a);
    for (const n of r.unmatched) if (!unmatched.includes(n)) unmatched.push(n);
  }
  return { matched, unmatched };
}
