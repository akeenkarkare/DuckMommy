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
begin
  insert into public.profiles (user_id, display_name)
  values (new.id, new.raw_user_meta_data ->> 'display_name');

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
