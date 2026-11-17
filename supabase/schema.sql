-- Sync storage for AniStream, CineStream and Mangapill (one Supabase project serves all three).
-- Run once in the project's SQL editor. Safe to run again.
--
-- One row per user, app and collection ("history", "bookmarks", "preferences", ...), holding that
-- collection as JSON. Row-level security limits every request to the signed-in user's own rows,
-- which is what makes it safe for the apps to ship the project's public ("anon") key.

create table if not exists public.user_data (
  user_id    uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  app        text        not null check (app in ('anistream', 'cinestream', 'mangapill')),
  kind       text        not null check (char_length(kind) between 1 and 40),
  data       jsonb       not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, app, kind),
  -- A collection is a few hundred small records; this stops a runaway client filling the database.
  constraint user_data_size check (pg_column_size(data) < 2000000)
);

alter table public.user_data enable row level security;

drop policy if exists "own rows: read" on public.user_data;
drop policy if exists "own rows: insert" on public.user_data;
drop policy if exists "own rows: update" on public.user_data;
drop policy if exists "own rows: delete" on public.user_data;

create policy "own rows: read"   on public.user_data for select to authenticated using (user_id = auth.uid());
create policy "own rows: insert" on public.user_data for insert to authenticated with check (user_id = auth.uid());
create policy "own rows: update" on public.user_data for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "own rows: delete" on public.user_data for delete to authenticated using (user_id = auth.uid());

-- Supabase grants every privilege on new tables by default; keep only what the apps use.
revoke all on public.user_data from anon, authenticated;
grant select, insert, update, delete on public.user_data to authenticated;
