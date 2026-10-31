import { useState } from 'react';
import { useStore } from '../lib/store';
import { customTypes, RELEASE_TYPES } from '../lib/types';

const NEW = '__new__';
/** Every type to offer: the standard ones, then yours, with "Other…" last for making a new one. */
export function useTypeOptions() {
  const { data } = useStore();
  return [...RELEASE_TYPES.filter((t) => t !== 'Other'), ...customTypes(data.releases)];
}

/** Release type picker. "Other…" lets you name a new type, which then shows up as an option everywhere. */
export default function TypeSelect({ value, onChange, autoFocus, onBlur, className = 'select', style }: { value: string; onChange: (v: string) => void; autoFocus?: boolean; onBlur?: () => void; className?: string; style?: React.CSSProperties }) {
  const opts = useTypeOptions();
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  if (naming) {
    const done = () => { setNaming(false); const n = name.trim(); onChange(n || 'Other'); };
    return <input className="input" style={style} autoFocus placeholder="Name the type, e.g. Stanfield Version" aria-label="New type" value={name} onChange={(e) => setName(e.target.value)}
      onBlur={done} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); done(); } else if (e.key === 'Escape') { setNaming(false); onBlur?.(); } }} />;
  }
  return (
    <select className={className} style={style} autoFocus={autoFocus} aria-label="Type" value={value} onBlur={onBlur}
      onChange={(e) => { if (e.target.value === NEW) { setName(''); setNaming(true); } else onChange(e.target.value); }}>
      {[...new Set([...opts, value])].map((t) => <option key={t} value={t}>{t}</option>)}
      <option value={NEW}>Other… (name a new type)</option>
    </select>
  );
}
