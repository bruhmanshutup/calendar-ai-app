alter table public.tasks
  add column if not exists responsibility_kind text,
  add column if not exists deadline_strength text,
  add column if not exists occurrence_window jsonb,
  add column if not exists duration_range jsonb,
  add column if not exists conditional_rules jsonb;

alter table public.tasks
  drop constraint if exists tasks_responsibility_kind_check;

alter table public.tasks
  add constraint tasks_responsibility_kind_check
  check (
    responsibility_kind is null or
    responsibility_kind in ('task', 'event', 'reminder', 'milestone')
  );

alter table public.tasks
  drop constraint if exists tasks_deadline_strength_check;

alter table public.tasks
  add constraint tasks_deadline_strength_check
  check (
    deadline_strength is null or
    deadline_strength in ('hard', 'soft')
  );

comment on column public.tasks.occurrence_window is
  'The dated period in which an event or responsibility occurs; distinct from its deadline.';

comment on column public.tasks.duration_range is
  'Explicit or inferred minimum, preferred, and maximum duration bounds.';

comment on column public.tasks.conditional_rules is
  'Conditional scheduling instructions preserved from the source.';
