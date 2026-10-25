-- Memory locker: things the user told the duck to remember ("hey duck, remember ...").
-- Run once in the Supabase SQL editor. (schema.sql already includes this for fresh projects.)
-- The relay writes rows with the secret key; the dashboard reads/deletes its own rows through RLS.
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
