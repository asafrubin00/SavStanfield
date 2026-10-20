-- Custom covers for lists and playlists (run once in Supabase: SQL Editor → paste → Run)
alter table lists add column if not exists cover_url text;
