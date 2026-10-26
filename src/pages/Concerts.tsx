import { useState } from 'react';
import { Link } from 'react-router-dom';
import { SortSelect, usePref, flip } from '../components/controls';
import { fmtDate, Stars } from '../components/ui';
import { useStore } from '../lib/store';
import type { Concert } from '../lib/types';
import { uid } from '../lib/util';

export default function Concerts() {
  const st = useStore();
  const { data, upsert, remove } = st;
  const blank = { date: '', artist: '', tour: '', venue: '', location: '', support: '' };
  const [f, setF] = useState(blank);
  const [sort, setSort] = usePref('concerts.sort', 'newest');
  const [rev, setRev] = usePref('concerts.rev', false);
  const rows0 = [...data.concerts].sort(sort === 'oldest' ? (a, b) => (a.date ?? '').localeCompare(b.date ?? '') : sort === 'rating' ? (a, b) => (b.rating ?? 0) - (a.rating ?? 0)
    : sort === 'artist' ? (a, b) => (a.artist_credit ?? '').localeCompare(b.artist_credit ?? '') : sort === 'city' ? (a, b) => (a.location ?? '').localeCompare(b.location ?? '') : (a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
  const rows = flip(rows0, rev, (c) => (sort === 'rating' ? !!c.rating : true));
  const set = (c: Concert, p: Partial<Concert>) => upsert('concerts', [{ ...c, ...p }]);
  return (
    <div>
      <div className="row" style={{ marginBottom: 20 }}><h1 className="h-page">Concerts</h1><span className="spacer" />
        <SortSelect value={sort} onChange={(v) => { setSort(v); setRev(false); }} rev={rev} onRev={setRev} options={[['newest', 'Date'], ['rating', 'Your rating'], ['artist', 'Artist A–Z'], ['city', 'City A–Z']]} /></div>
      <form className="panel form-grid" style={{ marginBottom: 24, gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }} onSubmit={async (e) => {
        e.preventDefault(); if (!f.artist.trim()) return;
        const { artist } = st.ensureArtist(f.artist.trim());
        await upsert('concerts', [{ id: uid(), date: f.date || null, artist_id: artist.id, artist_credit: f.artist.trim(), tour: f.tour || null, venue: f.venue || null, location: f.location || null, support: f.support || null, rating: null, review: null }]);
        setF(blank);
      }}>
        <label><span className="label">Date</span><input className="input" style={{ width: '100%' }} type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></label>
        <label><span className="label">Artist</span><input className="input" style={{ width: '100%' }} required value={f.artist} onChange={(e) => setF({ ...f, artist: e.target.value })} /></label>
        <label><span className="label">Tour</span><input className="input" style={{ width: '100%' }} value={f.tour} onChange={(e) => setF({ ...f, tour: e.target.value })} /></label>
        <label><span className="label">Venue</span><input className="input" style={{ width: '100%' }} value={f.venue} onChange={(e) => setF({ ...f, venue: e.target.value })} /></label>
        <label><span className="label">City</span><input className="input" style={{ width: '100%' }} value={f.location} onChange={(e) => setF({ ...f, location: e.target.value })} /></label>
        <label><span className="label">Support</span><input className="input" style={{ width: '100%' }} value={f.support} onChange={(e) => setF({ ...f, support: e.target.value })} /></label>
        <div style={{ alignSelf: 'end' }}><button className="btn primary">Add concert</button></div>
      </form>
      {!rows.length ? <div className="empty">No concerts yet.</div> : (
        <div className="table-wrap"><table className="table">
          <thead><tr><th>Date</th><th>Artist</th><th>Tour</th><th>Venue</th><th>Support</th><th>Rating</th><th>Review</th><th /></tr></thead>
          <tbody>{rows.map((c) => (
            <tr key={c.id}>
              <td className="num" style={{ whiteSpace: 'nowrap' }}>{fmtDate(c.date)}</td>
              <td style={{ fontWeight: 600 }}>{c.artist_id ? <Link to={`/artist/${c.artist_id}`}>{c.artist_credit}</Link> : c.artist_credit}</td>
              <td>{c.tour}</td><td className="muted">{[c.venue, c.location].filter(Boolean).join(', ')}</td><td className="muted">{c.support}</td>
              <td><Stars value={c.rating} onChange={(rating) => set(c, { rating })} /></td>
              <td><input className="input" style={{ width: 220 }} defaultValue={c.review ?? ''} placeholder="How was it?" onBlur={(e) => e.target.value !== (c.review ?? '') && set(c, { review: e.target.value || null })} /></td>
              <td><button className="btn sm ghost" onClick={() => confirm('Delete this concert?') && remove('concerts', [c.id])}>Delete</button></td>
            </tr>))}</tbody>
        </table></div>
      )}
    </div>
  );
}
