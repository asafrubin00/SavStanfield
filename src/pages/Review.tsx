import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Cover } from '../components/ui';
import { mergeLinks } from '../lib/links';
import {
  appleSearchAlbums, caaCover, caaThumb, deezerSearchAlbums, fuzzyArtist, fuzzyTitle, geniusSearch, geniusSong,
  mbLinks, mbSearchGroupsLoose, wikidataToWikipedia,
} from '../lib/sources';
import { releaseArtists, useStore } from '../lib/store';
import type { Release } from '../lib/types';
import { now } from '../lib/util';

interface Cand {
  key: string; source: 'Apple Music' | 'Deezer' | 'MusicBrainz' | 'Genius';
  title: string; artist: string; year?: string; thumb?: string; score: number;
  apply: (r: Release) => Promise<Partial<Release>>;
}

/** Releases still without artwork, out now, and not marked "no cover exists". */
export function needsReview(r: Release, today: string) {
  return !r.artwork_url && !(r.date && r.date > today) && !r.ext.reviewed;
}

export default function Review() {
  const { data, ix, upsert, say } = useStore();
  const today = new Date().toISOString().slice(0, 10);
  const [type, setType] = useState('');
  // Snapshot the queue so items don't jump around as you fix them
  const [queue, setQueue] = useState<string[]>([]);
  const [pos, setPos] = useState(0);
  const build = useCallback(() => {
    const ids = data.releases.filter((r) => needsReview(r, today) && (!type || r.type === type))
      .sort((a, b) => (b.year ?? 0) - (a.year ?? 0) || a.title.localeCompare(b.title)).map((r) => r.id);
    setQueue(ids); setPos(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type]);
  useEffect(build, [build]);
  const remaining = useMemo(() => data.releases.filter((r) => needsReview(r, today)).length, [data.releases, today]);
  const types = useMemo(() => [...new Set(data.releases.filter((r) => needsReview(r, today)).map((r) => r.type))].sort(), [data.releases, today]);

  const r = queue[pos] ? ix.releases.get(queue[pos]) : undefined;
  const artistName = r ? releaseArtists(ix, r.id)[0]?.name ?? r.artist_credit ?? '' : '';
  const [q, setQ] = useState('');
  const [cands, setCands] = useState<Record<string, Cand[] | 'loading' | string>>({});
  const [busy, setBusy] = useState(false);
  const [paste, setPaste] = useState('');
  const req = useRef(0);

  const search = useCallback(async (rel: Release, term: string) => {
    const id = ++req.current;
    const credit = rel.artist_credit ?? '';
    const score = (t: string, a: string) => fuzzyTitle(t, rel.title, a) * 0.6 + fuzzyArtist(credit, a) * 0.4;
    setCands({ Deezer: 'loading', MusicBrainz: 'loading', Genius: 'loading', 'Apple Music': 'loading' });
    const put = (k: string, v: Cand[] | string) => { if (req.current === id) setCands((c) => ({ ...c, [k]: v })); };
    const sorted = (xs: Cand[]) => xs.sort((a, b) => b.score - a.score).slice(0, 6);

    deezerSearchAlbums(term, 10).then((xs) => put('Deezer', sorted(xs.map((d) => ({
      key: `dz${d.id}`, source: 'Deezer' as const, title: d.title, artist: d.artist.name, thumb: d.cover_medium, score: score(d.title, d.artist.name),
      apply: async (x: Release) => ({ artwork_url: d.cover_xl, links: mergeLinks(x.links, { deezer: d.link }), ext: { ...x.ext, deezer_id: d.id } }),
    }))))).catch((e) => put('Deezer', e.message));

    mbSearchGroupsLoose(rel.title, credit || artistName).then((xs) => put('MusicBrainz', sorted(xs.map((g) => ({
      key: `mb${g.id}`, source: 'MusicBrainz' as const, title: g.title, artist: g.artist, year: g.date?.slice(0, 4), thumb: caaThumb(g.id), score: score(g.title, g.artist),
      apply: async (x: Release) => {
        const cover = await caaCover(g.id);
        const { wikidata, ...rest } = await mbLinks('release-group', g.id).catch(() => ({} as Record<string, string>));
        if (!rest.wikipedia && wikidata) rest.wikipedia = await wikidataToWikipedia(wikidata).catch(() => undefined) as string;
        return { artwork_url: cover ?? x.artwork_url, links: mergeLinks(x.links, rest), ext: { ...x.ext, mbid: g.id }, date: x.date ?? (g.date?.length === 10 ? g.date : null) };
      },
    }))))).catch((e) => put('MusicBrainz', e.message));

    geniusSearch(term).then((xs) => put('Genius', sorted(xs.map((h) => ({
      key: `gn${h.id}`, source: 'Genius' as const, title: h.title, artist: h.artist, thumb: h.image, score: fuzzyArtist(credit, h.artist) * 0.6,
      apply: async (x: Release) => {
        const s = await geniusSong(h.id);
        const cover = s.album?.cover_art_url && !/default_cover/.test(s.album.cover_art_url) ? s.album.cover_art_url : h.image;
        return { artwork_url: cover ?? x.artwork_url, links: mergeLinks(x.links, { genius: s.album?.url ?? s.url }) };
      },
    }))))).catch((e) => put('Genius', e.message));

    appleSearchAlbums(term, 8).then((xs) => put('Apple Music', sorted(xs.map((a) => ({
      key: `ap${a.id}`, source: 'Apple Music' as const, title: a.title, artist: a.artist, year: a.date?.slice(0, 4), thumb: a.artwork?.replace('1200x1200bb', '200x200bb'), score: score(a.title, a.artist),
      apply: async (x: Release) => ({ artwork_url: a.artwork ?? x.artwork_url, links: mergeLinks(x.links, { apple: a.url }), ext: { ...x.ext, apple_id: a.id }, date: x.date ?? a.date ?? null }),
    }))))).catch((e) => put('Apple Music', e.message));
  }, [artistName]);

  useEffect(() => {
    if (!r) return;
    const term = `${artistName} ${r.title}`;
    setQ(term); setPaste(''); void search(r, term);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [r?.id]);

  const next = () => setPos((p) => Math.min(p + 1, queue.length));
  const save = async (patch: Partial<Release>, msg: string) => {
    if (!r) return;
    await upsert('releases', [{ ...r, ...patch, ext: { ...r.ext, ...(patch.ext ?? {}) }, updated_at: now() }]);
    say(msg); next();
  };
  async function pick(c: Cand) {
    if (!r || busy) return;
    setBusy(true);
    try {
      const patch = await c.apply(r);
      await save({ ...patch, year: patch.date ? Number(patch.date.slice(0, 4)) : r.year }, patch.artwork_url ? `Saved from ${c.source}` : `Linked to ${c.source} — no cover there`);
    } catch (e) { say((e as Error).message); } finally { setBusy(false); }
  }

  const flat = (['Deezer', 'Apple Music', 'MusicBrainz', 'Genius'] as const).flatMap((k) => Array.isArray(cands[k]) ? cands[k] as Cand[] : []);
  const ranked = [...flat].sort((a, b) => b.score - a.score);
  const shortcut = new Map(ranked.slice(0, 9).map((c, i) => [c.key, i + 1]));

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input,textarea,select')) return;
      const n = Number(e.key);
      if (n >= 1 && n <= 9 && ranked[n - 1]) { e.preventDefault(); void pick(ranked[n - 1]); }
      if (e.key === 's') next();
      if (e.key === 'n' && r) void save({ ext: { ...r.ext, reviewed: true } }, 'Marked: no cover');
      if (e.key === 'ArrowLeft') setPos((p) => Math.max(0, p - 1));
    };
    window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k);
  });

  return (
    <div>
      <div className="row" style={{ marginBottom: 6 }}>
        <h1 className="h-page">Review matches</h1><span className="spacer" />
        <span className="muted num">{remaining.toLocaleString()} without artwork</span>
      </div>
      <p className="muted" style={{ marginTop: 0 }}>Pick the right match and it saves the cover and links, then moves on. Keys: 1–9 pick · S skip · N no cover exists · ← back.</p>
      <div className="row" style={{ margin: '12px 0 20px' }}>
        <button className={`chip${!type ? ' on' : ''}`} onClick={() => setType('')}>All</button>
        {types.map((t) => <button key={t} className={`chip${type === t ? ' on' : ''}`} onClick={() => setType(t)}>{t}</button>)}
      </div>

      {!r ? (
        <div className="empty">{queue.length ? 'You’re through this batch.' : 'Nothing left to review.'} {queue.length > 0 && <button className="btn" onClick={build}>Start again with what’s left</button>}</div>
      ) : (
        <>
          <div className="panel" style={{ display: 'grid', gridTemplateColumns: '96px 1fr auto', gap: 16, alignItems: 'center', marginBottom: 18 }}>
            <Cover src={r.artwork_url} title={r.title} size={96} />
            <div style={{ minWidth: 0 }}>
              <div className="small muted num">{pos + 1} of {queue.length} · {r.type} · {r.year ?? 'no year'}</div>
              <div style={{ fontSize: 26, fontWeight: 800, fontVariationSettings: "'wdth' 75", lineHeight: 1.1 }}>{r.title}</div>
              <div style={{ fontWeight: 600 }}>{r.artist_credit}</div>
            </div>
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <button className="btn" onClick={() => setPos((p) => Math.max(0, p - 1))} disabled={!pos}>Back</button>
              <button className="btn" onClick={next}>Skip</button>
              <button className="btn" onClick={() => save({ ext: { ...r.ext, reviewed: true } }, 'Marked: no cover')}>No cover exists</button>
              <Link className="btn" to={`/release/${r.id}`} target="_blank">Open</Link>
            </div>
          </div>
          <form className="row" style={{ marginBottom: 18 }} onSubmit={(e) => { e.preventDefault(); void search(r, q); }}>
            <input className="input" style={{ flex: 1, minWidth: 200 }} value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search terms" />
            <button className="btn">Search again</button>
            <input className="input" style={{ flex: 1, minWidth: 200 }} placeholder="…or paste an image URL" value={paste} onChange={(e) => setPaste(e.target.value)} />
            <button type="button" className="btn" disabled={!/^https?:\/\//.test(paste)} onClick={() => save({ artwork_url: paste.trim() }, 'Cover saved')}>Use image</button>
          </form>

          {(['Deezer', 'Apple Music', 'MusicBrainz', 'Genius'] as const).map((src) => {
            const v = cands[src];
            return (
              <section key={src} style={{ marginBottom: 18 }}>
                <div className="label" style={{ fontWeight: 600 }}>{src}</div>
                {v === 'loading' || v === undefined ? <div className="small muted">Searching…</div>
                  : typeof v === 'string' ? <div className="small" style={{ color: 'var(--danger)' }}>{v}</div>
                  : !v.length ? <div className="small muted">No results</div> : (
                    <div className="grid tight">{v.map((c) => (
                      <button key={c.key} className="tile" disabled={busy} onClick={() => pick(c)}
                        style={{ textAlign: 'left', border: `2px solid ${c.score >= 0.85 ? 'var(--accent)' : 'transparent'}`, background: 'none', padding: 4, borderRadius: 6, cursor: 'pointer', color: 'inherit' }}>
                        <div style={{ position: 'relative' }}>
                          <Cover src={c.thumb} title={c.title} />
                          {shortcut.get(c.key) && <span className="badge">{shortcut.get(c.key)}</span>}
                        </div>
                        <div className="t">{c.title}</div>
                        <div className="s">{c.artist}{c.year ? ` · ${c.year}` : ''}</div>
                      </button>))}</div>
                  )}
              </section>
            );
          })}
        </>
      )}
    </div>
  );
}
