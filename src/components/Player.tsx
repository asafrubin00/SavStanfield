import { Link } from 'react-router-dom';
import { player, trackEmbed, usePlayer } from '../lib/player';
import { useStore } from '../lib/store';
import { Cover } from './ui';

/** Docked player at the bottom of the screen. One song at a time; Next/Previous move through the queue. */
export default function Player() {
  const s = usePlayer();
  const { ix } = useStore();
  if (!s.ids.length) return null;
  const t = ix.tracks.get(s.ids[s.index]);
  const r = t?.release_id ? ix.releases.get(t.release_id) : undefined;
  const embed = t ? trackEmbed(t) : null;
  const artist = t?.artist_credit ?? r?.artist_credit ?? '';
  const search = t ? `https://music.apple.com/gb/search?term=${encodeURIComponent(`${artist} ${t.title}`)}` : '#';
  return (
    <div className="player" role="region" aria-label="Player">
      <div className="player-info">
        <Cover src={r?.artwork_url} title={t?.title ?? ''} size={48} />
        <div style={{ minWidth: 0 }}>
          <div className="small muted">{s.label ? `${s.label} · ` : ''}{s.index + 1} of {s.ids.length}</div>
          <div style={{ fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t ? <Link to={`/track/${t.id}`}>{t.title}</Link> : 'Loading…'}</div>
          <div className="small muted" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{artist}{r && <> · <Link to={`/release/${r.id}`}>{r.title}</Link></>}</div>
        </div>
        <div className="row" style={{ flexWrap: 'nowrap', gap: 4 }}>
          <button className="btn sm" onClick={player.prev} disabled={s.index === 0} aria-label="Previous">◀◀</button>
          <button className="btn sm" onClick={player.next} disabled={s.index >= s.ids.length - 1} aria-label="Next">▶▶</button>
          <button className="btn sm ghost" onClick={player.close} aria-label="Close player">Close</button>
        </div>
      </div>
      <div className="player-embed">
        {embed ? <iframe key={embed.src} title="Player" src={embed.src} height={Math.min(embed.height, 175)} allow="autoplay *; encrypted-media *; clipboard-write" style={{ width: '100%', border: 0, borderRadius: 8 }} />
          : t ? <div className="small muted" style={{ padding: 12 }}>No playable link for this song yet. <a href={search} target="_blank" rel="noreferrer" style={{ textDecoration: 'underline' }}>Find it on Apple Music</a> or skip with ▶▶.</div> : null}
      </div>
    </div>
  );
}
