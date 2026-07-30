create extension if not exists pgcrypto;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 120),
  time_zone text not null default 'UTC' check (char_length(time_zone) between 1 and 100),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table public.user_preferences (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  waking_time time not null default '07:00',
  sleeping_time time not null default '23:00',
  preferred_focus_minutes integer not null default 45 check (preferred_focus_minutes between 15 and 240),
  maximum_focus_minutes integer not null default 90 check (maximum_focus_minutes between 15 and 360),
  preferred_break_minutes integer not null default 10 check (preferred_break_minutes between 0 and 120),
  planning_mode text not null default 'balanced' check (planning_mode in ('conservative', 'balanced', 'aggressive')),
  weekends_allowed boolean not null default true,
  reminder_minutes integer not null default 10 check (reminder_minutes between 0 and 40320),
  preferred_focus_windows jsonb not null default '[]'::jsonb,
  preferred_routine_windows jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  check (maximum_focus_minutes >= preferred_focus_minutes)
);

create table public.task_sources (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  source_type text not null check (source_type in ('pasted_text', 'txt')),
  original_filename text,
  content text not null,
  content_sha256 text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  source_id uuid references public.task_sources(id) on delete set null,
  title text not null check (char_length(title) between 1 and 180),
  description text,
  task_type text not null check (task_type in ('flexible', 'fixed_time', 'recurring_goal')),
  due_date date,
  due_time time,
  fixed_start_at timestamptz,
  fixed_end_at timestamptz,
  estimated_minutes integer check (estimated_minutes between 1 and 1440),
  priority text not null check (priority in ('low', 'medium', 'high', 'urgent')),
  category text not null check (category in ('school', 'work', 'health', 'fitness', 'errand', 'personal', 'other')),
  energy_demand text not null check (energy_demand in ('low', 'medium', 'high')),
  splittable boolean not null default false,
  minimum_session_minutes integer check (minimum_session_minutes between 1 and 360),
  recurrence jsonb,
  confidence numeric(4,3) not null check (confidence between 0 and 1),
  field_confidence jsonb not null default '{}'::jsonb,
  missing_information jsonb not null default '[]'::jsonb,
  source_excerpt text not null,
  review_required boolean not null default true,
  approved_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  check (due_time is null or due_date is not null),
  check (fixed_end_at is null or fixed_start_at is not null),
  check (fixed_end_at is null or fixed_end_at > fixed_start_at)
);

create table public.task_history (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  entity_type text not null check (entity_type in ('task', 'session', 'calendar')),
  entity_id uuid not null,
  action text not null,
  message text not null,
  before_data jsonb,
  after_data jsonb,
  created_at timestamptz not null default timezone('utc', now())
);

create table public.availability_rules (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  rule_type text not null check (rule_type in ('available', 'blocked')),
  day_of_week smallint not null check (day_of_week between 0 and 6),
  start_time time not null,
  end_time time not null,
  label text,
  effective_from date,
  effective_until date,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  check (end_time > start_time),
  check (effective_until is null or effective_from is null or effective_until >= effective_from)
);

create table public.calendar_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null check (provider in ('google')),
  provider_account_id text not null,
  calendar_id text not null default 'primary',
  access_token_ciphertext text,
  refresh_token_ciphertext text,
  token_expires_at timestamptz,
  granted_scopes text[] not null default '{}',
  connected_at timestamptz not null default timezone('utc', now()),
  disconnected_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (user_id, provider, provider_account_id)
);

create table public.external_calendar_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  connection_id uuid not null references public.calendar_connections(id) on delete cascade,
  provider_event_id text not null,
  title text not null default 'Busy',
  start_at timestamptz not null,
  end_at timestamptz not null,
  is_planpilot_event boolean not null default false,
  last_synced_at timestamptz not null default timezone('utc', now()),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (connection_id, provider_event_id),
  check (end_at > start_at)
);

create table public.schedule_versions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  parent_version_id uuid references public.schedule_versions(id) on delete set null,
  status text not null check (status in ('proposed', 'approved', 'superseded', 'rejected')),
  proposal jsonb not null,
  plan_health jsonb not null,
  change_summary text,
  approved_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table public.planned_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  task_id uuid not null references public.tasks(id) on delete cascade,
  schedule_version_id uuid not null references public.schedule_versions(id) on delete cascade,
  external_calendar_event_id uuid references public.external_calendar_events(id) on delete set null,
  title text not null,
  start_at timestamptz not null,
  end_at timestamptz not null,
  planned_minutes integer not null check (planned_minutes > 0),
  completed_minutes integer check (completed_minutes between 0 and planned_minutes),
  status text not null check (status in ('proposed', 'approved', 'completed', 'partial', 'missed', 'unnecessary', 'rejected')),
  locked boolean not null default false,
  reason_codes text[] not null default '{}',
  explanation text not null,
  approved_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  check (end_at > start_at)
);

create index profiles_time_zone_idx on public.profiles(time_zone);
create index task_sources_user_created_idx on public.task_sources(user_id, created_at desc);
create index tasks_user_due_idx on public.tasks(user_id, due_date) where completed_at is null;
create index tasks_user_review_idx on public.tasks(user_id, review_required) where approved_at is null;
create index task_history_user_created_idx on public.task_history(user_id, created_at desc);
create index availability_rules_user_day_idx on public.availability_rules(user_id, day_of_week);
create index calendar_connections_user_idx on public.calendar_connections(user_id);
create index external_events_user_range_idx on public.external_calendar_events(user_id, start_at, end_at);
create index schedule_versions_user_created_idx on public.schedule_versions(user_id, created_at desc);
create index planned_sessions_user_start_idx on public.planned_sessions(user_id, start_at);
create index planned_sessions_task_idx on public.planned_sessions(task_id);

create trigger profiles_set_updated_at before update on public.profiles
for each row execute function public.set_updated_at();
create trigger preferences_set_updated_at before update on public.user_preferences
for each row execute function public.set_updated_at();
create trigger task_sources_set_updated_at before update on public.task_sources
for each row execute function public.set_updated_at();
create trigger tasks_set_updated_at before update on public.tasks
for each row execute function public.set_updated_at();
create trigger availability_set_updated_at before update on public.availability_rules
for each row execute function public.set_updated_at();
create trigger connections_set_updated_at before update on public.calendar_connections
for each row execute function public.set_updated_at();
create trigger external_events_set_updated_at before update on public.external_calendar_events
for each row execute function public.set_updated_at();
create trigger schedule_versions_set_updated_at before update on public.schedule_versions
for each row execute function public.set_updated_at();
create trigger sessions_set_updated_at before update on public.planned_sessions
for each row execute function public.set_updated_at();

alter table public.profiles enable row level security;
alter table public.user_preferences enable row level security;
alter table public.task_sources enable row level security;
alter table public.tasks enable row level security;
alter table public.task_history enable row level security;
alter table public.availability_rules enable row level security;
alter table public.calendar_connections enable row level security;
alter table public.external_calendar_events enable row level security;
alter table public.schedule_versions enable row level security;
alter table public.planned_sessions enable row level security;

create policy "profiles_select_own" on public.profiles for select
using ((select auth.uid()) = id);
create policy "profiles_insert_own" on public.profiles for insert
with check ((select auth.uid()) = id);
create policy "profiles_update_own" on public.profiles for update
using ((select auth.uid()) = id) with check ((select auth.uid()) = id);
create policy "profiles_delete_own" on public.profiles for delete
using ((select auth.uid()) = id);

create policy "preferences_all_own" on public.user_preferences for all
using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "sources_all_own" on public.task_sources for all
using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "tasks_all_own" on public.tasks for all
using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

create policy "history_select_own" on public.task_history for select
using ((select auth.uid()) = user_id);
create policy "history_insert_own" on public.task_history for insert
with check ((select auth.uid()) = user_id);

create policy "availability_all_own" on public.availability_rules for all
using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "connections_all_own" on public.calendar_connections for all
using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "external_events_all_own" on public.external_calendar_events for all
using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "schedule_versions_all_own" on public.schedule_versions for all
using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "sessions_all_own" on public.planned_sessions for all
using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

revoke update, delete on public.task_history from authenticated;

