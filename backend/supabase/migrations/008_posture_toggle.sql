-- Posture checks on/off (dashboard toggle, or "hey duck, posture off"). Run once in the Supabase SQL editor.
-- (schema.sql already includes this for fresh projects.) Pushed to the duck with the other settings.
alter table public.settings add column if not exists posture_enabled boolean not null default true;
