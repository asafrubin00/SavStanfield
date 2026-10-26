import { useEffect, useRef, useState } from 'react';

/** A remembered per-browser preference (e.g. "show counts", "compact view"). */
export function usePref<T>(key: string, initial: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try { const s = localStorage.getItem(`pref:${key}`); return s === null ? initial : JSON.parse(s) as T; } catch { return initial; }
  });
  const set = (x: T) => { setV(x); try { localStorage.setItem(`pref:${key}`, JSON.stringify(x)); } catch { /* storage blocked */ } };
  return [v, set];
}

/** Rating filter values used across the site. */
export const RATING_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: 'Any rating' },
  { value: 'eq5', label: '★★★★★' },
  { value: 'eq4', label: '★★★★' },
  { value: 'eq3', label: '★★★' },
  { value: 'eq2', label: '★★' },
  { value: 'eq1', label: '★' },
  { value: 'ge4', label: '★★★★ and up' },
  { value: 'ge3', label: '★★★ and up' },
  { value: 'ge2', label: '★★ and up' },
  { value: 'rated', label: 'Rated' },
  { value: 'unrated', label: 'Not rated yet' },
];
// Old links used "5", "4"… meaning "and up"
const LEGACY: Record<string, string> = { 5: 'eq5', 4: 'ge4', 3: 'ge3', 2: 'ge2', 1: 'rated' };
export function ratingMatches(filter: string, rating?: number | null) {
  const f = LEGACY[filter] ?? filter;
  if (!f) return true;
  const r = rating ?? 0;
  if (f === 'unrated') return !r;
  if (f === 'rated') return r > 0;
  const n = Number(f.slice(2));
  return f.startsWith('eq') ? r === n : r >= n;
}
export function RatingSelect({ value, onChange, label = 'Rating' }: { value: string; onChange: (v: string) => void; label?: string }) {
  return (
    <select className="select" value={LEGACY[value] ?? value} onChange={(e) => onChange(e.target.value)} aria-label={label}>
      {RATING_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

/** Which way a sort runs by default: A–Z, oldest-first and "your order" go up; everything else (newest, highest, most) goes down. */
const naturallyUp = (value: string, label: string) => /a–z|a-z|oldest|^az$|title|^order$|ranking|your order|playlist order|list order/i.test(`${value}|${label}`) && !/z–a/i.test(label);

/** Sort dropdown, plus an arrow button to flip the direction when `onRev` is given. */
export function SortSelect({ value, options, onChange, rev, onRev }: { value: string; options: [string, string][]; onChange: (v: string) => void; rev?: boolean; onRev?: (rev: boolean) => void }) {
  const label = options.find(([v]) => v === value)?.[1] ?? '';
  const up = naturallyUp(value, label) !== !!rev;
  return (
    <span className="row" style={{ gap: 4, flexWrap: 'nowrap' }}>
      <select className="select" value={value} onChange={(e) => onChange(e.target.value)} aria-label="Sort">
        {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
      {onRev && <button type="button" className={`btn sort-dir${rev ? ' on' : ''}`} onClick={() => onRev(!rev)} aria-label={`Sorted ${up ? 'ascending' : 'descending'} — click to flip`} title={`${up ? 'Ascending' : 'Descending'} — click to flip`}>{up ? '↑' : '↓'}</button>}
    </span>
  );
}

/** Dropdown with checkboxes — pick several values. */
export function MultiSelect({ label, options, value, onChange, counts }: { label: string; options: string[]; value: string[]; onChange: (v: string[]) => void; counts?: Record<string, number> }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', close); document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); };
  }, [open]);
  const summary = !value.length ? `All ${label.toLowerCase()}` : value.length <= 2 ? value.join(', ') : `${value.length} ${label.toLowerCase()}`;
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button type="button" className="select" style={{ width: '100%', textAlign: 'left', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', gap: 8 }} aria-expanded={open} aria-haspopup="listbox" onClick={() => setOpen(!open)}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{summary}</span><span aria-hidden>▾</span>
      </button>
      {open && (
        <div className="dropdown" role="listbox" aria-multiselectable="true" style={{ maxHeight: 320, zIndex: 30 }}>
          {options.map((o) => (
            <label key={o} className="dd-item" style={{ cursor: 'pointer' }}>
              <input type="checkbox" checked={value.includes(o)} onChange={() => onChange(value.includes(o) ? value.filter((x) => x !== o) : [...value, o])} />
              <span style={{ flex: 1 }}>{o}</span>{counts && <span className="small muted num">{counts[o] ?? 0}</span>}
            </label>
          ))}
          {value.length > 0 && <button type="button" className="btn sm ghost" style={{ margin: 4 }} onClick={() => onChange([])}>Clear</button>}
        </div>
      )}
    </div>
  );
}

/** Flip a sorted list when `rev` is on, keeping items with nothing to sort by (unrated, undated) at the end. */
export function flip<T>(arr: T[], rev: boolean, has: (x: T) => boolean = () => true): T[] {
  if (!rev) return arr;
  return [...arr.filter(has).reverse(), ...arr.filter((x) => !has(x))];
}
