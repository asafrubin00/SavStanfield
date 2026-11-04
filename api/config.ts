import type { VercelRequest, VercelResponse } from '@vercel/node';

/*
 * Where the database is, for the Scriptable widgets. Both values are already public (they're in the web app's code);
 * what you can read is still limited to your own library by your sign-in.
 */
export default function handler(_req: VercelRequest, res: VercelResponse) {
  const env = process.env;
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.status(200).json({ supabaseUrl: env.SUPABASE_URL ?? env.VITE_SUPABASE_URL ?? null, anonKey: env.SUPABASE_ANON_KEY ?? env.VITE_SUPABASE_ANON_KEY ?? null });
}
