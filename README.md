# FigJam → PRD (SaaS)

Plataforma SaaS multi-time que transforma um board FigJam (Discovery) — opcionalmente combinado com um protótipo Figma — em um PRD confiável. A IA critica o material, encontra gaps (inclusive comparando Discovery × Protótipo) e gera um PRD que admite honestamente o que ainda não foi definido.

## Principais características

- Autenticação por email/senha com **Supabase Auth**. Não há cadastro público: contas são criadas por administradores.
- **Multi-time**: cada usuário pertence a um time e vê apenas os projetos do seu time. Papéis: `super_admin`, `team_admin`, `member`.
- **Painel de admin** no app para criar times e usuários.
- Extração de **Discovery (FigJam)** e **Protótipo (Figma Design)** usando uma **única chave da API Figma** no servidor — nenhum usuário informa credenciais.
- Análise da IA (Claude) com **chave única no servidor**, comparando Discovery e Protótipo.
- Persistência completa no **Supabase** (projetos, fontes extraídas, análises, gaps, PRDs).
- Análise pesada processada **em passos** (chunks), robusta ao limite de 60s da Vercel Hobby.
- A análise roda **no backend** (Supabase Edge Function + pg_cron): continua processando mesmo que o usuário feche a aba do navegador.

## Pré-requisitos

- Node.js 18+
- Projeto Supabase (já provisionado: `Extrak`)
- Personal Access Token do Figma com escopo `file_content:read`
- Chave da API Anthropic (Claude)

## Configuração

### 1. Variáveis de ambiente do servidor (`.env`)

```env
FIGMA_TOKEN=seu_token_figma
ANTHROPIC_API_KEY=sua_chave_anthropic
ANTHROPIC_MODEL=claude-sonnet-4-5-20250929

SUPABASE_URL=https://SEU_PROJETO.supabase.co
SUPABASE_SERVICE_ROLE_KEY=sua_service_role_key   # SECRETA (Supabase Dashboard > Project Settings > API)
ADMIN_BOOTSTRAP_SECRET=um_segredo_forte          # usado uma única vez para criar o 1º super-admin

ANALYSIS_WORKER_SECRET=um_segredo_forte_para_o_worker   # mesmo valor configurado na Edge Function
SUPABASE_FUNCTION_URL=https://SEU_PROJETO.supabase.co/functions/v1/process-analysis-step
```

### 2. Variáveis de ambiente do frontend (`client/.env`)

```env
VITE_SUPABASE_URL=https://SEU_PROJETO.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_xxx   # chave publishable (pública)
```

### 3. Desabilitar o cadastro público no Supabase

No Supabase Dashboard → Authentication → Providers/Settings, **desative o signup público** (os usuários são criados apenas pelo admin).

## Executar (local)

```bash
npm install
cd client && npm install && cd ..
npm run dev
```

- Frontend: http://localhost:5173
- Backend: http://localhost:3001

## Primeiro acesso (bootstrap do super-admin)

Com o servidor rodando e nenhum super-admin existente, crie o primeiro administrador (uma única vez):

```bash
curl -X POST http://localhost:3001/api/admin/bootstrap \
  -H "Content-Type: application/json" \
  -d '{"secret":"SEU_ADMIN_BOOTSTRAP_SECRET","email":"voce@empresa.com","password":"senhaForte123","full_name":"Seu Nome"}'
```

Depois faça login no app e use o painel **Admin** para criar times e demais usuários.

## Fluxo de uso

1. Login com email/senha.
2. **Admin** cria times e usuários (cada usuário associado a um time).
3. Em **Projetos**, crie um projeto informando a URL do Discovery (FigJam) e, opcionalmente, a do Protótipo (Figma).
4. Na página do projeto:
   - **Discovery / Protótipo**: conteúdo estruturado extraído.
   - **Análise (IA)**: roda a crítica em passos (barra de progresso), lista os gaps por severidade; responda os gaps e clique em **Reprocessar**.
   - **PRD**: liberado quando não há gaps de severidade alta em aberto; copie ou baixe o `.md`.

## Deploy na Vercel

O frontend (`client/`) é publicado como site estático e o backend Express roda como serverless function (`api/`). O `vercel.json` já cuida do install, build, roteamento de `/api/*` e fallback de SPA.

Configure no painel da Vercel (Settings → Environment Variables) **todas** as variáveis do servidor e do frontend listadas acima:

- `FIGMA_TOKEN`, `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `ADMIN_BOOTSTRAP_SECRET`
- `ANALYSIS_WORKER_SECRET`, `SUPABASE_FUNCTION_URL` (URL da Edge Function: `https://SEU_PROJETO.supabase.co/functions/v1/process-analysis-step`)
- `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`

> Limite de tempo: no plano Hobby cada função serverless tem teto de 60s. A análise roda em passos para caber nesse limite; boards muito grandes podem exigir o plano Pro (até 300s).

## Worker de análise no backend

A análise da IA é orquestrada **no backend**, então continua mesmo que o usuário feche a aba do navegador.

Como funciona:

1. `POST /api/projects/:id/analyze` cria a rodada e o job, e dispara a Edge Function `process-analysis-step` no Supabase.
2. A Edge Function chama a rota interna `POST /api/internal/analysis/step` (autenticada pelo segredo `ANALYSIS_WORKER_SECRET`), que processa **um bloco** por vez e grava os gaps.
3. Enquanto o job estiver `running`, a Edge Function se reinvoca, avançando bloco a bloco.
4. O **pg_cron** roda a cada 5 minutos e recupera jobs que ficaram travados (chain interrompida, falha de rede), reprocessando a partir de onde pararam.
5. O frontend apenas **acompanha o progresso** por polling — não dirige mais o processamento.

Proteção contra processamento duplicado: cada passo é reivindicado via _compare-and-set_ em `analysis_jobs.processed_chunks` + `step_started_at` (janela de 90s).

### Configuração (uma vez)

1. Faça o deploy da Edge Function (já versionada em `supabase/functions/process-analysis-step/`):

```bash
supabase functions deploy process-analysis-step
```

2. Defina os secrets da Edge Function (Supabase Dashboard → Edge Functions → Secrets, ou via CLI). `SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY` já existem no runtime:

```bash
supabase secrets set ANALYSIS_WORKER_SECRET=<mesmo_valor_da_vercel>
supabase secrets set VERCEL_APP_URL=https://extrak-three.vercel.app
```

3. Para o pg_cron conseguir chamar a Edge Function, guarde a `service_role` key no Vault com o nome `edge_service_role_key` (SQL Editor do Supabase):

```sql
select vault.create_secret('SUA_SERVICE_ROLE_KEY', 'edge_service_role_key');
```

O agendamento `recover-analysis-jobs` (a cada 5 min) e a coluna `analysis_jobs.step_started_at` já são criados por migrations.

## Arquitetura

- **Banco/Auth:** Supabase. Tabelas em `public` (`teams`, `profiles`, `projects`, `project_sources`, `analyses`, `gaps`, `prds`, `analysis_jobs`) com RLS por time e helpers `SECURITY DEFINER` em schema privado.
- **Servidor (`server/`):** Express. Middleware valida o JWT do Supabase e carrega o perfil. Rotas:
  - `/api/admin/*` — bootstrap, times e usuários (Admin API + service_role).
  - `/api/projects` — CRUD de projetos por time, com extração do Figma.
  - `/api/projects/:id/analyze` + `/analyze/step` — análise em passos.
  - `/api/internal/analysis/step` — passo da análise para o worker (auth por `ANALYSIS_WORKER_SECRET`, sem JWT).
  - `/api/projects/:id/gaps` (PATCH) e `/api/projects/:id/prd` (POST).
- **Worker da análise:** `server/analysis-runner.ts` processa um bloco; `server/analysis-worker-client.ts` dispara a Edge Function `supabase/functions/process-analysis-step/` (com fallback local). pg_cron recupera jobs travados.
- **Extração:** `server/parse-figjam.ts` (Discovery) e `server/parse-figma-design.ts` (telas/textos/fluxos do protótipo).
- **IDs estáveis:** `server/gaps.ts` calcula `gap_hash = sha1(chave)`, mantendo o gap entre reprocessamentos.
- **Prompts:** `server/prompts.ts` concentra as etapas de crítica (com comparação Discovery × Protótipo) e de PRD.
- **Frontend (`client/`):** React + react-router; páginas de login, dashboard, projeto e admin; sessão via `@supabase/supabase-js`.
