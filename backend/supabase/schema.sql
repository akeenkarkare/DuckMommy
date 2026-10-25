-- Duck Daddy — Supabase schema (DRAFT for review)
-- Run in the Supabase SQL editor. Users live in auth.users (Supabase Auth).
-- Events are NOT stored — they're relayed live and buffered in memory (5 min) by the Node relay.
-- There is exactly one duck, so there is no devices table. The Pi authenticates to the relay
-- with a single shared DUCK_TOKEN from .env.
--
-- Who touches what:
--   Dashboard (Next.js, user session)  -> profiles, settings (own rows only, via RLS)
--   Node relay (service role key)      -> settings (read, Realtime subscribe)
--   Pi                                 -> never talks to Supabase directly


-- ─── Shared: auto-update updated_at ─────────────────────────────────────────
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;


-- ─── profiles: one per user, filled from the register form ─────────────────
create table public.profiles (
  user_id      uuid primary key references auth.users (id) on delete cascade,
  display_name text check (char_length(display_name) <= 50),
  -- Sentry iMessage alerts (Photon), E.164. Read by the relay only, never pushed to the Pi. (migration 006)
  phone        text check (phone is null or phone ~ '^\+[1-9][0-9]{6,14}$'),
  -- Sentry ntfy pushes go to this user's own topic (migration 007). Made by the dashboard.
  ntfy_topic   text unique check (ntfy_topic is null or ntfy_topic ~ '^[A-Za-z0-9_-]{12,64}$'),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create trigger profiles_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();


-- ─── settings: one row per user, edited on the dashboard ───────────────────
-- Pushed to the Pi by the relay whenever a row changes.
create table public.settings (
  user_id          uuid primary key references auth.users (id) on delete cascade,

  -- Audio
  volume           smallint not null default 70 check (volume between 0 and 100),

  -- What the duck says (TTS on the Pi, in the duck's own voice)
  posture_message  text not null default 'Sit up straight!'      check (char_length(posture_message) <= 200),
  sentry_message   text not null default 'Who goes there?'       check (char_length(sentry_message)  <= 200),
  presence_message text          default 'Welcome back!'         check (char_length(presence_message) <= 200),  -- null = stay quiet

  -- Posture severity: placeholder until the posture code exists.
  -- 0 = only very bad slouches count, 100 = any lean counts.
  posture_severity smallint not null default 50 check (posture_severity between 0 and 100),
  posture_delay_s  smallint not null default 5  check (posture_delay_s between 1 and 120),  -- slouch must last this long

  -- Feature toggles
  posture_enabled  boolean not null default true,    -- posture checks (migration 008)
  sentry_enabled   boolean not null default false,
  quack_enabled    boolean not null default true,
  sign_enabled         boolean not null default true,   -- Sign to Duck (ASL -> speech)
  sound_alerts_enabled boolean not null default true,   -- doorbell/phone/alarm -> LED

  -- Lock-in coach (pi/coach): check-ins, deadline reminders, focus sessions
  coach_enabled      boolean  not null default true,
  coach_interval_min smallint not null default 25      check (coach_interval_min between 5 and 120),
  coach_tone         text     not null default 'coach' check (coach_tone in ('gentle', 'coach', 'savage')),
  -- iCal feed links, one per line (Google "secret address in iCal format", Brightspace/Canvas feeds).
  -- Secret: read by the relay only, never pushed to the Pi.
  calendar_urls      text check (char_length(calendar_urls) <= 2000),

  updated_at       timestamptz not null default now()
);

create trigger settings_updated_at
  before update on public.settings
  for each row execute function public.set_updated_at();


-- ─── On register: create the user's profile + default settings ─────────────
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  phone text := new.raw_user_meta_data ->> 'phone';
begin
  -- A malformed phone is dropped rather than failing the sign-up.
  insert into public.profiles (user_id, display_name, phone)
  values (new.id, new.raw_user_meta_data ->> 'display_name',
          case when phone ~ '^\+[1-9][0-9]{6,14}$' then phone end);

  insert into public.settings (user_id)
  values (new.id);

  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();


-- ─── Row-level security: users see and edit only their own rows ────────────
alter table public.profiles enable row level security;
alter table public.settings enable row level security;

create policy "own profile: read"   on public.profiles for select to authenticated using ((select auth.uid()) = user_id);
create policy "own profile: update" on public.profiles for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

create policy "own settings: read"   on public.settings for select to authenticated using ((select auth.uid()) = user_id);
create policy "own settings: update" on public.settings for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);


-- ─── Realtime: relay listens for settings changes and pushes them to the Pi ─
alter publication supabase_realtime add table public.settings;


-- ─── Google Calendar via Auth0 (migration 004) ────────────────────────────
-- Only the Auth0 user id is stored; the Google tokens stay in Auth0.
create table if not exists public.google_calendar (
  user_id      uuid primary key references auth.users (id) on delete cascade,
  auth0_sub    text not null check (char_length(auth0_sub) <= 200),
  email        text check (char_length(email) <= 320),
  connected_at timestamptz not null default now()
);
alter table public.google_calendar enable row level security;
create policy "own google calendar: read" on public.google_calendar
  for select to authenticated using ((select auth.uid()) = user_id);

-- ─── Memory locker: "hey duck, remember ..." (see migrations/004_memories.sql) ─
create table if not exists public.memories (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references auth.users (id) on delete cascade,
  text       text not null check (char_length(text) between 1 and 500),   -- Claude's cleaned-up sentence
  source     text not null default 'voice' check (source in ('voice', 'sign', 'typed')),
  created_at timestamptz not null default now()
);

create index if not exists memories_user_time on public.memories (user_id, created_at desc);

alter table public.memories enable row level security;

drop policy if exists "own memories: read" on public.memories;
drop policy if exists "own memories: delete" on public.memories;
drop policy if exists "own memories: insert" on public.memories;
create policy "own memories: read"   on public.memories for select to authenticated using ((select auth.uid()) = user_id);
create policy "own memories: delete" on public.memories for delete to authenticated using ((select auth.uid()) = user_id);
create policy "own memories: insert" on public.memories for insert to authenticated with check ((select auth.uid()) = user_id and source = 'typed');


-- ─── Voice reminders: "hey duck, remind me ..." (see migrations/005_reminders.sql) ─
-- The dashboard can read and cancel (delete) its own rows through RLS.
create table if not exists public.reminders (
  id           bigint generated always as identity primary key,
  user_id      uuid not null references auth.users (id) on delete cascade,
  text         text not null check (char_length(text) between 1 and 200),   -- "email your TA about the lab report"
  due_at       timestamptz not null,
  delivered_at timestamptz,                                                   -- null = still to say
  source       text not null default 'voice' check (source in ('voice', 'typed')),
  created_at   timestamptz not null default now()
);

create index if not exists reminders_pending on public.reminders (user_id, due_at) where delivered_at is null;

alter table public.reminders enable row level security;

drop policy if exists "own reminders: read" on public.reminders;
drop policy if exists "own reminders: delete" on public.reminders;
create policy "own reminders: read"   on public.reminders for select to authenticated using ((select auth.uid()) = user_id);
create policy "own reminders: delete" on public.reminders for delete to authenticated using ((select auth.uid()) = user_id);
