import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import PeopleInput from './PeopleInput';
import TypeSelect from './TypeSelect';

/*
 * Double-click a table cell to edit it in place. Enter (or clicking away) saves, Esc cancels.
 * Links inside the cell still work on a single click — it just waits a moment to see if a second click follows.
 * ⌘/Ctrl-click opens in a new tab as usual.
 */
type Props =
  | { kind: 'text'; value: string; onSave: (v: string) => Promise<unknown> | void; placeholder?: string; children: ReactNode; label: string }
  | { kind: 'names'; value: string[]; onSave: (v: string[]) => Promise<unknown> | void; placeholder?: string; children: ReactNode; label: string }
  | { kind: 'select'; value: string; options: string[]; onSave: (v: string) => Promise<unknown> | void; children: ReactNode; label: string }
  | { kind: 'type'; value: string; onSave: (v: string) => Promise<unknown> | void; children: ReactNode; label: string }
  | { kind: 'action'; onEdit: () => void; children: ReactNode; label: string };

export default function EditCell(p: Props) {
  const nav = useNavigate();
  const [editing, setEditing] = useState(false);
  const timer = useRef<number>();
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const start = () => { window.clearTimeout(timer.current); if (p.kind === 'action') p.onEdit(); else setEditing(true); };

  if (editing && p.kind !== 'action') {
    const done = () => setEditing(false);
    if (p.kind === 'names') return <NamesEditor value={p.value} placeholder={p.placeholder} label={p.label} onCancel={done} onSave={async (v) => { done(); await p.onSave(v); }} />;
    if (p.kind === 'type') return <TypeSelect className="select cell-input" autoFocus value={p.value} onBlur={done} onChange={async (v) => { done(); if (v !== p.value) await p.onSave(v); }} />;
    if (p.kind === 'select') return (
      <select className="select cell-input" autoFocus aria-label={p.label} defaultValue={p.value} onBlur={done}
        onKeyDown={(e) => { if (e.key === 'Escape') done(); }} onChange={async (e) => { done(); await p.onSave(e.target.value); }}>
        {[...new Set([...p.options, p.value])].map((o) => <option key={o}>{o}</option>)}
      </select>);
    return <TextEditor value={p.value} placeholder={p.placeholder} label={p.label} onCancel={done} onSave={async (v) => { done(); if (v !== p.value) await p.onSave(v); }} />;
  }
  return (
    <div className="edit-cell" title="Double-click to edit"
      onClickCapture={(e) => {
        const a = (e.target as HTMLElement).closest('a');
        if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        if (e.detail > 1) return;
        const to = a.getAttribute('href') ?? '';
        timer.current = window.setTimeout(() => nav(to), 260);
      }}
      onDoubleClick={(e) => { e.preventDefault(); window.getSelection()?.removeAllRanges(); start(); }}>
      {p.children}
    </div>
  );
}

function TextEditor({ value, placeholder, label, onSave, onCancel }: { value: string; placeholder?: string; label: string; onSave: (v: string) => void; onCancel: () => void }) {
  const [v, setV] = useState(value);
  const done = useRef(false);
  const finish = (save: boolean) => { if (done.current) return; done.current = true; if (save) onSave(v.trim()); else onCancel(); };
  return <input className="input cell-input" autoFocus aria-label={label} placeholder={placeholder} value={v} onChange={(e) => setV(e.target.value)}
    onFocus={(e) => e.target.select()} onBlur={() => finish(true)}
    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); finish(true); } else if (e.key === 'Escape') finish(false); }} />;
}

/** Names as tags (suggesting artists you have). Enter on an empty box, or clicking away, saves. */
function NamesEditor({ value, placeholder, label, onSave, onCancel }: { value: string[]; placeholder?: string; label: string; onSave: (v: string[]) => void; onCancel: () => void }) {
  const [v, setV] = useState(value);
  const cur = useRef(v); cur.current = v;
  const box = useRef<HTMLDivElement>(null);
  const done = useRef(false);
  const finish = (save: boolean) => { if (done.current) return; done.current = true; if (save) onSave(cur.current); else onCancel(); };
  useEffect(() => { box.current?.querySelector('input')?.focus(); }, []);
  return (
    <div ref={box} className="cell-names"
      onKeyDownCapture={(e) => {
        const input = e.target as HTMLInputElement;
        if (e.key === 'Escape') { e.preventDefault(); finish(false); }
        else if (e.key === 'Enter' && !input.value?.trim()) { e.preventDefault(); e.stopPropagation(); finish(true); }
        else if (e.key === ';' && input.value?.trim()) { e.preventDefault(); input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); }
      }}
      onBlur={() => window.setTimeout(() => { if (!box.current?.contains(document.activeElement)) finish(true); }, 220)}>
      <PeopleInput value={v} onChange={setV} placeholder={placeholder ?? label} />
      <span className="small muted cell-hint">Enter to save · Esc to cancel</span>
    </div>
  );
}
