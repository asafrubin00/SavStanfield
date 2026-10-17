import type { VercelRequest, VercelResponse } from '@vercel/node';

// Server-side proxy for the music APIs. Keeps API keys off the browser and gets around CORS.
// Runs as a Vercel function in production; vite.config.ts reuses proxy() in local dev.

const UA = 'SavStanfield/0.1 ( https://github.com/asafrubin00/savstanfield )';

type Env = Record<string, string | undefined>;

const SOURCES: Record<string, (path: string, qs: URLSearchParams, env: Env) => { url: string; headers?: Record<string, string> } | string> = {
  itunes: (p, qs) => {
    if (!/^(search|lookup)$/.test(p)) return 'bad path';
    if (!qs.has('country')) qs.set('country', 'GB');
    return { url: `https://itunes.apple.com/${p}?${qs}` };
  },
  mb: (p, qs) => { qs.set('fmt', 'json'); return { url: `https://musicbrainz.org/ws/2/${p}?${qs}`, headers: { 'User-Agent': UA } }; },
  deezer: (p, qs) => ({ url: `https://api.deezer.com/${p}?${qs}`, headers: { 'User-Agent': UA } }),
  genius: (p, qs, env) => env.GENIUS_TOKEN
    ? { url: `https://api.genius.com/${p}?${qs}`, headers: { Authorization: `Bearer ${env.GENIUS_TOKEN}` } }
    : 'Genius token not set (GENIUS_TOKEN)',
  youtube: (p, qs, env) => {
    if (!env.YOUTUBE_KEY) return 'YouTube key not set (YOUTUBE_KEY)';
    qs.set('key', env.YOUTUBE_KEY);
    return { url: `https://www.googleapis.com/youtube/v3/${p}?${qs}` };
  },
  wiki: (p, qs) => ({ url: `https://en.wikipedia.org/${p}?${qs}`, headers: { 'User-Agent': UA } }),
  wikidata: (p, qs) => ({ url: `https://www.wikidata.org/${p}?${qs}`, headers: { 'User-Agent': UA } }),
  caa: (p) => ({ url: `https://coverartarchive.org/${p}`, headers: { 'User-Agent': UA } }),
};

const verified = new Map<string, number>();

async function authorised(authHeader: string | undefined, env: Env): Promise<boolean> {
  const base = env.SUPABASE_URL ?? env.VITE_SUPABASE_URL;
  const anon = env.SUPABASE_ANON_KEY ?? env.VITE_SUPABASE_ANON_KEY;
  if (!base || !anon) return true; // local mode: no accounts, nothing to check
  const token = authHeader?.replace(/^Bearer\s+/i, '');
  if (!token) return false;
  const exp = verified.get(token);
  if (exp && exp > Date.now()) return true;
  const r = await fetch(`${base}/auth/v1/user`, { headers: { apikey: anon, Authorization: `Bearer ${token}` } });
  if (!r.ok) return false;
  verified.set(token, Date.now() + 10 * 60_000);
  return true;
}

export async function proxy(rawQuery: string, authHeader: string | undefined, env: Env): Promise<{ status: number; body: string; type: string }> {
  const qs = new URLSearchParams(rawQuery);
  const src = qs.get('src') ?? ''; const path = (qs.get('path') ?? '').replace(/^\/+/, '');
  qs.delete('src'); qs.delete('path');
  const make = SOURCES[src];
  if (!make) return { status: 400, body: JSON.stringify({ error: `Unknown source "${src}"` }), type: 'application/json' };
  if (path.includes('..')) return { status: 400, body: JSON.stringify({ error: 'Bad path' }), type: 'application/json' };
  if (!(await authorised(authHeader, env))) return { status: 401, body: JSON.stringify({ error: 'Sign in first' }), type: 'application/json' };
  const target = make(path, qs, env);
  if (typeof target === 'string') return { status: 501, body: JSON.stringify({ error: target }), type: 'application/json' };
  try {
    const r = await fetch(target.url, { headers: { Accept: 'application/json', ...target.headers } });
    return { status: r.status, body: await r.text(), type: r.headers.get('content-type') ?? 'application/json' };
  } catch (e) {
    return { status: 502, body: JSON.stringify({ error: `Couldn't reach ${src}: ${(e as Error).message}` }), type: 'application/json' };
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const q = req.url?.split('?')[1] ?? '';
  const out = await proxy(q, req.headers.authorization, process.env);
  res.setHeader('Content-Type', out.type);
  if (out.status === 200) res.setHeader('Cache-Control', 'private, max-age=3600');
  res.status(out.status).send(out.body);
}
