-- Voice reminders: "hey duck, remind me in 5 days to email my TA". Run once in the Supabase SQL editor.
-- (schema.sql already includes this for fresh projects.)
-- The relay inserts rows (secret key) and marks them delivered once the duck has said them.
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
