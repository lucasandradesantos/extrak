-- Jobs de geração do Escopo (calculadora de horas), orquestrados no backend
-- igual a prd_jobs / analysis_jobs.

create table if not exists public.scope_jobs (
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

create index if not exists scope_jobs_project_id_idx on public.scope_jobs (project_id);
create index if not exists scope_jobs_running_idx on public.scope_jobs (project_id, status)
  where status = 'running';

alter table public.scope_jobs enable row level security;

create policy scope_jobs_access on public.scope_jobs
  for all
  using (private.can_access_project(project_id))
  with check (private.can_access_project(project_id));

-- Configuração global de cálculo (hourly rate, multiplicadores, buffers, faixas
-- de complexidade, fases). Armazenada em app_settings como JSON; defaults do PRD §4.3.
insert into public.app_settings (key, value)
values (
  'scope_config',
  '{"hourly_rate":150,"platform_multipliers":{"web":1.0,"mobile_native":1.4,"mobile_responsive":1.1},"buffers":{"qa":0.15,"product":0.10},"complexity_ranges":{"simples":4,"media":10,"dificil":26},"phases":["MVP","V2","V3"]}'
)
on conflict (key) do nothing;
