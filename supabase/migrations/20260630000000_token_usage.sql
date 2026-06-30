-- Rastreamento de consumo de tokens/créditos da IA por projeto e feature.

create table if not exists public.token_usage (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects(id) on delete cascade,
  feature text not null,
  model text not null,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  cache_creation_input_tokens integer not null default 0,
  cache_read_input_tokens integer not null default 0,
  cost_usd numeric(12,6) not null default 0,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists token_usage_project_idx on public.token_usage (project_id);
create index if not exists token_usage_created_at_idx on public.token_usage (created_at);

alter table public.token_usage enable row level security;

-- Leitura escopada por projeto (mesma regra das demais tabelas). As inserções
-- são feitas pelo backend via service_role (ignora RLS).
create policy token_usage_access on public.token_usage
  for select
  using (private.can_access_project(project_id));
