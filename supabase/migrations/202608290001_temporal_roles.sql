alter table public.tasks
  add column if not exists due_at timestamptz,
  add column if not exists due_window jsonb,
  add column if not exists scheduling_constraints jsonb,
  add column if not exists effort_estimate_source text,
  add column if not exists effort_estimate_rationale text,
  add column if not exists source_span jsonb,
  add column if not exists field_provenance jsonb,
  add column if not exists dependencies jsonb;

alter table public.tasks
  drop constraint if exists tasks_effort_estimate_source_check;

alter table public.tasks
  add constraint tasks_effort_estimate_source_check
  check (
    effort_estimate_source is null or
    effort_estimate_source in ('stated', 'ai', 'heuristic')
  );

comment on column public.tasks.due_window is
  'A named or approximate deadline period. The scheduler uses its start as the conservative completion cutoff.';

comment on column public.tasks.scheduling_constraints is
  'Task-specific hard windows and soft clock/date preferences preserved from the source.';
