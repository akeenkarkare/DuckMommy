-- Lock-in coach + calendar feeds. Run once in the Supabase SQL editor.
-- (schema.sql already includes these for fresh projects.)
alter table public.settings
  add column if not exists coach_enabled      boolean  not null default true,
  add column if not exists coach_interval_min smallint not null default 25,
  add column if not exists coach_tone         text     not null default 'coach',
  add column if not exists calendar_urls      text;

alter table public.settings
  drop constraint if exists settings_coach_interval_min_check,
  add  constraint settings_coach_interval_min_check check (coach_interval_min between 5 and 120),
  drop constraint if exists settings_coach_tone_check,
  add  constraint settings_coach_tone_check check (coach_tone in ('gentle', 'coach', 'savage')),
  drop constraint if exists settings_calendar_urls_check,
  add  constraint settings_calendar_urls_check check (char_length(calendar_urls) <= 2000);
