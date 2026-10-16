import * as XLSX from 'xlsx';
import { annId, norm, now, uid } from './util';
import type { Annotation, Artist, Concert, Credit, DataSet, List, ListItem, Release, Track } from './types';

export interface ImportResult {
  rows: Partial<DataSet>;           // rows to upsert (new or changed)
  summary: string[];                // human-readable outcome
  warnings: string[];
}

type Row = Record<string, unknown>;

/** Read a sheet into objects, using the first row whose first cell equals `firstHeader` as the header row. */
function readSheet(wb: XLSX.WorkBook, name: string, firstHeader: string): Row[] {
  const ws = wb.Sheets[name];
  if (!ws) return [];
  const grid = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: true, defval: null });
  const h = grid.findIndex((r) => String(r[0] ?? '').trim() === firstHeader);
  if (h < 0) return [];
  const headers = grid[h].map((x) => String(x ?? '').trim());
  return grid.slice(h + 1).map((r) => Object.fromEntries(headers.map((k, i) => [k, r[i]])).valueOf() as Row)
    .filter((r) => Object.values(r).some((v) => v !== null && v !== ''));
}

const str = (v: unknown) => (v === null || v === undefined ? '' : String(v).trim());
const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) && str(v) !== '' ? n : null; };
function isoDate(v: unknown): string | null {
  if (v instanceof Date && !isNaN(+v)) {
    // SheetJS gives local-midnight dates; read the calendar day back in local time.
    const p = (n: number) => String(n).padStart(2, '0');
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
  }
  const s = str(v);
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
}

/** "J Dilla & Madlib as Jaylib" → group Jaylib, members J Dilla, Madlib. Collaborations split on & / x / ,. */
export function parseArtistCredit(credit: string, isCollab: boolean): { names: string[]; group?: string } {
  const as = credit.split(/\s+as\s+/i);
  if (as.length === 2) return { group: as[1].trim(), names: splitNames(as[0]) };
  return { names: isCollab ? splitNames(credit) : [credit.trim()] };
}
const splitNames = (s: string) => s.split(/\s*(?:&|,|\bx\b)\s*/i).map((x) => x.trim()).filter(Boolean);

export function importWorkbook(buf: ArrayBuffer, existing: DataSet): ImportResult {
  const wb = XLSX.read(buf, { cellDates: true });
  const warnings: string[] = [];
  const summary: string[] = [];

  // Working copies keyed for matching
  const artistsByName = new Map<string, Artist>();
  for (const a of existing.artists) for (const n of [a.name, ...a.aliases]) artistsByName.set(norm(n), a);
  const relKey = (title: string, credit: string, year: number | null | undefined, type: string) => `${norm(title)}|${norm(credit)}|${year ?? ''}|${norm(type)}`;
  const relLoose = (title: string, credit: string) => `${norm(title)}|${norm(credit)}`;
  const releasesByKey = new Map<string, Release>();
  const releasesLoose = new Map<string, Release>();
  for (const r of existing.releases) {
    releasesByKey.set(relKey(r.title, r.artist_credit ?? '', r.year, r.type), r);
    releasesLoose.set(relLoose(r.title, r.artist_credit ?? ''), r);
  }
  const creditKeys = new Set(existing.credits.map((c) => `${c.artist_id}|${c.release_id ?? ''}|${c.track_id ?? ''}|${c.role}`));
  const annById = new Map(existing.annotations.map((a) => [a.id, a]));

  const out = { artists: new Map<string, Artist>(), releases: new Map<string, Release>(), tracks: [] as Track[], credits: [] as Credit[], annotations: new Map<string, Annotation>(), lists: [] as List[], list_items: [] as ListItem[], concerts: [] as Concert[] };
  let newArtists = 0, newReleases = 0, updatedReleases = 0;

  function artist(name: string, producer = false): Artist {
    const k = norm(name);
    let a = artistsByName.get(k);
    if (!a) {
      a = { id: uid(), name: name.trim(), is_producer: producer, aliases: [], links: {}, ext: {}, created_at: now(), updated_at: now() };
      artistsByName.set(k, a); out.artists.set(a.id, a); newArtists++;
    } else if (producer && !a.is_producer) {
      a = { ...a, is_producer: true, updated_at: now() };
      artistsByName.set(k, a); out.artists.set(a.id, a);
    }
    return a;
  }
  function credit(artistId: string, target: { release_id?: string; track_id?: string }, role: Credit['role'], position: number) {
    const k = `${artistId}|${target.release_id ?? ''}|${target.track_id ?? ''}|${role}`;
    if (creditKeys.has(k)) return;
    creditKeys.add(k);
    out.credits.push({ id: uid(), artist_id: artistId, release_id: target.release_id ?? null, track_id: target.track_id ?? null, role, position });
  }
  function creditRelease(rel: Release, creditStr: string) {
    const { names, group } = parseArtistCredit(creditStr, /collab/i.test(rel.type));
    let pos = 0;
    if (group) credit(artist(group).id, { release_id: rel.id }, 'primary', pos++);
    for (const n of names) credit(artist(n).id, { release_id: rel.id }, 'primary', pos++);
  }
  function setRating(type: 'release' | 'artist' | 'track', id: string, rating: number | null) {
    if (rating === null) return;
    const key = annId(type, id);
    const cur = out.annotations.get(key) ?? annById.get(key) ?? { id: key, entity_type: type, entity_id: id, favorite: false };
    if (cur.rating === rating) return;
    out.annotations.set(key, { ...cur, rating, updated_at: now() });
  }
  function upsertRelease(fields: { title: string; credit: string; type: string; date: string | null; year: number | null; source: string }): Release {
    const k = relKey(fields.title, fields.credit, fields.year, fields.type);
    const prev = releasesByKey.get(k);
    if (prev) {
      const next: Release = { ...prev, date: fields.date ?? prev.date, year: fields.year ?? prev.year, type: fields.type || prev.type, updated_at: now() };
      if (next.date !== prev.date || next.year !== prev.year || next.type !== prev.type) { out.releases.set(next.id, next); updatedReleases++; }
      releasesByKey.set(k, next);
      return next;
    }
    const r: Release = { id: uid(), title: fields.title, type: fields.type || 'Album', date: fields.date, year: fields.year, artist_credit: fields.credit, source: fields.source, links: {}, ext: {}, created_at: now(), updated_at: now() };
    releasesByKey.set(k, r); releasesLoose.set(relLoose(r.title, fields.credit), r); out.releases.set(r.id, r); newReleases++;
    return r;
  }
  function yearOf(date: string | null, yearCell: unknown, label: string): number | null {
    const y = num(yearCell);
    const dy = date ? Number(date.slice(0, 4)) : null;
    if (y !== null && dy !== null && y !== dy) { warnings.push(`${label}: year ${y} doesn't match date ${date}; used ${dy}.`); return dy; }
    return y ?? dy;
  }

  // 1. ALBUMS + UPCOMING
  for (const sheet of ['ALBUMS', 'UPCOMING']) {
    const rows = readSheet(wb, sheet, 'Date');
    let n = 0;
    for (const r of rows) {
      const title = str(r['Title']); const creditStr = str(r['Artist']);
      if (!title || !creditStr) continue;
      const date = isoDate(r['Date']);
      const rel = upsertRelease({ title, credit: creditStr, type: str(r['Type']) || 'Album', date, year: yearOf(date, r['Year'], `${creditStr} – ${title}`), source: 'sheet' });
      creditRelease(rel, creditStr);
      const prod = str(r['Producer'] ?? r['Executive Producer']);
      if (prod) splitNames(prod).forEach((p, i) => credit(artist(p, true).id, { release_id: rel.id }, 'exec_producer', i));
      setRating('release', rel.id, num(r['Stars'] ?? r['Rating']));
      n++;
    }
    if (rows.length) summary.push(`${sheet}: ${n} releases read`);
  }

  // 2. Leaks & Compilations — track-level; grouped into releases
  const leakRows = readSheet(wb, 'Leaks & Compilations', 'Disc Number');
  if (leakRows.length) {
    const existingTrackKeys = new Set(existing.tracks.map((t) => `${t.release_id}|${norm(t.title)}`));
    let nt = 0;
    const groups = new Map<string, Row[]>();
    for (const r of leakRows) {
      const k = `${str(r['Album Title'])}|${str(r['Album Artist'])}`;
      if (!str(r['Album Title'])) continue;
      (groups.get(k) ?? groups.set(k, []).get(k)!).push(r);
    }
    for (const rows of groups.values()) {
      const first = rows[0];
      const title = str(first['Album Title']); const albumArtist = str(first['Album Artist']) || str(first['Artist']);
      const date = isoDate(first['Release Date']);
      const loose = releasesLoose.get(relLoose(title, albumArtist));
      const rel = loose ?? upsertRelease({ title, credit: albumArtist, type: str(first['Type']) || 'Compilation', date, year: yearOf(date, first['Year'], `${albumArtist} – ${title}`), source: 'sheet' });
      if (!loose) creditRelease(rel, albumArtist);
      rows.forEach((r, i) => {
        const tTitle = str(r['Track Title']);
        if (!tTitle || existingTrackKeys.has(`${rel.id}|${norm(tTitle)}`)) return;
        existingTrackKeys.add(`${rel.id}|${norm(tTitle)}`);
        const t: Track = { id: uid(), release_id: rel.id, disc: num(r['Disc Number']), number: num(r['Track Number']) ?? i + 1, title: tTitle, artist_credit: str(r['Artist']) && norm(str(r['Artist'])) !== norm(albumArtist) ? str(r['Artist']) : null, links: {}, ext: {}, created_at: now(), updated_at: now() };
        out.tracks.push(t); nt++;
        const ta = str(r['Artist']);
        if (ta && norm(ta) !== norm(albumArtist)) credit(artist(ta).id, { track_id: t.id }, 'primary', 0);
      });
    }
    summary.push(`Leaks & Compilations: ${nt} tracks across ${groups.size} releases`);
  }

  // 3. Concerts
  const concertRows = readSheet(wb, 'Concerts', 'Date');
  const concertKeys = new Set(existing.concerts.map((c) => `${c.date}|${norm(c.artist_credit ?? '')}`));
  for (const r of concertRows) {
    const a = str(r['Artist']); const date = isoDate(r['Date']);
    if (!a || concertKeys.has(`${date}|${norm(a)}`)) continue;
    const sup = str(r['Supporting Acts']);
    out.concerts.push({ id: uid(), date, location: str(r['Location']) || null, venue: str(r['Venue']) || null, tour: str(r['Tour']) || null, artist_id: artist(a).id, artist_credit: a, support: sup && sup !== '-' ? sup : null, rating: num(r['Rating']), review: str(r['Review']) || null });
  }
  if (concertRows.length) summary.push(`Concerts: ${out.concerts.length} added`);

  // 4. Curated sheets → lists
  const existingLists = new Map(existing.lists.map((l) => [norm(l.name), l]));
  function list(name: string, description: string, ranked: boolean, items: Omit<ListItem, 'id' | 'list_id' | 'position'>[]) {
    if (!items.length) return;
    if (existingLists.has(norm(name))) { summary.push(`List "${name}" already exists; skipped`); return; }
    const l: List = { id: uid(), name, description, ranked, created_at: now(), updated_at: now() };
    out.lists.push(l);
    items.forEach((it, i) => out.list_items.push({ id: uid(), list_id: l.id, position: i + 1, ...it }));
    summary.push(`List "${name}": ${items.length} items`);
  }
  /** Link to a release already in the library; otherwise keep a text item that can be added later. */
  function releaseItem(title: string, creditStr: string, note: string | null, year?: number | null) {
    const rel = releasesLoose.get(relLoose(title, creditStr));
    if (rel) return { entity_type: 'release' as const, entity_id: rel.id, note };
    return { entity_type: 'text' as const, entity_id: null, label: `${creditStr} — ${title}${year ? ` (${year})` : ''}`, note };
  }

  const defJam = readSheet(wb, 'Def Jam', 'Release Date');
  list('Def Jam catalogue', 'Imported from the Def Jam sheet', false, defJam.filter((r) => str(r['Album'])).map((r) => {
    const d = isoDate(r['Release Date']);
    return releaseItem(str(r['Album']), str(r['Artist']), d, d ? Number(d.slice(0, 4)) : null);
  }));

  const fresh = readSheet(wb, 'FRESHMEN', 'Type');
  list('XXL Freshmen', 'Imported from the FRESHMEN sheet', false, fresh.filter((r) => str(r['Artist'])).map((r) => ({
    entity_type: 'artist' as const, entity_id: artist(str(r['Artist'])).id,
    note: [str(r['Year']), str(r['Type']) === 'Declined' ? 'declined' : str(r['Type']) === 'XXL' ? '' : str(r['Type'])].filter(Boolean).join(' · ') || null,
  })));

  const stanfield = readSheet(wb, 'Stanfield Nominations', 'Decade');
  list('Stanfield nominations', 'Imported from the Stanfield Nominations sheet', false, stanfield.filter((r) => str(r['Album'])).map((r) =>
    releaseItem(str(r['Album']), str(r['Artist']), str(r['Stanfield Comments']) || null, num(r['Year']))));

  summary.unshift(`${newReleases} new releases, ${updatedReleases} updated, ${newArtists} new artists, ${out.annotations.size} ratings`);

  return {
    rows: {
      artists: [...out.artists.values()], releases: [...out.releases.values()], tracks: out.tracks, credits: out.credits,
      annotations: [...out.annotations.values()], lists: out.lists, list_items: out.list_items, concerts: out.concerts,
    },
    summary, warnings,
  };
}
