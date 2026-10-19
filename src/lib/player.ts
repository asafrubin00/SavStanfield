import { useSyncExternalStore } from 'react';
import type { Track } from './types';

/** A simple queue. Playback itself is an embedded player per song (Apple Music, Deezer, YouTube or SoundCloud). */
let state = { ids: [] as string[], index: 0, label: '' };
const listeners = new Set<() => void>();
const emit = () => { state = { ...state }; listeners.forEach((l) => l()); };

export const player = {
  play(ids: string[], index = 0, label = '') { state.ids = ids; state.index = Math.max(0, Math.min(index, ids.length - 1)); state.label = label; emit(); },
  shuffle(ids: string[], label = '') {
    const a = [...ids];
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    player.play(a, 0, label);
  },
  next() { if (state.index < state.ids.length - 1) { state.index++; emit(); } },
  prev() { if (state.index > 0) { state.index--; emit(); } },
  go(i: number) { state.index = i; emit(); },
  close() { state.ids = []; state.index = 0; emit(); },
  subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; },
  get: () => state,
};
export const usePlayer = () => useSyncExternalStore(player.subscribe, player.get);

/** Best embeddable player URL for a song, and what kind it is. */
export function trackEmbed(t: Track): { src: string; kind: 'apple' | 'deezer' | 'youtube' | 'soundcloud'; height: number } | null {
  const l = t.links;
  if (l.apple && /music\.apple\.com|itunes\.apple\.com/.test(l.apple)) return { src: l.apple.replace(/^https:\/\/(music|itunes)\.apple\.com/, 'https://embed.music.apple.com'), kind: 'apple', height: 175 };
  const dz = (t.ext.deezer_id as number | undefined) ?? Number(l.deezer?.match(/track\/(\d+)/)?.[1]);
  if (dz) return { src: `https://widget.deezer.com/widget/dark/track/${dz}`, kind: 'deezer', height: 150 };
  if (l.soundcloud) return { src: `https://w.soundcloud.com/player/?url=${encodeURIComponent(l.soundcloud)}&color=%232a3fd1`, kind: 'soundcloud', height: 166 };
  const yt = l.youtube?.match(/[?&]v=([\w-]{6,})|youtu\.be\/([\w-]{6,})/);
  if (yt) return { src: `https://www.youtube-nocookie.com/embed/${yt[1] ?? yt[2]}`, kind: 'youtube', height: 200 };
  return null;
}
