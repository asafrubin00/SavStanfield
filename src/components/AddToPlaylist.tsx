import { useEffect, useRef, useState } from 'react';
import { useStore } from '../lib/store';

/** "+ Playlist" button: pick a playlist (or make one) and add these songs to it. */
export default function AddToPlaylist({ trackIds, label = '+ Playlist', small }: { trackIds: string[] | (() => Promise<string[]>); label?: string; small?: boolean }) {
  const { data, addTracksToList, createList } = useStore();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close); return () => document.removeEventListener('mousedown', close);
  }, [open]);
  const playlists = data.lists.filter((l) => l.kind === 'playlist').sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? ''));
  const ids = async () => (typeof trackIds === 'function' ? await trackIds() : trackIds);
  const add = async (listId: string) => { setOpen(false); await addTracksToList(listId, await ids()); };
  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-block' }}>
      <button type="button" className={`btn${small ? ' sm ghost' : ''}`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)} title="Add to a playlist">{label}</button>
      {open && (
        <div className="dropdown" role="menu" style={{ minWidth: 240, left: 'auto', right: 0, zIndex: 35 }}>
          {playlists.map((l) => <button key={l.id} role="menuitem" className="dd-item btn ghost" style={{ width: '100%', justifyContent: 'flex-start' }} onClick={() => add(l.id)}>{l.name}</button>)}
          {!playlists.length && <div className="small muted" style={{ padding: 8 }}>No playlists yet.</div>}
          <form className="row" style={{ padding: 6, flexWrap: 'nowrap' }} onSubmit={async (e) => { e.preventDefault(); if (!name.trim()) return; const id = await createList(name, 'playlist'); setName(''); await add(id); }}>
            <input className="input" style={{ flex: 1, minWidth: 0 }} placeholder="New playlist" value={name} onChange={(e) => setName(e.target.value)} />
            <button className="btn sm" disabled={!name.trim()}>Create</button>
          </form>
        </div>
      )}
    </div>
  );
}
