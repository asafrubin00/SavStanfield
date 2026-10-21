import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { LINK_META, searchLinks } from '../lib/links';
import { releaseArtists, useStore } from '../lib/store';
import type { Artist, EntityType, LinkKey, Links, Release } from '../lib/types';

export function hue(s: string) { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360; return h; }

export function Cover({ src, title, round, size, eager }: { src?: string | null; title: string; round?: boolean; size?: number; eager?: boolean }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [src]);
  const style = size ? { width: size, height: size, flex: `0 0 ${size}px` } : undefined;
  const h = hue(title);
  return (
    <div className={`cover${round ? ' avatar' : ''}`} style={style}>
      {src && !broken
        ? <img src={src} alt="" loading={eager ? 'eager' : 'lazy'} onError={() => setBroken(true)} />
        : <div className="ph" style={{ background: `linear-gradient(160deg, hsl(${h} 32% 42%), hsl(${(h + 40) % 360} 38% 22%))`, fontSize: size && size < 60 ? 10 : undefined }}>{size && size < 60 ? '' : title}</div>}
    </div>
  );
}

export function Stars({ value, onChange, small }: { value?: number | null; onChange?: (v: number | null) => void; small?: boolean }) {
  const v = value ?? 0;
  return (
    <span className={`stars${small ? ' sm' : ''}${onChange ? '' : ' ro'}`} role={onChange ? 'radiogroup' : undefined} aria-label={`Rating ${v || 'none'} of 5`}>
      {[1, 2, 3, 4, 5].map((n) => (
        <button key={n} type="button" className={n <= v ? 'on' : ''} tabIndex={onChange ? 0 : -1}
          aria-label={`${n} star${n > 1 ? 's' : ''}`} disabled={!onChange}
          onClick={() => onChange?.(v === n ? null : n)}>★</button>
      ))}
    </span>
  );
}

export function Fav({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return <button type="button" className={`fav${on ? ' on' : ''}`} aria-pressed={on} aria-label={on ? 'Remove favourite' : 'Add favourite'} title={on ? 'Favourite' : 'Mark as favourite'} onClick={onToggle}>♥</button>;
}

/** Rating + favourite for any entity, compact. */
export function QuickRate({ type, id }: { type: EntityType; id: string }) {
  const { annotation, annotate } = useStore();
  const a = annotation(type, id);
  return (
    <span className="row" style={{ gap: 4, flexWrap: 'nowrap' }}>
      <Stars value={a?.rating} onChange={(rating) => annotate(type, id, { rating })} />
      <Fav on={!!a?.favorite} onToggle={() => annotate(type, id, { favorite: !a?.favorite })} />
    </span>
  );
}

function AutoText({ label, value, onSave, placeholder }: { label: string; value: string; onSave: (v: string) => void; placeholder: string }) {
  const [v, setV] = useState(value);
  const [saved, setSaved] = useState(false);
  useEffect(() => setV(value), [value]);
  const t = useRef<number>();
  const commit = (x: string) => { if (x !== value) { onSave(x); setSaved(true); window.setTimeout(() => setSaved(false), 1500); } };
  return (
    <label style={{ display: 'block' }}>
      <span className="label">{label} {saved && <span style={{ color: 'var(--accent)' }}>· saved</span>}</span>
      <textarea className="textarea" value={v} placeholder={placeholder}
        onChange={(e) => { setV(e.target.value); window.clearTimeout(t.current); const x = e.target.value; t.current = window.setTimeout(() => commit(x), 1200); }}
        onBlur={() => { window.clearTimeout(t.current); commit(v); }} />
    </label>
  );
}

export function AnnotationPanel({ type, id }: { type: EntityType; id: string }) {
  const { annotation, annotate } = useStore();
  const a = annotation(type, id);
  return (
    <div className="panel stack">
      <div className="row"><span className="label" style={{ margin: 0 }}>Your rating</span><span className="spacer" /><QuickRate type={type} id={id} /></div>
      <AutoText label="Review" value={a?.review ?? ''} placeholder="What you think of it" onSave={(review) => annotate(type, id, { review })} />
      <AutoText label="Notes" value={a?.notes ?? ''} placeholder="Anything to remember — context, standout tracks, where you heard it" onSave={(notes) => annotate(type, id, { notes })} />
      {a?.updated_at && <div className="small muted">Last changed {new Date(a.updated_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}</div>}
    </div>
  );
}

/** Pinned links are solid; links we haven't pinned yet fall back to a search on that site (dashed). */
export function LinkBar({ links, kind, name, artist, onEdit, extra }: { links: Links; kind: 'artist' | 'release' | 'track' | 'label'; name: string; artist?: string; onEdit?: () => void; extra?: ReactNode }) {
  const fallback = searchLinks(kind, name, artist);
  const shown = LINK_META.filter((m) => links[m.key] || fallback[m.key]);
  return (
    <div className="links">
      {shown.map((m) => {
        const pinned = links[m.key];
        return <a key={m.key} className={`link${pinned ? '' : ' search'}`} href={pinned ?? fallback[m.key]} target="_blank" rel="noreferrer" title={pinned ? `Open on ${m.label}` : `Search ${m.label}`}>{m.label}</a>;
      })}
      {extra}
      {onEdit && <button className="btn sm ghost" onClick={onEdit}>Edit links</button>}
    </div>
  );
}

export function LinksEditor({ links, onSave, onClose }: { links: Links; onSave: (l: Links) => void; onClose: () => void }) {
  const [v, setV] = useState<Links>({ ...links });
  return (
    <Modal title="Edit links" onClose={onClose}>
      <p className="small muted" style={{ marginTop: -8 }}>Paste the exact page for each site. Leave blank to fall back to a search.</p>
      <div className="form-grid">
        {LINK_META.map((m) => (
          <label key={m.key}><span className="label">{m.label}</span>
            <input className="input" style={{ width: '100%' }} value={v[m.key] ?? ''} placeholder="https://…"
              onChange={(e) => setV({ ...v, [m.key]: e.target.value.trim() || undefined })} /></label>
        ))}
      </div>
      <div className="row" style={{ marginTop: 18 }}><span className="spacer" /><button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={() => { const clean = Object.fromEntries(Object.entries(v).filter(([, x]) => x)) as Links; onSave(clean); onClose(); }}>Save links</button></div>
    </Modal>
  );
}

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="modal-bg" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} style={wide ? { width: 'min(980px, 100%)' } : undefined}>
        <div className="row" style={{ marginBottom: 4 }}><h2 style={{ margin: 0 }}>{title}</h2><span className="spacer" /><button className="btn ghost sm" onClick={onClose} aria-label="Close">Close</button></div>
        <div style={{ marginTop: 14 }}>{children}</div>
      </div>
    </div>
  );
}

export function AddToList({ type, id }: { type: EntityType; id: string }) {
  const { data, addToList, upsert } = useStore();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  if (!open) return <button className="btn" onClick={() => setOpen(true)}>Add to list</button>;
  return (
    <span className="row">
      <select className="select" autoFocus defaultValue="" onChange={async (e) => { if (e.target.value) { await addToList(e.target.value, type, id); setOpen(false); } }}>
        <option value="" disabled>Choose a list…</option>
        {[...data.lists].filter((l) => l.kind !== 'folder' && (type === 'artist' ? l.kind !== 'playlist' : l.kind !== 'artists')).sort((a, b) => a.name.localeCompare(b.name)).map((l) => <option key={l.id} value={l.id}>{l.name}{l.kind === 'artists' ? ' (artists)' : ''}</option>)}
      </select>
      <input className="input" placeholder="or new list name" value={name} onChange={(e) => setName(e.target.value)} style={{ width: 160 }} />
      <button className="btn" disabled={!name.trim()} onClick={async () => {
        const id2 = crypto.randomUUID();
        await upsert('lists', [{ id: id2, name: name.trim(), ranked: false, kind: type === 'artist' ? 'artists' : 'list', created_at: new Date().toISOString(), updated_at: new Date().toISOString() }]);
        await addToList(id2, type, id); setOpen(false); setName('');
      }}>Create</button>
      <button className="btn ghost" onClick={() => setOpen(false)}>Cancel</button>
    </span>
  );
}

/** Artist credit text with each credited artist linked. */
export function Credits({ release }: { release: Release }) {
  const { ix } = useStore();
  const artists = releaseArtists(ix, release.id);
  if (!artists.length) return <span>{release.artist_credit}</span>;
  const credit = release.artist_credit ?? artists.map((a) => a.name).join(' & ');
  // Link names in place where they appear in the credit string; otherwise list them.
  const parts: ReactNode[] = []; let rest = credit; let k = 0;
  for (const a of artists) {
    const i = rest.toLowerCase().indexOf(a.name.toLowerCase());
    if (i < 0) continue;
    if (i > 0) parts.push(<span key={k++}>{rest.slice(0, i)}</span>);
    parts.push(<Link key={k++} to={`/artist/${a.id}`}>{rest.slice(i, i + a.name.length)}</Link>);
    rest = rest.slice(i + a.name.length);
  }
  if (rest) parts.push(<span key={k++}>{rest}</span>);
  return <span>{parts}</span>;
}

/** Stars and heart over the bottom of a cover: shown on hover (always on touch screens). */
export function TileRate({ type, id, inline }: { type: EntityType; id: string; inline?: boolean }) {
  const { annotation, annotate } = useStore();
  const a = annotation(type, id);
  return (
    <div className={inline ? 'tile-rate-inline' : 'tile-rate'}>
      <Stars small value={a?.rating} onChange={(rating) => annotate(type, id, { rating })} />
      <Fav on={!!a?.favorite} onToggle={() => annotate(type, id, { favorite: !a?.favorite })} />
    </div>
  );
}

export function ReleaseTile({ r, showArtist = true }: { r: Release; showArtist?: boolean }) {
  const { annotation } = useStore();
  const a = annotation('release', r.id);
  return (
    <div className="tile">
      <div className="tile-cover">
        <Link to={`/release/${r.id}`} aria-label={`${r.title} by ${r.artist_credit}`}>
          <Cover src={r.artwork_url} title={r.title} />
        </Link>
        <TileRate type="release" id={r.id} />
      </div>
      <div className="t"><Link to={`/release/${r.id}`}>{r.title}</Link></div>
      {showArtist && <div className="s"><Credits release={r} /></div>}
      <div className="meta"><span className="num">{r.year ?? '—'}</span><span>{r.type}</span>
        {a?.rating ? <span className="mini-star">{'★'.repeat(a.rating)}</span> : null}
        {a?.favorite && <span style={{ color: 'var(--fav)' }}>♥</span>}</div>
    </div>
  );
}

export function ArtistTile({ a, sub }: { a: Artist; sub?: string }) {
  const { annotation } = useStore();
  const an = annotation('artist', a.id);
  return (
    <div className="tile">
      <Link to={`/artist/${a.id}`}><Cover src={a.image_url} title={a.name} round /></Link>
      <div className="t" style={{ textAlign: 'center' }}><Link to={`/artist/${a.id}`}>{a.name}</Link>{an?.favorite && <span style={{ color: 'var(--fav)' }}> ♥</span>}</div>
      {sub && <div className="s" style={{ textAlign: 'center' }}>{sub}</div>}
    </div>
  );
}

export const LINK_KEYS = LINK_META.map((m) => m.key) as LinkKey[];
export const fmtDate = (d?: string | null) => d ? new Date(d + 'T12:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
export const fmtMs = (ms?: number | null) => ms ? `${Math.floor(ms / 60000)}:${String(Math.round((ms % 60000) / 1000)).padStart(2, '0')}` : '';
