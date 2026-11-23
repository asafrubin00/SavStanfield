import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type Ref } from 'react';

/*
 * Selecting several things at once, the same way on every page: press Select (or ⌘/Ctrl-click any cover or row to
 * start), click to tick, shift-click for a range, then act on them all from the bar along the bottom.
 * A page wraps its content in <SelectionProvider all={…}>; covers use <PickTile>, table rows <PickCell>.
 */
export type ItemType = 'release' | 'track';
export interface Item { type: ItemType; id: string }
export const itemKey = (it: Item) => `${it.type}:${it.id}`;

interface Sel {
  selecting: boolean; setSelecting: (on: boolean) => void;
  items: Item[]; has: (it: Item) => boolean;
  /** Tick or untick; with range, everything between the last click and this one in `order` (the list you clicked in). */
  toggle: (it: Item, range?: boolean, order?: Item[]) => void;
  set: (items: Item[]) => void; clear: () => void; all: Item[];
  /** On a list's own page: take the selected things off it. */
  removeFromHere?: { label: string; run: (items: Item[]) => Promise<void> | void };
}
const Ctx = createContext<Sel | null>(null);
export const useSelection = () => useContext(Ctx);

export function SelectionProvider({ all, removeFromHere, children }: { all: Item[]; removeFromHere?: Sel['removeFromHere']; children: ReactNode }) {
  const [selecting, setSel] = useState(false);
  const [keys, setKeys] = useState<Map<string, Item>>(new Map());
  const last = useRef<string | null>(null);
  const setSelecting = useCallback((on: boolean) => { setSel(on); if (!on) { setKeys(new Map()); last.current = null; } }, []);
  // Leaving the page (or Esc) ends selecting
  useEffect(() => {
    if (!selecting) return;
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape' && !(e.target as HTMLElement).closest('input,select,textarea,.modal')) setSelecting(false); };
    window.addEventListener('keydown', esc); return () => window.removeEventListener('keydown', esc);
  }, [selecting, setSelecting]);
  const keysRef = useRef(keys); keysRef.current = keys;
  const toggle = useCallback((it: Item, range?: boolean, order?: Item[]) => {
    const prev = keysRef.current;
    const next = new Map(prev); const k = itemKey(it); const on = !prev.has(k);
    const list = order ?? [it];
    const i = list.findIndex((x) => itemKey(x) === k); const j = last.current ? list.findIndex((x) => itemKey(x) === last.current) : -1;
    const span = range && i >= 0 && j >= 0 ? list.slice(Math.min(i, j), Math.max(i, j) + 1) : [it];
    for (const x of span) { if (on) next.set(itemKey(x), x); else next.delete(itemKey(x)); }
    last.current = k;
    setKeys(next); setSel(true);
  }, []);
  const value = useMemo<Sel>(() => ({
    selecting, setSelecting, items: [...keys.values()], has: (it) => keys.has(itemKey(it)), toggle,
    set: (items) => { setKeys(new Map(items.map((x) => [itemKey(x), x]))); setSel(true); }, clear: () => setKeys(new Map()), all, removeFromHere,
  }), [selecting, setSelecting, keys, toggle, all, removeFromHere]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** The Select / Done button for a page's header or button row. */
export function SelectButton() {
  const s = useSelection(); if (!s) return null;
  return <button type="button" className={`btn${s.selecting ? ' primary' : ''}`} aria-pressed={s.selecting} title="Select several (or ⌘/Ctrl-click any cover or row)" onClick={() => s.setSelecting(!s.selecting)}>{s.selecting ? 'Done' : 'Select'}</button>;
}

const startsPick = (e: React.MouseEvent) => e.metaKey || e.ctrlKey;

/** Wraps a cover tile: while selecting, a click ticks it; otherwise ⌘/Ctrl-click starts selecting with it. */
export function PickTile({ item, order, members, children }: { item: Item; order: Item[]; members?: Item[]; children: ReactNode }) {
  const s = useSelection();
  if (!s) return <>{children}</>;
  // A tile can stand for several things (an album's songs in a playlist): it's ticked when all of them are
  const group = members && members.length > 1 ? members : null;
  const on = group ? group.every((x) => s.has(x)) : s.has(item);
  return (
    <div className={`pick-tile${s.selecting ? ' active' : ''}${on ? ' on' : ''}`}
      onClickCapture={(e) => {
        if (!s.selecting && !startsPick(e)) return;
        if ((e.target as HTMLElement).closest('.tile-remove, .tile-handle, .tile-play')) return;
        e.preventDefault(); e.stopPropagation();
        if (group) { const rest = s.items.filter((x) => !group.some((g) => itemKey(g) === itemKey(x))); s.set(on ? rest : [...rest, ...group]); }
        else s.toggle(item, e.shiftKey, order);
      }}>
      {s.selecting && <input type="checkbox" className="pick-box" checked={on} readOnly aria-label="Select" tabIndex={-1} />}
      {children}
    </div>
  );
}

/** First cell of a selectable table row (render only while selecting); pair with rowPickProps on the <tr>. */
export function PickCell({ item, order }: { item: Item; order: Item[] }) {
  const s = useSelection(); if (!s?.selecting) return null;
  return <td className="pick-cell"><input type="checkbox" checked={s.has(item)} readOnly aria-label="Select" onClick={(e) => { e.stopPropagation(); s.toggle(item, e.shiftKey, order); }} /></td>;
}
/** Header cell to tick everything in the table. */
export function PickAllCell({ order }: { order: Item[] }) {
  const s = useSelection(); if (!s?.selecting) return null;
  const allOn = order.length > 0 && order.every((x) => s.has(x));
  return <th className="pick-cell"><input type="checkbox" checked={allOn} aria-label="Select all in this table" onChange={() => {
    const keep = s.items.filter((x) => !order.some((o) => itemKey(o) === itemKey(x)));
    s.set(allOn ? keep : [...keep, ...order]);
  }} /></th>;
}
/**
 * A selectable table row. ⌘/Ctrl-click anywhere on it starts selecting and ticks it; while selecting, a plain click
 * on the row ticks it (shift-click for a range). Buttons, stars, hearts and inputs inside keep working.
 */
export function PickRow({ item, order, className, children, as = 'tr', rowRef, style }: { item: Item | null; order: Item[]; className?: string; children: ReactNode; as?: 'tr' | 'li'; rowRef?: Ref<HTMLElement>; style?: CSSProperties }) {
  const s = useSelection();
  const on = !!item && !!s?.has(item);
  // Something that can't be picked (a text note on a list) keeps its place but gets no tick box
  if (!item) {
    const blank = s?.selecting ? (as === 'li' ? <span className="pick-cell" /> : <td className="pick-cell" />) : null;
    return as === 'li' ? <li className={className} style={style} ref={rowRef as Ref<HTMLLIElement>}>{blank}{children}</li> : <tr className={className} style={style} ref={rowRef as Ref<HTMLTableRowElement>}>{blank}{children}</tr>;
  }
  const props = {
    style,
    className: [className, on ? 'picked' : ''].filter(Boolean).join(' ') || undefined,
    onClickCapture: s ? (e: React.MouseEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('input, select, textarea, .fav, .stars, .cell-names, .clip-pop, .dropdown') || (t.closest('button') && !t.closest('.pick-cell'))) return;
      if (!s.selecting && !(e.metaKey || e.ctrlKey)) return;
      e.preventDefault(); e.stopPropagation(); s.toggle(item, e.shiftKey, order);
    } : undefined,
  };
  if (as === 'li') return (
    <li {...props} ref={rowRef as Ref<HTMLLIElement>}>
      {s?.selecting && <span className="pick-cell"><input type="checkbox" checked={on} readOnly aria-label="Select" onClick={(e) => { e.stopPropagation(); s.toggle(item, e.shiftKey, order); }} /></span>}
      {children}
    </li>
  );
  return <tr {...props} ref={rowRef as Ref<HTMLTableRowElement>}><PickCell item={item} order={order} />{children}</tr>;
}
