-- Google Calendar via Auth0. Run once in the Supabase SQL editor.
-- (schema.sql already includes this for fresh projects.)
-- Only the Auth0 user id is stored; the Google tokens stay in Auth0.
create table if not exists public.google_calendar (
  user_id      uuid primary key references auth.users (id) on delete cascade,
  auth0_sub    text not null check (char_length(auth0_sub) <= 200),
  email        text check (char_length(email) <= 320),
  connected_at timestamptz not null default now()
);

alter table public.google_calendar enable row level security;
drop policy if exists "own google calendar: read" on public.google_calendar;
create policy "own google calendar: read" on public.google_calendar
  for select to authenticated using ((select auth.uid()) = user_id);
-- No insert/update/delete for users: the relay (service role) writes it after the Auth0 callback.
