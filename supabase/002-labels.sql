-- Labels (run once in Supabase: SQL Editor → paste → Run)
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
  foreach t in array array['labels','release_labels','artist_labels']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists owner_all on %I', t);
    execute format('create policy owner_all on %I for all using (owner = auth.uid()) with check (owner = auth.uid())', t);
  end loop;
end $$;
