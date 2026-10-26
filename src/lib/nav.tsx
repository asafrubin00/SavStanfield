import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useNavigationType } from 'react-router-dom';

/*
 * Page memory: going Back (or Forward) returns you to where you were on that page — same scroll position,
 * same "show more" depth — like a native app. Opening something new starts at the top.
 */
const scrollByKey = new Map<string, number>();
const stateByKey = new Map<string, unknown>();
const MAX_KEY = 'nav.maxIdx';
const idx = () => (window.history.state?.idx as number | undefined) ?? 0;

export function useScrollMemory() {
  const loc = useLocation();
  const type = useNavigationType();
  const keyRef = useRef(loc.key);
  // Keep the current page's scroll position up to date
  useEffect(() => {
    const save = () => scrollByKey.set(keyRef.current, window.scrollY);
    window.addEventListener('scroll', save, { passive: true });
    return () => window.removeEventListener('scroll', save);
  }, []);
  useLayoutEffect(() => {
    keyRef.current = loc.key;
    if (type === 'PUSH') { sessionStorage.setItem(MAX_KEY, String(idx())); window.scrollTo(0, 0); return; }
    if (type !== 'POP') return; // filter/sort changes replace the URL: stay put
    const y = scrollByKey.get(loc.key) ?? 0;
    // The page may still be growing (images, lists) — keep trying for a moment until we can reach the spot
    let tries = 0; let raf = 0;
    const go = () => {
      window.scrollTo(0, y);
      if (Math.abs(window.scrollY - y) > 2 && tries++ < 60) raf = requestAnimationFrame(go);
    };
    go();
    return () => cancelAnimationFrame(raf);
  }, [loc.key, type]);
}

/** Like useState, but remembered per history entry: coming Back to a page gives you the value it had. */
export function usePageState<T>(name: string, init: T): [T, (v: T | ((p: T) => T)) => void] {
  const { key } = useLocation();
  const k = `${key}:${name}`;
  const [v, setV] = useState<T>(() => (stateByKey.has(k) ? stateByKey.get(k) as T : init));
  useEffect(() => { stateByKey.set(k, v); }, [k, v]);
  return [v, setV];
}

/** ‹ › buttons, like a browser's, for moving back and forth between pages. */
export function NavButtons() {
  const nav = useNavigate();
  useLocation(); // re-render on every navigation so the enabled state is current
  const i = idx(); const max = Number(sessionStorage.getItem(MAX_KEY) ?? 0);
  return (
    <span className="nav-btns">
      <button type="button" className="btn ghost" aria-label="Back" title="Back" disabled={i <= 0} onClick={() => nav(-1)}>‹</button>
      <button type="button" className="btn ghost" aria-label="Forward" title="Forward" disabled={i >= max} onClick={() => nav(1)}>›</button>
    </span>
  );
}
