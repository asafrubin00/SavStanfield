import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { Cover, Credits, Fav, fmtDate } from './ui';
import { usePref } from './controls';
import { songFeatures } from '../lib/features';
import { norm, releaseArtists, trackArtists, useStore, type Index } from '../lib/store';
import type { Artist, EntityType, Release, Track } from '../lib/types';

/** A name in a cell: linked when they're an artist of yours. */
type Name = { name: string; id?: string };
export interface CreditRow {
  key: string;
  cover?: string | null;
  title: string; titleTo: string; fullTitle?: string;
  release?: Release; // its artist credit is shown linked
  artists?: Name[]; // a song's own artists, when it has them
  artistText?: string; // plain text when there's nothing better
  features: Name[];
  producers: Name[]; producerNote?: string;
  album?: { title: string; id: string };
  date: string; // ISO date or year, for showing and sorting
  fav: { type: EntityType; id: string };
  onRemove?: { label: string; run: () => void };
}

const FEAT = /\s*[([]\s*(?:feat\.?|ft\.?|featuring|with)\s+[^)\]]*[)\]]|\s+(?:feat\.?|ft\.?|featuring)\s+.+$/gi;
/** "Lord Above (feat. Eminem & Mary J. Blige)" → "Lord Above" — the features have their own column. */
export const bareTitle = (t: string) => t.replace(FEAT, '').trim() || t;
const names = (as: Artist[]): Name[] => as.map((a) => ({ name: a.name, id: a.id }));
const addNames = (into: Name[], more: Name[]) => { for (const n of more) if (!into.some((x) => (x.id && x.id === n.id) || norm(x.name) === norm(n.name))) into.push(n); return into; };
const whenOf = (r?: Release) => r?.date ?? (r?.year ? String(r.year) : '');

/** Featured artists on a song: credited ones, plus any named in the title that aren't in your library. */
export function trackFeatures(ix: Index, t: Track): Name[] {
  const out = names(trackArtists(ix, t.id, 'featured'));
  const lookup = (n: string) => ix.artistByName.get(norm(n));
  return addNames(out, songFeatures(t.title, t.artist_credit, lookup).unmatched.map((name) => ({ name })));
}
/** Row for a song (an appearance or a production credit). */
export function trackRow(ix: Index, t: Track, r: Release | undefined, extra: Partial<CreditRow> = {}): CreditRow {
  const primary = trackArtists(ix, t.id, 'primary');
  return {
    key: t.id, cover: r?.artwork_url, title: bareTitle(t.title), fullTitle: t.title, titleTo: `/track/${t.id}`,
    release: t.artist_credit || primary.length ? undefined : r,
    artists: primary.length ? names(primary) : undefined, artistText: primary.length ? undefined : t.artist_credit ?? undefined,
    features: trackFeatures(ix, t), producers: names(trackArtists(ix, t.id, 'producer')),
    album: r ? { title: r.title, id: r.id } : undefined, date: whenOf(r), fav: { type: 'track', id: t.id }, ...extra,
  };
}
/** Row for a whole release (a single, a leak, a guest appearance): features and producers come from its songs. */
export function releaseRow(ix: Index, r: Release, extra: Partial<CreditRow> = {}): CreditRow {
  const tracks = ix.tracksByRelease.get(r.id) ?? [];
  const features: Name[] = []; const producers: Name[] = [];
  for (const t of tracks) { addNames(features, trackFeatures(ix, t)); addNames(producers, names(trackArtists(ix, t.id, 'producer'))); }
  if (!tracks.length) addNames(features, songFeatures(r.title, null, (n) => ix.artistByName.get(norm(n))).matched.map((a) => ({ name: a.name, id: a.id })));
  const exec = names(releaseArtists(ix, r.id, 'exec_producer'));
  return {
    key: r.id, cover: r.artwork_url, title: bareTitle(r.title.replace(/\s*-\s*(single|ep)$/i, '')), fullTitle: r.title, titleTo: `/release/${r.id}`,
    release: r, features, producers: producers.length ? producers : exec, producerNote: producers.length || !exec.length ? undefined : 'exec.',
    album: { title: r.title, id: r.id }, date: whenOf(r), fav: { type: 'release', id: r.id }, ...extra,
  };
}

/** A cell that trails off with "…" and shows everything in a small popup when you hover over it. */
function Clip({ children, full }: { children: ReactNode; full?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number; w: number } | null>(null);
  const hide = useRef<number>();
  const show = () => {
    window.clearTimeout(hide.current);
    const el = ref.current; if (!el || el.scrollWidth <= el.clientWidth + 1) return;
    const b = el.getBoundingClientRect(); setPos({ x: b.left, y: b.bottom + 4, w: Math.max(b.width, 260) });
  };
  const later = () => { hide.current = window.setTimeout(() => setPos(null), 120); };
  useEffect(() => () => window.clearTimeout(hide.current), []);
  useLayoutEffect(() => { if (!pos) return; const off = () => setPos(null); window.addEventListener('scroll', off, true); return () => window.removeEventListener('scroll', off, true); }, [pos]);
  return (
    <>
      <div ref={ref} className="clip" onMouseEnter={show} onMouseLeave={later}>{children}</div>
      {pos && createPortal(<div className="clip-pop" style={{ left: Math.min(pos.x, window.innerWidth - pos.w - 12), top: pos.y, maxWidth: pos.w }} onMouseEnter={() => window.clearTimeout(hide.current)} onMouseLeave={later}>{full ?? children}</div>, document.body)}
    </>
  );
}
const NameList = ({ ns, note, sep = '; ' }: { ns: Name[]; note?: string; sep?: string }) => <>{ns.map((n, i) => <span key={`${n.id ?? n.name}${i}`}>{i ? sep : ''}{n.id ? <Link to={`/artist/${n.id}`}>{n.name}</Link> : n.name}</span>)}{note && <span className="muted"> ({note})</span>}</>;

type Col = 'title' | 'artist' | 'features' | 'producers' | 'album' | 'date' | 'fav';
const COLS: [Col, string][] = [['title', 'Song'], ['artist', 'Artist'], ['features', 'Features'], ['producers', 'Producers'], ['album', 'Album / release'], ['date', 'Date'], ['fav', '♥']];

/**
 * A collapsible section of songs/releases on an artist page: click the heading to open or close it (remembered),
 * click a column to sort, type to filter.
 */
export function CreditSection({ id, title, rows, onOpen }: { id: string; title: string; rows: CreditRow[]; onOpen?: () => void }) {
  const st = useStore();
  const [open, setOpen] = usePref(`artist.sec.${id}`, false);
  const [sort, setSort] = usePref<{ col: Col; asc: boolean }>(`artist.sec.${id}.sort`, { col: 'date', asc: false });
  const [q, setQ] = useState('');
  useEffect(() => { if (open) onOpen?.(); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!rows.length) return null;

  const artistOf = (r: CreditRow) => r.artists?.map((x) => x.name).join(' & ') ?? r.artistText ?? r.release?.artist_credit ?? '';
  const text = (r: CreditRow, c: Col): string => {
    switch (c) {
      case 'title': return r.title; case 'artist': return artistOf(r); case 'album': return r.album?.title ?? '';
      case 'features': return r.features.map((n) => n.name).join('; '); case 'producers': return r.producers.map((n) => n.name).join('; ');
      case 'date': return r.date; case 'fav': return st.annotation(r.fav.type, r.fav.id)?.favorite ? '1' : '';
    }
  };
  const n = norm(q);
  const shown = rows.filter((r) => !n || norm([r.fullTitle ?? r.title, artistOf(r), text(r, 'features'), text(r, 'producers'), text(r, 'album')].join(' ')).includes(n));
  shown.sort((x, y) => {
    const a = text(x, sort.col), b = text(y, sort.col);
    if (!a !== !b) return a ? -1 : 1; // blanks last either way
    const c = a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true }) || y.date.localeCompare(x.date);
    return sort.asc ? c : -c;
  });
  const by = (c: Col) => setSort(sort.col === c ? { col: c, asc: !sort.asc } : { col: c, asc: c !== 'date' && c !== 'fav' });

  return (
    <section className="credit-sec">
      <div className="credit-head">
        <button type="button" className="sec-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          <span className="caret" aria-hidden>{open ? '▾' : '▸'}</span><span className="h-sec">{title}</span><span className="muted">{rows.length}</span>
        </button>
        {open && rows.length > 5 && <input className="input sm" placeholder={`Filter ${title.toLowerCase()}…`} aria-label={`Filter ${title}`} value={q} onChange={(e) => setQ(e.target.value)} />}
        {open && q && <span className="small muted">{shown.length} of {rows.length}</span>}
      </div>
      {open && <div className="table-wrap"><table className="table credit-table">
        <colgroup><col style={{ width: 40 }} /><col style={{ width: '22%' }} /><col style={{ width: '14%' }} /><col style={{ width: '17%' }} /><col style={{ width: '17%' }} /><col style={{ width: '18%' }} /><col style={{ width: 104 }} /><col style={{ width: 40 }} /></colgroup>
        <thead><tr><th />{COLS.map(([c, label]) => (
          <th key={c} onClick={() => by(c)} aria-sort={sort.col === c ? (sort.asc ? 'ascending' : 'descending') : undefined} style={c === 'fav' ? { textAlign: 'center' } : undefined}>
            {label}{sort.col === c ? (sort.asc ? ' ↑' : ' ↓') : ''}</th>))}</tr></thead>
        <tbody>{shown.map((r) => {
          const fav = st.annotation(r.fav.type, r.fav.id)?.favorite;
          return (
            <tr key={r.key}>
              <td className="thumb">{r.album ? <Link to={`/release/${r.album.id}`}><Cover src={r.cover} title={r.album.title} size={28} /></Link> : <Cover src={r.cover} title={r.title} size={28} />}</td>
              <td><div className="title-cell"><Clip full={r.fullTitle ?? r.title}><Link to={r.titleTo} style={{ fontWeight: 600 }} title={r.fullTitle !== r.title ? r.fullTitle : undefined}>{r.title}</Link></Clip>{r.onRemove && <button type="button" className="btn sm ghost row-x" title={r.onRemove.label} aria-label={r.onRemove.label} onClick={r.onRemove.run}>×</button>}</div></td>
              <td><Clip>{r.artists ? <NameList ns={r.artists} sep=" & " /> : r.artistText ?? (r.release ? <Credits release={r.release} /> : '')}</Clip></td>
              <td><Clip><NameList ns={r.features} /></Clip></td>
              <td><Clip><NameList ns={r.producers} note={r.producerNote} /></Clip></td>
              <td><Clip>{r.album && <Link to={`/release/${r.album.id}`}>{r.album.title}</Link>}</Clip></td>
              <td className="num muted small" style={{ whiteSpace: 'nowrap' }}>{r.date.length > 4 ? fmtDate(r.date) : r.date}</td>
              <td style={{ textAlign: 'center' }}><Fav on={!!fav} onToggle={() => void st.annotate(r.fav.type, r.fav.id, { favorite: !fav })} /></td>
            </tr>);
        })}</tbody>
      </table></div>}
      {open && !shown.length && <div className="small muted" style={{ padding: '8px 0' }}>Nothing matches “{q}”.</div>}
    </section>
  );
}
