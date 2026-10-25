-- Phone number on the profile: sentry "Possible intruder" iMessages go here. Run once in the Supabase SQL editor.
-- (schema.sql already includes this for fresh projects.)
-- Read by the relay (secret key) when it texts; never pushed to the Pi. Users edit their own via RLS.
alter table public.profiles add column if not exists phone text
  check (phone is null or phone ~ '^\+[1-9][0-9]{6,14}$');   -- E.164, e.g. +15551234567

-- Register form sends it as `phone` in the sign-up metadata, next to display_name.
-- A malformed number is dropped (null) rather than failing the sign-up.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  phone text := new.raw_user_meta_data ->> 'phone';
begin
  insert into public.profiles (user_id, display_name, phone)
  values (new.id, new.raw_user_meta_data ->> 'display_name',
          case when phone ~ '^\+[1-9][0-9]{6,14}$' then phone end);

  insert into public.settings (user_id)
  values (new.id);

  return new;
end;
$$;
