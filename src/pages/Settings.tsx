import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { adapter, mode, supabase } from '../lib/db';
import { importWorkbook, type ImportResult } from '../lib/importSheet';
import { needsRecheck, suspectApple } from '../lib/enrich';
import { linkQueue, useLinkQueue } from '../lib/queue';
import { appleAlbumsByIds, appleIdFromUrl, ext, soundcloudSearchEnabled } from '../lib/sources';
import { useStore } from '../lib/store';
import { TABLES, type DataSet, type TableName } from '../lib/types';

function getTheme() { try { return localStorage.getItem('theme') ?? ''; } catch { return ''; } }
function setTheme(t: string) {
  try { if (t) localStorage.setItem('theme', t); else localStorage.removeItem('theme'); } catch { /* private mode */ }
  if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
}

export default function Settings() {
  const { data, upsert, replaceAll, say } = useStore();
  const q = useLinkQueue();
  const [preview, setPreview] = useState<ImportResult | null>(null);
  const [importing, setImporting] = useState('');
  const [checks, setChecks] = useState<Record<string, string>>({});
  const [theme, setT] = useState(getTheme());

  async function onFile(f: File) {
    try {
      setImporting('Reading…');
      // Compare against every saved track (not just the ones loaded in this session) so re-imports don't duplicate
      const tracks = await adapter.allTracks();
      setPreview(importWorkbook(await f.arrayBuffer(), { ...data, tracks }));
      setImporting('');
    }
    catch (e) { say(`Couldn't read that file: ${(e as Error).message}`); }
  }
  async function commit() {
    if (!preview) return;
    for (const t of ['artists', 'releases', 'tracks', 'credits', 'annotations', 'lists', 'list_items', 'concerts'] as TableName[]) {
      const rows = preview.rows[t] ?? []; if (!rows.length) continue;
      setImporting(`Saving ${rows.length.toLocaleString()} ${t.replace('_', ' ')}…`);
      await upsert(t, rows as never[]);
    }
    setImporting(''); setPreview(null); say('Spreadsheet imported');
  }
  async function exportJson() {
    setImporting('Preparing backup…');
    const tracks = await adapter.allTracks().catch(() => data.tracks);
    setImporting('');
    const blob = new Blob([JSON.stringify({ app: 'savstanfield', version: 1, exported: new Date().toISOString(), data: { ...data, tracks } })], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `savstanfield-backup-${new Date().toISOString().slice(0, 10)}.json`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  async function restoreJson(f: File) {
    try {
      const j = JSON.parse(await f.text()); const d = j.data as DataSet;
      if (j.app !== 'savstanfield' || !d || !Array.isArray(d.releases)) throw new Error('Not a SavStanfield backup');
      for (const t of TABLES) if (!Array.isArray(d[t])) (d as Record<string, unknown[]>)[t] = []; // older backups lack newer tables
      if (!confirm(`Replace everything with this backup from ${j.exported?.slice(0, 10)}? (${d.releases.length} releases)`)) return;
      setImporting('Restoring…'); await replaceAll(d); setImporting(''); say('Backup restored');
    } catch (e) { setImporting(''); say((e as Error).message); }
  }
  async function check() {
    const tests: [string, () => Promise<unknown>][] = [
      ['Apple Music', () => ext('itunes', 'search', { term: 'illmatic', entity: 'album', limit: 1 })],
      ['MusicBrainz', () => ext('mb', 'artist', { query: 'nas', limit: 1 })],
      ['Deezer', () => ext('deezer', 'search/artist', { q: 'nas', limit: 1 })],
      ['Wikipedia', () => ext('wiki', 'w/rest.php/v1/search/page', { q: 'Illmatic', limit: 1 })],
      ['Genius', () => ext('genius', 'search', { q: 'nas illmatic' })],
      ['YouTube', () => ext('youtube', 'search', { part: 'snippet', q: 'illmatic', maxResults: 1, type: 'video' })],
      ['SoundCloud links', () => ext('scoembed', '', { url: 'https://soundcloud.com/nasofficial' })],
    ];
    setChecks(Object.fromEntries(tests.map(([n]) => [n, 'checking…'])));
    for (const [n, fn] of tests) fn().then(() => setChecks((c) => ({ ...c, [n]: 'working' }))).catch((e) => setChecks((c) => ({ ...c, [n]: e.message })));
  }

  const unlinkedReleases = data.releases.filter((r) => !r.ext.linked_at).map((r) => r.id);
  const unlinkedArtists = data.artists.filter((a) => !a.ext.linked_at).map((a) => a.id);
  const today = new Date().toISOString().slice(0, 10);
  const [scOn, setScOn] = useState(false);
  useEffect(() => { void soundcloudSearchEnabled().then(setScOn); }, []);
  const recheckRel = data.releases.filter(needsRecheck);
  const recheck = recheckRel.map((r) => r.id);
  const recheckSecs = recheckRel.reduce((s, r) => s + (suspectApple(r) ? 1.5 : 0.05) + (r.ext.deezer_id ? 0.15 : 0) + (r.ext.mbid && /archive\.org/.test(r.artwork_url ?? '') ? 1.1 : 0), 0);
  const needTracks = data.releases.filter((r) => !r.ext.tracks_at && (r.ext.apple_id || r.ext.deezer_id || r.ext.mbid) && !(r.date && r.date > today));
  const trackSecs = needTracks.reduce((s, r) => s + (r.ext.apple_id ? 3.2 : r.ext.deezer_id ? 0.2 : 2.3), 0);
  const scPass = data.releases.filter((r) => !r.ext.sc_at && !r.artwork_url && !r.ext.reviewed && !(r.date && r.date > today)).map((r) => r.id);
  const secondPass = data.releases.filter((r) => r.ext.linked_at && !r.ext.pass2_at && !r.artwork_url && !(r.date && r.date > today)).map((r) => r.id);
  const hours = (n: number) => { const h = (n * 3.2) / 3600; return h < 1 ? `${Math.ceil(h * 60)} min` : `${h.toFixed(1)} h`; };

  return (
    <div style={{ maxWidth: 860 }}>
      <h1 className="h-page" style={{ marginBottom: 20 }}>Import &amp; settings</h1>

      <h2 className="h-sec">Import your spreadsheet</h2>
      <p className="muted" style={{ marginTop: 0 }}>Reads ALBUMS, UPCOMING, Concerts and Leaks &amp; Compilations, and turns Def Jam, FRESHMEN and Stanfield Nominations into lists. Safe to re-run: existing releases are updated, not duplicated, and your links and notes are kept.</p>
      <input type="file" accept=".xlsx,.xls" onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
      {preview && <div className="panel" style={{ marginTop: 14 }}>
        <strong>Ready to import</strong>
        <ul style={{ margin: '8px 0' }}>{preview.summary.map((s) => <li key={s}>{s}</li>)}</ul>
        {preview.warnings.length > 0 && <details><summary className="small">{preview.warnings.length} things to check in your sheet</summary><ul className="small muted">{preview.warnings.map((w) => <li key={w}>{w}</li>)}</ul></details>}
        <div className="row" style={{ marginTop: 12 }}><button className="btn primary" disabled={!!importing} onClick={commit}>Import</button><button className="btn" onClick={() => setPreview(null)}>Cancel</button><span className="muted small">{importing}</span></div>
      </div>}

      <h2 className="h-sec">Links, artwork and photos</h2>
      <p className="muted" style={{ marginTop: 0 }}>Matches everything against Apple Music, MusicBrainz, Wikipedia, Deezer and Genius. It runs in the background while this site is open, about 3 seconds per release (Apple's limit). Anything it isn't sure about is left for you to match by hand.</p>
      <div className="row">
        <button className="btn primary" disabled={!unlinkedArtists.length} onClick={() => linkQueue.add('artist', unlinkedArtists)}>Link {unlinkedArtists.length.toLocaleString()} artists (~{hours(unlinkedArtists.length)})</button>
        <button className="btn primary" disabled={!unlinkedReleases.length} onClick={() => linkQueue.add('release', unlinkedReleases)}>Link {unlinkedReleases.length.toLocaleString()} releases (~{hours(unlinkedReleases.length)})</button>
      </div>
      <p className="muted" style={{ marginBottom: 8 }}>Second pass: looser matching for releases still without a cover — Cover Art Archive, Deezer, a fuzzier MusicBrainz search and Genius album art. Whatever's left after that goes to <Link to="/review">Review matches</Link>.</p>
      <div className="row">
        <button className="btn primary" disabled={!secondPass.length} onClick={() => linkQueue.add('release2', secondPass)}>Second pass on {secondPass.length.toLocaleString()} releases (~{Math.max(1, Math.ceil(secondPass.length * 2.7 / 60))} min)</button>
        {scOn && <button className="btn primary" disabled={!scPass.length} onClick={() => linkQueue.add('release3', scPass)}>SoundCloud pass on {scPass.length.toLocaleString()} releases (~{Math.max(1, Math.ceil(scPass.length * 0.6 / 60))} min)</button>}
      </div>
      {(q.pending > 0 || q.done > 0) && <div className="panel" style={{ marginTop: 12 }}>
        <div className="row"><strong className="num">{q.done.toLocaleString()} done, {q.pending.toLocaleString()} to go</strong><span className="muted small">{q.matched} matched · {q.errors} with errors</span><span className="spacer" />
          {q.paused ? <button className="btn sm" onClick={linkQueue.resume}>Resume</button> : <button className="btn sm" onClick={linkQueue.pause}>Pause</button>}
          <button className="btn sm ghost" onClick={linkQueue.clear}>Stop</button></div>
        <div className="progress" style={{ marginTop: 8 }}><div style={{ width: `${(q.done / Math.max(1, q.done + q.pending)) * 100}%` }} /></div>
        {q.last && <div className="small muted" style={{ marginTop: 6 }}>Last: {q.last}</div>}
      </div>}

      <h2 className="h-sec">Check matches</h2>
      <p className="muted" style={{ marginTop: 0 }}>Rechecks automatic matches with the stricter rules — catches things like “Pluto” matched to “Pluto × Baby Pluto”, sequels, instrumentals, live and clean versions. Wrong matches are re-matched or removed, and their cover, tracklist and labels are replaced. Anything left without a cover goes to Review matches.</p>
      <button className="btn primary" disabled={!recheck.length} onClick={async () => {
        // Fetch every linked Apple album in a few batch calls first, so each check doesn't need its own slow lookup
        const ids = recheckRel.map((r) => (r.ext.apple_id as number | undefined) ?? appleIdFromUrl(r.links.apple)).filter((x): x is number => !!x);
        try { say('Fetching your Apple Music matches…'); await appleAlbumsByIds(ids); } catch (e) { say(`Apple Music: ${(e as Error).message} — checking one by one instead`); }
        linkQueue.add('recheck', recheck);
      }}>Check {recheck.length.toLocaleString()} releases (~{Math.max(1, Math.ceil(recheckSecs * 1.35 / 60))} min)</button>

      <h2 className="h-sec">Tracklists</h2>
      <p className="muted" style={{ marginTop: 0 }}>Gets the tracklist for every release that's linked to Apple Music, Deezer or MusicBrainz, so every song can be rated, searched and added to playlists. Apple goes first because its songs can be played here. Albums that already have tracks only get the missing ones.</p>
      <button className="btn primary" disabled={!needTracks.length} onClick={() => linkQueue.add('tracks', needTracks.map((r) => r.id))}>Get tracklists for {needTracks.length.toLocaleString()} releases (~{trackSecs > 3600 ? `${(trackSecs / 3600).toFixed(1)} h` : `${Math.max(1, Math.ceil(trackSecs / 60))} min`})</button>

      <h2 className="h-sec">Connections</h2>
      <button className="btn" onClick={check}>Check connections</button>
      {Object.keys(checks).length > 0 && <table className="table" style={{ marginTop: 10 }}><tbody>{Object.entries(checks).map(([n, s]) => <tr key={n}><td style={{ fontWeight: 600 }}>{n}</td><td style={{ color: s === 'working' ? 'inherit' : s === 'checking…' ? 'var(--muted)' : 'var(--danger)' }}>{s}</td></tr>)}</tbody></table>}

      <h2 className="h-sec">Backup</h2>
      <div className="row"><button className="btn" onClick={exportJson}>Download a backup</button>
        <label className="btn">Restore from backup<input type="file" accept=".json" hidden onChange={(e) => e.target.files?.[0] && restoreJson(e.target.files[0])} /></label></div>

      <h2 className="h-sec">Appearance</h2>
      <div className="seg">{[['', 'Match system'], ['light', 'Light'], ['dark', 'Dark']].map(([v, l]) => <button key={v} className={theme === v ? 'on' : ''} onClick={() => { setTheme(v); setT(v); }}>{l}</button>)}</div>

      <h2 className="h-sec">Storage</h2>
      <p className="muted" style={{ marginTop: 0 }}>{mode === 'cloud' ? 'Your library is saved to your Supabase account and syncs across devices.' : 'Supabase isn’t connected, so your library is saved in this browser only. Download backups regularly.'}</p>
      {supabase && <button className="btn" onClick={() => supabase!.auth.signOut()}>Sign out</button>}
    </div>
  );
}
