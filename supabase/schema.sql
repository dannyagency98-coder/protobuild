-- Run in the Supabase SQL editor. Disable public signups in Auth settings.

create table if not exists jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users not null,
  source_url text,
  mode text not null check (mode in ('clone','images','upload')),
  options jsonb default '{}',
  status text not null default 'queued'
    check (status in ('queued','running','done','failed','blocked')),
  error text,
  stats jsonb default '{}',
  share_token text unique,
  share_expires_at timestamptz,
  rights_confirmed boolean not null default false,
  created_at timestamptz default now(),
  finished_at timestamptz
);

create table if not exists usage_daily (
  user_id uuid references auth.users,
  day date,
  runs int default 0,
  ai_calls int default 0,
  primary key (user_id, day)
);

alter table jobs enable row level security;
alter table usage_daily enable row level security;

drop policy if exists jobs_select_own on jobs;
create policy jobs_select_own on jobs
  for select using (auth.uid() = user_id);

drop policy if exists jobs_insert_own on jobs;
create policy jobs_insert_own on jobs
  for insert with check (auth.uid() = user_id);

-- Updates (status, share, stats) go through the service role only.
-- usage_daily is service-role only (no user policies).
