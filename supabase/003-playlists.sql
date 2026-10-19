-- Playlists (run once in Supabase: SQL Editor → paste → Run)
alter table lists add column if not exists kind text not null default 'list';
create index if not exists tracks_release_idx on tracks (owner, release_id);
