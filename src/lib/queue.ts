import { useSyncExternalStore } from 'react';
import { autoLinkArtist, autoLinkRelease, secondPassRelease } from './enrich';
import type { Artist, Release } from './types';

/** Background linking queue: works through artists/releases, pacing itself per API. */
type Job = { kind: 'artist' | 'release' | 'release2'; id: string };
interface Deps {
  getArtist(id: string): Artist | undefined;
  getRelease(id: string): Release | undefined;
  releaseArtistName(r: Release): string;
  saveArtist(a: Artist): Promise<void>;
  saveRelease(r: Release): Promise<void>;
}

let deps: Deps | null = null;
const jobs: Job[] = [];
const queued = new Set<string>();
let state = { pending: 0, done: 0, matched: 0, running: false, paused: false, last: '' as string, errors: 0 };
const listeners = new Set<() => void>();
const emit = () => { state = { ...state, pending: jobs.length }; listeners.forEach((l) => l()); };

export const linkQueue = {
  configure(d: Deps) { deps = d; },
  add(kind: Job['kind'], ids: string[]) {
    for (const id of ids) { const k = `${kind}:${id}`; if (!queued.has(k)) { queued.add(k); jobs.push({ kind, id }); } }
    emit(); void run();
  },
  pause() { state.paused = true; emit(); },
  resume() { state.paused = false; emit(); void run(); },
  clear() { jobs.length = 0; queued.clear(); state.done = 0; state.matched = 0; state.errors = 0; emit(); },
  subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; },
  get: () => state,
};

const WORKERS = 3;
let active = 0;
async function run() {
  if (!deps) return;
  while (active < WORKERS && jobs.length && !state.paused) {
    active++; state.running = true; emit();
    void (async () => {
      while (jobs.length && !state.paused) {
        const job = jobs.shift()!;
        queued.delete(`${job.kind}:${job.id}`);
        try {
          if (job.kind === 'release' || job.kind === 'release2') {
            const r = deps!.getRelease(job.id); if (!r) continue;
            const res = job.kind === 'release'
              ? await autoLinkRelease(r, deps!.releaseArtistName(r), { genius: true, wiki: false })
              : await secondPassRelease(r, deps!.releaseArtistName(r));
            await deps!.saveRelease({ ...deps!.getRelease(job.id)!, ...res.patch });
            state.last = `${r.artist_credit ?? ''} – ${r.title}`;
            if (res.found.length) state.matched++;
            if (res.errors.length) state.errors++;
          } else {
            const a = deps!.getArtist(job.id); if (!a) continue;
            const res = await autoLinkArtist(a);
            await deps!.saveArtist({ ...deps!.getArtist(job.id)!, ...res.patch });
            state.last = a.name;
            if (res.found.length) state.matched++;
            if (res.errors.length) state.errors++;
          }
        } catch { state.errors++; }
        state.done++; emit();
      }
      active--; if (!active) { state.running = false; emit(); }
    })();
  }
}

export function useLinkQueue() {
  return useSyncExternalStore(linkQueue.subscribe, linkQueue.get);
}
