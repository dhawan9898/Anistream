-- Error reports from AniStream, CineStream and Mangapill: app crashes, screen errors, provider and
-- source failures, playback errors, failed requests and sync problems. Run once in the project's
-- SQL editor (after schema.sql). Safe to run again.
--
-- Anyone running the apps may ADD a report (signed in or not - a crash at the sign-in screen must
-- still be reported); nobody can read, change or delete reports through the public key. They are
-- read with the database password (see app_error_summary below).

create table if not exists public.app_errors (
  id          bigint generated always as identity primary key,
  created_at  timestamptz not null default now(),
  occurred_at timestamptz,
  app         text not null check (app in ('anistream', 'cinestream', 'mangapill')),
  app_version text check (char_length(app_version) <= 40),
  device      text check (char_length(device) <= 200),
  session_id  text check (char_length(session_id) <= 64),
  user_id     uuid default auth.uid(),
  kind        text not null check (kind in ('crash', 'error', 'render', 'provider', 'source', 'playback', 'network', 'sync', 'image', 'download', 'update')),
  message     text not null check (char_length(message) <= 2000),
  stack       text check (char_length(stack) <= 20000),
  context     jsonb check (context is null or pg_column_size(context) < 20000),
  fingerprint text not null check (char_length(fingerprint) <= 120),
  -- Sightings of the same error in one app session folded into this row (the app sends each once).
  occurrences integer not null default 1 check (occurrences between 1 and 100000)
);

create index if not exists app_errors_recent on public.app_errors (created_at desc);
create index if not exists app_errors_fingerprint on public.app_errors (app, fingerprint, created_at desc);
create index if not exists app_errors_session on public.app_errors (session_id, created_at desc);

alter table public.app_errors enable row level security;

drop policy if exists "anyone can report" on public.app_errors;
create policy "anyone can report" on public.app_errors for insert to anon, authenticated
  with check (user_id is null or user_id = auth.uid());

revoke all on public.app_errors from anon, authenticated;
grant insert on public.app_errors to anon, authenticated;

-- A misbehaving (or abused) client cannot flood the table: at most 300 reports per app session per
-- hour; the rest are dropped without an error, so the app never retries them.
create or replace function public.app_errors_throttle() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.session_id is not null and (
    select count(*) from public.app_errors
    where session_id = new.session_id and created_at > now() - interval '1 hour'
  ) >= 300 then
    return null;
  end if;
  return new;
end $$;

drop trigger if exists app_errors_throttle on public.app_errors;
create trigger app_errors_throttle before insert on public.app_errors
  for each row execute function public.app_errors_throttle();

-- What is going wrong, most frequent first. Not reachable through the public key.
create or replace view public.app_error_summary with (security_invoker = true) as
select app, kind, fingerprint,
       min(message)                          as message,
       sum(occurrences)                      as occurrences,
       count(distinct session_id)            as sessions,
       count(distinct coalesce(user_id::text, session_id)) as people,
       array_agg(distinct app_version)       as versions,
       min(created_at)                       as first_seen,
       max(created_at)                       as last_seen
from public.app_errors
group by app, kind, fingerprint;

revoke all on public.app_error_summary from anon, authenticated;
