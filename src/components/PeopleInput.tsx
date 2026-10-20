import { useMemo, useState } from 'react';
import { norm, useStore } from '../lib/store';

/** A list of names as removable tags, with an add box that suggests artists already in the library. */
export default function PeopleInput({ value, onChange, placeholder = 'Add…', producersFirst }: { value: string[]; onChange: (v: string[]) => void; placeholder?: string; producersFirst?: boolean }) {
  const { data } = useStore();
  const [q, setQ] = useState('');
  const [focus, setFocus] = useState(false);
  const hits = useMemo(() => {
    const n = norm(q); if (n.length < 1) return [];
    const have = new Set(value.map(norm));
    return data.artists.filter((a) => !have.has(norm(a.name)) && norm(a.name).includes(n))
      .sort((a, b) => Number(norm(b.name).startsWith(n)) - Number(norm(a.name).startsWith(n)) || (producersFirst ? Number(b.is_producer) - Number(a.is_producer) : 0) || a.name.length - b.name.length)
      .slice(0, 6);
  }, [q, value, data.artists, producersFirst]);
  const add = (name: string) => { const t = name.trim(); if (t && !value.some((v) => norm(v) === norm(t))) onChange([...value, t]); setQ(''); };
  return (
    <div className="people-input" style={{ position: 'relative' }}>
      {value.map((v, i) => (
        <span key={`${v}${i}`} className="chip">{v}<button type="button" aria-label={`Remove ${v}`} onClick={() => onChange(value.filter((_, j) => j !== i))}>×</button></span>
      ))}
      <input value={q} placeholder={value.length ? '' : placeholder} aria-label={placeholder}
        onFocus={() => setFocus(true)} onBlur={() => window.setTimeout(() => { setFocus(false); if (q.trim()) add(q); }, 150)}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === 'Tab' && q.trim()) { e.preventDefault(); add(q); }
          else if (e.key === 'Backspace' && !q && value.length) onChange(value.slice(0, -1));
        }} />
      {focus && hits.length > 0 && (
        <div className="dropdown" style={{ minWidth: 220 }}>
          {hits.map((a) => <button type="button" key={a.id} className="dd-item btn ghost" style={{ width: '100%', justifyContent: 'flex-start' }} onMouseDown={(e) => { e.preventDefault(); add(a.name); }}>{a.name}{a.is_producer ? <span className="small muted"> · producer</span> : null}</button>)}
        </div>
      )}
    </div>
  );
}
