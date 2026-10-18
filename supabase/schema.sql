-- Music Hub schema. Run once in Supabase: SQL Editor → paste → Run.
-- Every row belongs to the signed-in user (owner). Row-level security keeps it private.

create table if not exists artists (
  owner uuid not null default auth.uid(),
  id text not null,
  name text not null,
  is_producer boolean not null default false,
  image_url text,
  bio text,
  aliases text[] not null default '{}',
  links jsonb not null default '{}',
  ext jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (owner, id)
);

create table if not exists releases (
  owner uuid not null default auth.uid(),
  id text not null,
  title text not null,
  type text not null default 'Album',
  date text,
  year int,
  artist_credit text,
  artwork_url text,
  label text,
  source text not null default 'manual',
  links jsonb not null default '{}',
  ext jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (owner, id)
);

create table if not exists tracks (
  owner uuid not null default auth.uid(),
  id text not null,
  release_id text,
  disc int,
  number int,
  title text not null,
  artist_credit text,
  duration_ms int,
  links jsonb not null default '{}',
  ext jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (owner, id)
);

-- Who did what: primary artist, featured, producer, executive producer
create table if not exists credits (
  owner uuid not null default auth.uid(),
  id text not null,
  artist_id text not null,
  release_id text,
  track_id text,
  role text not null,
  position int not null default 0,
  primary key (owner, id)
);

-- Your ratings, favourites, reviews and notes on any artist, release or track
create table if not exists annotations (
  owner uuid not null default auth.uid(),
  id text not null,
  entity_type text not null,
  entity_id text not null,
  rating numeric,
  favorite boolean not null default false,
  review text,
  notes text,
  updated_at timestamptz not null default now(),
  primary key (owner, id)
);

create table if not exists critic_scores (
  owner uuid not null default auth.uid(),
  id text not null,
  release_id text not null,
  source text not null,
  score numeric,
  max numeric not null default 10,
  url text,
  created_at timestamptz not null default now(),
  primary key (owner, id)
);

create table if not exists lists (
  owner uuid not null default auth.uid(),
  id text not null,
  name text not null,
  description text,
  ranked boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (owner, id)
);

create table if not exists list_items (
  owner uuid not null default auth.uid(),
  id text not null,
  list_id text not null,
  entity_type text not null,
  entity_id text,
  label text,
  position int not null default 0,
  note text,
  primary key (owner, id)
);

create table if not exists concerts (
  owner uuid not null default auth.uid(),
  id text not null,
  date text,
  location text,
  venue text,
  tour text,
  artist_id text,
  artist_credit text,
  support text,
  rating numeric,
  review text,
  primary key (owner, id)
);

create table if not exists labels (
  owner uuid not null default auth.uid(),
  id text not null,
  name text not null,
  aliases text[] not null default '{}',
  image_url text,
  bio text,
  links jsonb not null default '{}',
  ext jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (owner, id)
);
create table if not exists release_labels (
  owner uuid not null default auth.uid(),
  id text not null,
  release_id text not null,
  label_id text not null,
  primary key (owner, id)
);
create table if not exists artist_labels (
  owner uuid not null default auth.uid(),
  id text not null,
  artist_id text not null,
  label_id text not null,
  primary key (owner, id)
);
do $$
declare t text;
begin
  foreach t in array array['artists','releases','tracks','credits','annotations','critic_scores','lists','list_items','concerts','labels','release_labels','artist_labels']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists owner_all on %I', t);
    execute format('create policy owner_all on %I for all using (owner = auth.uid()) with check (owner = auth.uid())', t);
  end loop;
end $$;
