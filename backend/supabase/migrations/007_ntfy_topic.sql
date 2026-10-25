-- Per-user ntfy topic for sentry phone pushes. Run once in the Supabase SQL editor.
-- (schema.sql already includes this for fresh projects.)
-- ntfy has no recipients, only topics: whoever subscribes to a topic in the ntfy app gets its pushes.
-- So each user gets their own unguessable topic (made by the dashboard, Camera -> Sentry -> Phone alerts),
-- and the relay pushes to the topic of whoever has the duck. Readable only by its owner (RLS on profiles).
alter table public.profiles add column if not exists ntfy_topic text unique
  check (ntfy_topic is null or ntfy_topic ~ '^[A-Za-z0-9_-]{12,64}$');
