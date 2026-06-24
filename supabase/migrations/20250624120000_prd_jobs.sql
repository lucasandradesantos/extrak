-- Jobs de geração de PRD (orquestrados no backend, como analysis_jobs).

create table if not exists public.prd_jobs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  status public.job_status not null default 'running',
  total_steps integer not null default 0,
  processed_steps integer not null default 0,
  current_step_label text,
  step_started_at timestamptz,
  error text,
  payload jsonb default '{}'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists prd_jobs_project_id_idx on public.prd_jobs (project_id);
create index if not exists prd_jobs_running_idx on public.prd_jobs (project_id, status)
  where status = 'running';

alter table public.prd_jobs enable row level security;

create policy prd_jobs_access on public.prd_jobs
  for all
  using (private.can_access_project(project_id))
  with check (private.can_access_project(project_id));
