-- Adds toggles for Sign to Duck and sound alerts. Run once in the Supabase SQL editor.
-- (schema.sql already includes these for fresh projects.)
alter table public.settings
  add column if not exists sign_enabled         boolean not null default true,
  add column if not exists sound_alerts_enabled boolean not null default true;
