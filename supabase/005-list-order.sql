-- Custom list covers and hand-ordered lists (run once in Supabase: SQL Editor → paste → Run)
-- Safe to run even if you already ran 004-list-covers.sql.
alter table lists add column if not exists cover_url text;
alter table lists add column if not exists custom_order boolean not null default false;
